import { inspectOwnHost } from '../analysis/forensics.js';
import { FILE_AI_SCORE, HOST_AI_SCORE, fileEvidence } from '../analysis/ensemble.js';
import { MESSAGE } from '../shared/constants.js';

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';
const CACHE_LIMIT = 400;
const resultCache = new Map();
const inFlight = new Map();
let creatingOffscreen;
let analyzing = 0;
let engineHost = null;
const aliveWaiters = [];

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
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === MESSAGE.ENGINE_ALIVE) {
    engineHost = {
      kind: sender.documentUrl?.includes('offscreen') || !sender.tab ? 'offscreen' : 'document',
      tabId: sender.tab?.id ?? null,
      gpu: Boolean(message.gpu),
      ready: true
    };
    while (aliveWaiters.length) aliveWaiters.pop()();
    sendResponse({ ok: true });
    return;
  }
  if (message.type === MESSAGE.ANALYZE_IMAGE) {
    handleAnalyze(message.payload, sender).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
    return true;
  }
  if (message.type === MESSAGE.WARM_MODEL || message.type === MESSAGE.MODEL_STATUS) {
    forwardToEngine(message).then(sendResponse).catch((error) => {
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
  const cacheKey = `${payload.displaySrc || payload.source}|${payload.source}|${payload.naturalWidth}x${payload.naturalHeight}`;
  if (resultCache.has(cacheKey)) {
    return { ...resultCache.get(cacheKey), requestId: payload.requestId, cached: true };
  }
  if (inFlight.has(cacheKey)) {
    const result = await inFlight.get(cacheKey);
    return { ...result, requestId: payload.requestId, cached: Boolean(result?.ok) };
  }

  const host = inspectOwnHost(payload.displaySrc || '');
  const fileHits = fileEvidence(payload.encodedPeek);
  if (host.evidence.length || fileHits.length) {
    const result = {
      ok: true,
      score: fileHits.length ? FILE_AI_SCORE : HOST_AI_SCORE,
      modelScore: null,
      webScore: null,
      fuseSource: fileHits.length ? 'metadata' : 'host',
      viewsUsed: 0,
      skippedModel: true,
      model: fileHits.length ? 'metadata' : 'host',
      backend: fileHits.length ? 'metadata' : 'host',
      precision: null,
      adapter: null,
      format: payload.encodedPeek?.format || '',
      dimensions: {
        width: Number(payload.naturalWidth) || 0,
        height: Number(payload.naturalHeight) || 0
      },
      evidence: fileHits.length ? fileHits : host.evidence,
      watermarks: payload.encodedPeek?.watermarks || [],
      provenance: payload.encodedPeek?.provenance || [],
      elapsedMs: 0
    };
    resultCache.set(cacheKey, result);
    if (resultCache.size > CACHE_LIMIT) resultCache.delete(resultCache.keys().next().value);
    return { ...result, requestId: payload.requestId };
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
    const result = await forwardToEngine({
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

async function forwardToEngine(message) {
  await ensureEngine();
  try {
    return await chrome.runtime.sendMessage(message);
  } catch {
    engineHost = null;
    await closeOffscreen();
    await ensureEngine();
    return chrome.runtime.sendMessage(message);
  }
}

async function ensureEngine() {
  if (engineHost?.ready && engineHost.kind === 'offscreen' && await offscreenExists()) return;
  await ensureOffscreenDocument();
  if (!engineHost?.ready) await waitAlive(20000);
}

async function offscreenExists() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenUrl]
  });
  return contexts.length > 0;
}

function waitAlive(timeoutMs) {
  if (engineHost?.ready && engineHost.kind === 'offscreen') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The local engine did not start.')), timeoutMs);
    aliveWaiters.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function ensureOffscreenDocument() {
  if (await offscreenExists()) return;
  if (!creatingOffscreen) {
    engineHost = { kind: 'offscreen', tabId: null, ready: false };
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

async function closeOffscreen() {
  try {
    if (await offscreenExists()) await chrome.offscreen.closeDocument();
  } catch {
  }
}

function warmSoon() {
  setTimeout(() => {
    forwardToEngine({ type: MESSAGE.WARM_MODEL }).catch(() => {});
  }, 400);
}

function updateBadge(tabId) {
  if (!tabId) return;
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#125e4d' });
  chrome.action.setBadgeTextColor?.({ tabId, color: '#fffcf6' });
  chrome.action.setBadgeText({ tabId, text: analyzing > 0 ? '…' : '' });
}
