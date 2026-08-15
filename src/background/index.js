import { MESSAGE } from '../shared/constants.js';

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';
const CACHE_LIMIT = 280;
const resultCache = new Map();
const inFlight = new Map();
let creatingOffscreen;
let analyzing = 0;

chrome.runtime.onInstalled.addListener(({ reason }) => {
  ensureContextMenu();
  warmSoon();
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(() => {
  ensureContextMenu();
  warmSoon();
});

ensureContextMenu();

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'veil-analyze' || !tab?.id || !info.srcUrl) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: MESSAGE.ANALYZE_URL, url: info.srcUrl });
  } catch {
    // page has no content script (chrome://, Web Store, etc.)
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === MESSAGE.ANALYZE_IMAGE) {
    handleAnalyze(message.payload, sender).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
    return true;
  }
  if (message.type === MESSAGE.WARM_MODEL || message.type === MESSAGE.MODEL_STATUS) {
    forwardToOffscreen(message).then(sendResponse).catch((error) => {
      sendResponse({
        ok: false,
        state: 'error',
        error: error instanceof Error ? error.message : String(error)
      });
    });
    return true;
  }
});

function ensureContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'veil-analyze',
      title: 'Analyze image with Veil',
      contexts: ['image']
    });
  });
}

async function handleAnalyze(payload, sender) {
  const cacheKey = `${payload.source}|${payload.naturalWidth}x${payload.naturalHeight}`;
  if (resultCache.has(cacheKey)) {
    return { ...resultCache.get(cacheKey), requestId: payload.requestId, cached: true };
  }
  if (inFlight.has(cacheKey)) {
    const result = await inFlight.get(cacheKey);
    return { ...result, requestId: payload.requestId, cached: Boolean(result?.ok) };
  }

  const work = runAnalyze(payload, sender, cacheKey);
  inFlight.set(cacheKey, work);
  try {
    return await work;
  } finally {
    inFlight.delete(cacheKey);
  }
}

async function runAnalyze(payload, sender, cacheKey) {
  analyzing += 1;
  try {
    const result = await forwardToOffscreen({
      type: MESSAGE.OFFSCREEN_ANALYZE,
      payload
    });
    if (result?.ok) {
      const stored = { ...result, requestId: undefined };
      resultCache.set(cacheKey, stored);
      if (resultCache.size > CACHE_LIMIT) {
        resultCache.delete(resultCache.keys().next().value);
      }
      updateBadge(sender.tab?.id);
    }
    return result;
  } finally {
    analyzing -= 1;
  }
}

async function forwardToOffscreen(message) {
  await ensureOffscreenDocument();
  return chrome.runtime.sendMessage(message);
}

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenUrl]
  });
  if (contexts.length) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['WORKERS'],
      justification: 'Run the bundled ONNX classifier entirely inside Chrome with WebGPU or WebAssembly.'
    }).finally(() => {
      creatingOffscreen = undefined;
    });
  }
  await creatingOffscreen;
}

function warmSoon() {
  setTimeout(() => {
    forwardToOffscreen({ type: MESSAGE.WARM_MODEL }).catch(() => {});
  }, 400);
}

function updateBadge(tabId) {
  if (!tabId) return;
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#f0b429' });
  chrome.action.setBadgeTextColor?.({ tabId, color: '#14120b' });
  chrome.action.setBadgeText({ tabId, text: analyzing > 0 ? '…' : '' });
}
