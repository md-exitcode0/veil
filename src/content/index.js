import { firstHttpImageUrl, inspectEncodedImage, inspectSourceUrl, largestSrcFromSrcset } from '../analysis/forensics.js';
import { drawOfficialCrop, officialCropRect } from '../analysis/preprocess.js';
import { MODEL } from '../shared/constants.js';

const MESSAGE = {
  ANALYZE_IMAGE: 'veil/analyze-image',
  WARM_MODEL: 'veil/warm-model',
  GET_PAGE_STATE: 'veil/get-page-state',
  RESCAN_PAGE: 'veil/rescan-page',
  ANALYZE_URL: 'veil/analyze-url',
  HOST_ENGINE: 'veil/host-engine'
};

function sanitizeSettings(value = {}) {
  const number = (raw, min, max, fallback) => {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
  };
  return {
    enabled: value.enabled !== false,
    threshold: number(value.threshold, 0.5, 0.95, 0.65),
    minimumDimension: number(value.minimumDimension, 48, 512, 160),
    maxImagesPerPage: Math.round(number(value.maxImagesPerPage, 20, 2000, 400)),
    showRealScores: value.showRealScores !== false,
    aiImageAction: ['blur', 'hide', 'label'].includes(value.aiImageAction) ? value.aiImageAction : 'blur',
    dualView: value.dualView !== false
  };
}

async function getSettings() {
  const stored = await chrome.storage.local.get('settings');
  const value = sanitizeSettings(stored.settings);
  if (stored.settings && Number(stored.settings.maxImagesPerPage) <= 80) {
    value.maxImagesPerPage = 400;
    await chrome.storage.local.set({ settings: value });
  }
  return value;
}

const pageState = {
  status: 'idle',
  scanned: 0,
  aiCount: 0,
  realCount: 0,
  errors: 0,
  results: []
};

const records = new Map();
const observed = new WeakSet();
const sourceCache = new WeakMap();
const watchedShadows = new WeakSet();
const bgUrlCache = new WeakMap();
let settings = sanitizeSettings();
let requestSequence = 0;
let updateFrame;
let inFlight = 0;
let lastDiscoverAt = 0;
const MAX_IN_FLIGHT = 4;
const pending = [];
const peekReady = new Map();
const peekInflight = new Map();
const BG_CANDIDATE = [
  '[style*="url"]',
  '[style*="image-set"]',
  '[style*="background"]',
  '[class*="bg-cover"]',
  '[class*="bg-center"]',
  '[class*="background"]',
  '[class*="thumb"]',
  '[class*="Thumb"]',
  '[class*="image"]',
  '[class*="Image"]',
  '[class*="media"]',
  '[class*="Media"]',
  '[class*="cover"]',
  '[class*="photo"]',
  '[class*="artwork"]',
  '[class*="tile"]',
  '[data-bg]',
  '[data-background]',
  '[data-background-image]'
].join(',');
const INPUT = MODEL.inputSize;
const captureCanvas = typeof OffscreenCanvas === 'function'
  ? new OffscreenCanvas(INPUT, INPUT)
  : Object.assign(document.createElement('canvas'), { width: INPUT, height: INPUT });
const captureCtx = (() => {
  try {
    return captureCanvas.getContext('2d', { willReadFrequently: true, alpha: false, colorSpace: 'srgb' });
  } catch {
    return captureCanvas.getContext('2d', { willReadFrequently: true, alpha: false });
  }
})();
if (captureCtx) {
  captureCtx.imageSmoothingEnabled = true;
  captureCtx.imageSmoothingQuality = 'high';
}
let captureLock = Promise.resolve();

function withCapture(work) {
  const previous = captureLock;
  let release;
  captureLock = new Promise((resolve) => { release = resolve; });
  return previous.then(work).finally(() => release());
}

injectPageStyles();
if (window === window.top) {
  chrome.runtime.sendMessage({ type: MESSAGE.WARM_MODEL }).catch(() => {});
}

const overlayLayer = document.createElement('div');
overlayLayer.id = 'veil-overlay-layer';
overlayLayer.setAttribute('aria-live', 'polite');
document.documentElement.append(overlayLayer);

const detailPanel = createDetailPanel();
overlayLayer.append(detailPanel);

const intersectionObserver = new IntersectionObserver(handleIntersections, {
  rootMargin: '240px 0px',
  threshold: 0.01
});

getSettings().then((value) => {
  settings = value;
  scanVisible();
});
scanVisible();
setInterval(scanVisible, 900);
const mutationObserver = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node instanceof Element) discoverImages(node);
    }
    if (mutation.type === 'attributes' && mutation.target instanceof Element) {
      bgUrlCache.delete(mutation.target);
      sourceCache.delete(mutation.target);
      if (records.has(mutation.target)) resetImage(mutation.target);
    }
  }
});
const MUTATION_OPTIONS = {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['src', 'srcset', 'style', 'class', 'poster', 'href', 'data-src', 'data-srcset', 'data-original', 'data-bg']
};
mutationObserver.observe(document.documentElement, MUTATION_OPTIONS);

let lastScrollAt = 0;
let scrollLoop = false;
const onScreen = new Set();
document.addEventListener('scroll', onAnyScroll, { capture: true, passive: true });
window.addEventListener('scroll', onAnyScroll, { capture: true, passive: true });
window.addEventListener('resize', () => {
  for (const record of records.values()) {
    if (record.cover) syncCoverToMedia(record);
  }
  schedulePositions();
}, { passive: true });
document.addEventListener('visibilitychange', schedulePositions);

function onAnyScroll() {
  lastScrollAt = performance.now();
  if (!detailPanel.hidden) schedulePositions();
  if (scrollLoop) return;
  scrollLoop = true;
  setTimeout(() => {
    scrollLoop = false;
    if (performance.now() - lastScrollAt >= 150) scanVisible();
  }, 180);
}

function scanVisible() {
  if (!settings.enabled) return;
  const now = performance.now();
  if (now - lastDiscoverAt > 400) {
    discoverImages(document);
    lastDiscoverAt = now;
  }
  for (const image of collectImages(document, { shadows: false })) {
    const record = records.get(image);
    const src = mediaSource(image);
    if (record && src && record.source && src !== record.source) resetImage(image);
    if (isAnalyzable(image)) enqueue(image);
  }
  if (inFlight === 0 && pending.length) pump();
}

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  settings = await getSettings();
  if (!settings.enabled) hideAllOverlays();
  else {
    renderAllResults();
    discoverImages(document);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === MESSAGE.HOST_ENGINE) {
    sendResponse(injectEngineFrame());
    return;
  }
  if (message.type === MESSAGE.GET_PAGE_STATE) {
    sendResponse({ ...pageState, results: pageState.results.slice(-12) });
  }
  if (message.type === MESSAGE.RESCAN_PAGE) {
    rescanPage();
    sendResponse({ ok: true });
  }
  if (message.type === MESSAGE.ANALYZE_URL) {
    const match = [...document.images].find((image) => image.currentSrc === message.url || image.src === message.url);
    if (match) {
      resetImage(match);
      analyze(match);
    }
    sendResponse({ ok: true });
  }
});

function collectImages(root, options = {}, bucket = []) {
  if (!root) return bucket;
  const shadows = options.shadows !== false;
  if (isDrawable(root)) {
    bucket.push(root);
    return bucket;
  }
  if (root instanceof Element && cssBackgroundUrl(root) && !root.querySelector?.('img, video, canvas')) {
    bucket.push(root);
  }
  if (root.querySelectorAll) {
    bucket.push(...root.querySelectorAll('img, video, canvas, [poster], [data-src], [data-srcset], [data-original]'));
    for (const element of root.querySelectorAll(BG_CANDIDATE)) {
      if (!isDrawable(element) && !element.querySelector?.('img, video, canvas') && cssBackgroundUrl(element)) {
        bucket.push(element);
      }
    }
    if (shadows) {
      for (const element of root.querySelectorAll('*')) {
        if (element.shadowRoot) {
          watchShadow(element.shadowRoot);
          collectImages(element.shadowRoot, options, bucket);
        }
      }
    }
  }
  if (shadows && root.shadowRoot) {
    watchShadow(root.shadowRoot);
    collectImages(root.shadowRoot, options, bucket);
  }
  return [...new Set(bucket)];
}

function watchShadow(root) {
  if (!root || watchedShadows.has(root)) return;
  watchedShadows.add(root);
  mutationObserver.observe(root, MUTATION_OPTIONS);
}

function isDrawable(node) {
  return node instanceof HTMLImageElement
    || node instanceof HTMLVideoElement
    || node instanceof HTMLCanvasElement;
}

function isMediaElement(node) {
  return isDrawable(node);
}

function resolvePageUrl(value) {
  if (!value) return '';
  try {
    return new URL(value, location.href).href;
  } catch {
    return value;
  }
}

function cssBackgroundUrl(element) {
  if (!(element instanceof Element)) return '';
  const cached = bgUrlCache.get(element);
  if (cached !== undefined) return cached;
  const dataBg = element.getAttribute('data-bg')
    || element.getAttribute('data-background')
    || element.getAttribute('data-background-image');
  const inline = `${element.getAttribute('style') || ''} ${element.style?.backgroundImage || ''} ${dataBg || ''}`;
  let found = firstHttpImageUrl(inline);
  if (!found) {
    const className = typeof element.className === 'string' ? element.className : '';
    if (/bg-|thumb|image|media|cover|photo|artwork|tile|background/i.test(className) || dataBg) {
      found = firstHttpImageUrl(getComputedStyle(element).backgroundImage || '');
    }
  }
  const resolved = found ? resolvePageUrl(found) : '';
  bgUrlCache.set(element, resolved);
  return resolved;
}

function displayedUrl(element) {
  if (element instanceof HTMLImageElement) {
    return resolvePageUrl(
      element.currentSrc
      || largestSrcFromSrcset(element.srcset || element.getAttribute('data-srcset') || '')
      || element.getAttribute('data-src')
      || element.getAttribute('data-original')
      || element.src
      || ''
    );
  }
  if (element instanceof HTMLVideoElement) {
    return resolvePageUrl(element.poster || element.currentSrc || element.src || '');
  }
  return cssBackgroundUrl(element);
}

function locatorHints(element) {
  const bits = [];
  if (element instanceof HTMLImageElement || element instanceof HTMLVideoElement) {
    bits.push(element.currentSrc, element.src, element.srcset, element.getAttribute?.('poster'));
  }
  if (element instanceof Element) {
    for (const name of ['src', 'srcset', 'data-src', 'data-srcset', 'data-original', 'data-iurl', 'data-ou', 'data-lpage', 'poster', 'href']) {
      bits.push(element.getAttribute(name));
    }
    for (const attr of element.attributes || []) {
      if (attr.name.startsWith('data-') && /https?:|imgurl|cdn\.|blob:/i.test(attr.value)) bits.push(attr.value);
    }
  }
  bits.push(cssBackgroundUrl(element));
  let node = element;
  for (let depth = 0; depth < 8 && node; depth += 1) {
    if (node instanceof HTMLAnchorElement) bits.push(node.href);
    bits.push(node.getAttribute?.('href'), node.getAttribute?.('data-lpage'), node.getAttribute?.('data-ou'));
    node = node.parentElement;
  }
  return bits.filter(Boolean).join('\n');
}

function mediaSource(element) {
  const cached = sourceCache.get(element);
  if (cached !== undefined) return cached;
  const inspected = inspectSourceUrl(locatorHints(element));
  let value = '';
  if (inspected.evidence.length) value = inspected.resolved;
  else value = displayedUrl(element);
  sourceCache.set(element, value);
  return value;
}

function discoverImages(root) {
  if (!settings.enabled) return;
  for (const image of collectImages(root, { shadows: true })) {
    if (observed.has(image)) continue;
    observed.add(image);
    intersectionObserver.observe(image);
  }
}

function handleIntersections(entries) {
  const visible = [];
  for (const entry of entries) {
    if (!(entry.target instanceof Element)) continue;
    const record = records.get(entry.target);
    if (!entry.isIntersecting) {
      if (record) {
        onScreen.delete(record);
        hideChrome(record);
      }
      continue;
    }
    if (record) onScreen.add(record);
    visible.push(entry);
  }
  visible.sort((a, b) => Math.abs(a.boundingClientRect.top + a.boundingClientRect.height / 2 - innerHeight / 2)
    - Math.abs(b.boundingClientRect.top + b.boundingClientRect.height / 2 - innerHeight / 2));
  for (const entry of visible) {
    const image = entry.target;
    if (isAnalyzable(image)) enqueue(image);
    else if (records.has(image)) schedulePositions();
  }
}

function isAnalyzable(image) {
  if (!settings.enabled || records.has(image)) return false;
  if (image instanceof HTMLCanvasElement && Math.min(image.width, image.height) < 96) return false;
  const src = mediaSource(image) || displayedUrl(image);
  if (image instanceof HTMLImageElement) {
    if (!image.complete && !(src || image.currentSrc || image.src)) {
      image.addEventListener('load', () => isAnalyzable(image) && enqueue(image), { once: true });
      image.addEventListener('error', () => isAnalyzable(image) && enqueue(image), { once: true });
      return false;
    }
  }
  const rect = image.getBoundingClientRect();
  const width = Math.max(image.naturalWidth || 0, image.videoWidth || 0, image.width || 0, Math.round(rect.width));
  const height = Math.max(image.naturalHeight || 0, image.videoHeight || 0, image.height || 0, Math.round(rect.height));
  if (!src && !(image instanceof HTMLImageElement) && !(image instanceof HTMLCanvasElement)) return false;
  if (Math.min(width, height) < settings.minimumDimension
    && Math.min(rect.width, rect.height) < settings.minimumDimension) {
    return false;
  }
  return rect.width >= 32 && rect.height >= 32;
}

function enqueue(image) {
  if (records.has(image) || pending.includes(image)) return;
  prefetch(upgradeImageUrl(displayedUrl(image) || ''));
  evictIfNeeded();
  pending.push(image);
  pump();
}

function prefetch(url) {
  if (!url || !/^(https?:|data:)/i.test(url) || peekReady.has(url) || peekInflight.has(url)) return;
  const work = peekEncoded(url).then((value) => {
    peekReady.set(url, value);
    peekInflight.delete(url);
    return value;
  }, () => {
    peekReady.set(url, null);
    peekInflight.delete(url);
    return null;
  });
  peekInflight.set(url, work);
}

function evictIfNeeded() {
  const limit = settings.maxImagesPerPage;
  while (records.size + pending.length >= limit) {
    let victim = null;
    for (const [image, record] of records) {
      if (record.status === 'analyzing') continue;
      const rect = image.getBoundingClientRect();
      if (!image.isConnected || rect.bottom < 0 || rect.top > innerHeight) {
        victim = image;
        break;
      }
    }
    if (!victim) {
      for (const [image, record] of records) {
        if (record.status !== 'analyzing') {
          victim = image;
          break;
        }
      }
    }
    if (!victim) break;
    const record = records.get(victim);
    clearRecordTreatment(record);
    onScreen.delete(record);
    detachFlowBadge(record);
    records.delete(victim);
  }
}

function pump() {
  while (inFlight < MAX_IN_FLIGHT && pending.length) {
    const image = pending.shift();
    if (!image.isConnected || records.has(image)) continue;
    analyze(image);
  }
}

async function analyze(image) {
  const id = `veil-${Date.now().toString(36)}-${(++requestSequence).toString(36)}`;
  const record = {
    id,
    image,
    source: mediaSource(image),
    status: 'analyzing',
    result: null,
    badge: createBadge(id)
  };
  records.set(image, record);
  onScreen.add(record);
  attachFlowBadge(record);
  pageState.status = 'scanning';
  schedulePositions();
  inFlight += 1;

  try {
    const displaySrc = displayedUrl(image);
    const fetchUrl = upgradeImageUrl(displaySrc);
    prefetch(fetchUrl);
    const captured = await capturePixels(image);
    let peek;
    if (peekReady.has(fetchUrl)) peek = peekReady.get(fetchUrl);
    else if (peekInflight.has(fetchUrl)) {
      peek = captured
        ? await Promise.race([
          peekInflight.get(fetchUrl),
          new Promise((resolve) => setTimeout(() => resolve(undefined), 12))
        ])
        : await peekInflight.get(fetchUrl);
    } else peek = undefined;
    const pixels = peek?.pixels || captured || null;
    const encodedPeek = peek === undefined ? undefined : (peek?.encoded ?? null);
    const rect = image.getBoundingClientRect();
    const result = await withTimeout(chrome.runtime.sendMessage({
      type: MESSAGE.ANALYZE_IMAGE,
      payload: {
        requestId: id,
        source: upgradeImageUrl(record.source || displaySrc),
        displaySrc: fetchUrl,
        pixelBuffer: pixels?.buffer,
        pixelWidth: pixels?.width,
        pixelHeight: pixels?.height,
        naturalWidth: pixels?.sourceWidth || image.naturalWidth || image.videoWidth || image.width || Math.round(rect.width),
        naturalHeight: pixels?.sourceHeight || image.naturalHeight || image.videoHeight || image.height || Math.round(rect.height),
        dualView: settings.dualView,
        encodedPeek,
        pageUrl: location.href
      }
    }), 20000);
    if (!result?.ok) throw new Error(result?.error || 'The image could not be analyzed.');
    record.status = 'complete';
    record.result = result;
    pageState.scanned += 1;
    if (result.score >= settings.threshold) pageState.aiCount += 1;
    else pageState.realCount += 1;
    pageState.results.push(toPublicResult(record));
    pageState.results = pageState.results.slice(-50);
    renderRecord(record);
  } catch (error) {
    record.status = 'error';
    record.error = error instanceof Error ? error.message : String(error);
    pageState.errors += 1;
    record.badge.className = 'veil-badge veil-badge--error';
    record.badge.innerHTML = '<span class="veil-badge__mark">!</span><span>Unreadable</span>';
    record.badge.title = record.error;
    record.badge.setAttribute('aria-label', `Veil could not read this image: ${record.error}`);
    schedulePositions();
    setTimeout(() => {
      if (records.get(image) === record && record.status === 'error') {
        detachFlowBadge(record);
        onScreen.delete(record);
        records.delete(image);
      }
    }, 2500);
  } finally {
    inFlight -= 1;
    pageState.status = [...records.values()].some((item) => item.status === 'analyzing') || pending.length
      ? 'scanning'
      : 'ready';
    pump();
  }
}

function createBadge(id) {
  const badge = document.createElement('button');
  badge.className = 'veil-badge veil-badge--loading';
  badge.type = 'button';
  badge.dataset.veilId = id;
  badge.setAttribute('aria-label', 'Veil is analyzing this image');
  badge.innerHTML = '<span class="veil-badge__pulse"></span><span>Checking</span>';
  badge.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const record = [...records.values()].find((candidate) => candidate.id === id);
    if (record?.result) showDetails(record);
  });
  badge.addEventListener('mousedown', (event) => event.stopPropagation());
  return badge;
}

function renderRecord(record) {
  const score = record.result.score;
  const isAi = score >= settings.threshold;
  record.badge.hidden = !isAi && !settings.showRealScores;
  record.badge.className = `veil-badge veil-badge--${isAi ? 'ai' : 'real'}`;
  record.badge.innerHTML = `
    <span class="veil-badge__mark">${isAi ? 'AI' : 'OK'}</span>
    <span class="veil-badge__score">${Math.round(score * 100)}%</span>
  `;
  record.badge.title = `${Math.round(score * 100)}% AI · ${record.result.elapsedMs} ms · ${record.result.backend || ''}${record.result.adapter ? ` · ${record.result.adapter}` : ''}`;
  record.badge.dataset.veilElapsed = String(record.result.elapsedMs || 0);
  record.image.dataset.veilScore = String(Math.round(score * 100));
  record.image.dataset.veilSource = String(record.result.fuseSource || '');
  record.image.dataset.veilModel = record.result.modelScore == null ? '' : String(record.result.modelScore);
  record.image.dataset.veilWeb = record.result.webScore == null ? '' : String(record.result.webScore);
  record.badge.setAttribute(
    'aria-label',
    `${Math.round(score * 100)} percent probability this image is AI-generated. Open details.`
  );
  applyMediaTreatment(record);
  attachFlowBadge(record);
  schedulePositions();
}

function badgeHost(el) {
  if (el instanceof HTMLImageElement || el instanceof HTMLVideoElement || el instanceof HTMLCanvasElement) {
    return el.parentElement;
  }
  return el instanceof HTMLElement ? el : null;
}

function attachFlowBadge(record) {
  const host = badgeHost(record.image);
  const badge = record.badge;
  if (!(host instanceof HTMLElement)) {
    badge.classList.add('veil-badge--fixed');
    mountOverlay(badge);
    record.badgeFlow = false;
    return;
  }
  badge.classList.remove('veil-badge--fixed');
  if (getComputedStyle(host).position === 'static') {
    host.style.position = 'relative';
    record.badgeResetParent = true;
    record.badgeParent = host;
  }
  if (badge.parentElement !== host) host.append(badge);
  record.badgeFlow = true;
  syncFlowBadge(record);
}

function syncFlowBadge(record) {
  const el = record.image;
  const badge = record.badge;
  if (!record.badgeFlow || !badge) return;
  badge.style.visibility = badge.hidden ? 'hidden' : 'visible';
  badge.style.display = badge.hidden ? 'none' : 'flex';
  if (badge.hidden) return;
  const top = (el instanceof HTMLElement ? el.offsetTop : 0) + 8;
  const width = el instanceof HTMLElement ? el.offsetWidth : badge.parentElement?.clientWidth || 0;
  const left = (el instanceof HTMLElement ? el.offsetLeft : 0) + Math.max(0, width - (badge.offsetWidth || 72) - 8);
  badge.style.top = `${top}px`;
  badge.style.left = `${left}px`;
  badge.style.right = 'auto';
  badge.style.transform = 'none';
}

function detachFlowBadge(record) {
  record.badge?.remove();
  if (record.badgeResetParent && record.badgeParent instanceof HTMLElement) {
    const used = [...records.values()].some((other) => other !== record && (
      other.badgeParent === record.badgeParent || other.coverPositionEl === record.badgeParent
    ));
    if (!used) record.badgeParent.style.removeProperty('position');
  }
  record.badgeResetParent = false;
  record.badgeParent = undefined;
  record.badgeFlow = false;
}

function renderAllResults() {
  for (const record of records.values()) {
    record.badge.hidden = false;
    if (record.result) renderRecord(record);
  }
  schedulePositions();
}

function schedulePositions() {
  if (updateFrame) return;
  updateFrame = requestAnimationFrame(() => {
    updateFrame = undefined;
    updatePositionsNow();
  });
}

function updatePositionsNow() {
  for (const record of onScreen) {
    if (record.badgeFlow) syncFlowBadge(record);
    else positionBadge(record);
  }
  if (!detailPanel.hidden) positionDetailPanel();
}

function mountOverlay(node) {
  if (node.parentElement !== overlayLayer) overlayLayer.append(node);
}

function hideChrome(record) {
  record.badge.style.visibility = 'hidden';
}

function positionBadge(record) {
  const image = record.image;
  if (!image.isConnected || !settings.enabled) {
    hideChrome(record);
    return;
  }
  mountOverlay(record.badge);
  if (record.anchored) {
    record.badge.style.visibility = record.badge.hidden ? 'hidden' : 'visible';
    record.badge.style.display = record.badge.hidden ? 'none' : 'flex';
    return;
  }

  const imageRect = image.getBoundingClientRect();
  const visible = imageRect.width >= 28 && imageRect.height >= 28
    && imageRect.bottom > 0 && imageRect.top < innerHeight
    && imageRect.right > 0 && imageRect.left < innerWidth;
  if (!visible) {
    hideChrome(record);
    return;
  }

  if (record.badge.hidden) {
    record.badge.style.visibility = 'hidden';
    return;
  }
  record.badge.style.visibility = 'visible';
  record.badge.style.display = 'flex';
  const left = imageRect.left + Math.max(0, imageRect.width - (record.badge.offsetWidth || 72) - 8);
  const top = imageRect.top + 8;
  record.badge.style.transform = `translate3d(${left}px, ${top}px, 0)`;
}

function createDetailPanel() {
  const panel = document.createElement('section');
  panel.className = 'veil-detail';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Image authenticity details');
  panel.addEventListener('click', (event) => {
    if (event.target.closest('[data-veil-reveal]')) {
      const record = [...records.values()].find((candidate) => candidate.id === panel.dataset.anchor);
      if (record) {
        record.revealed = !record.revealed;
        applyMediaTreatment(record);
        showDetails(record);
      }
      return;
    }
    if (event.target.closest('[data-veil-close]')) panel.hidden = true;
  });
  return panel;
}

function showDetails(record) {
  detailPanel.dataset.anchor = record.id;
  const { result } = record;
  const isAi = result.score >= settings.threshold;
  const evidence = result.evidence.length
    ? result.evidence.map((item) => `<li><span>${escapeHtml(item.label)}</span><small>${escapeHtml(item.kind)}</small></li>`).join('')
    : '<li><span>No embedded generator or provenance markers found</span><small>model only</small></li>';
  const treatmentButton = isAi && settings.aiImageAction !== 'label'
    ? `<button class="veil-detail__action" type="button" data-veil-reveal>${record.revealed ? `Reapply ${settings.aiImageAction}` : 'Reveal this image'}</button>`
    : '';
  detailPanel.innerHTML = `
    <button class="veil-detail__close" type="button" data-veil-close aria-label="Close details">×</button>
    <p class="veil-detail__eyebrow">On-device check</p>
    <div class="veil-detail__score veil-detail__score--${isAi ? 'ai' : 'real'}">
      <strong>${Math.round(result.score * 100)}%</strong>
      <span>AI probability</span>
    </div>
    <p class="veil-detail__verdict">${isAi ? 'Likely AI-generated' : 'Likely a real photograph'}</p>
    <div class="veil-detail__meter"><i style="width:${Math.round(result.score * 100)}%"></i><b style="left:${Math.round(settings.threshold * 100)}%"></b></div>
    <div class="veil-detail__legend"><span>Real</span><span>${Math.round(settings.threshold * 100)}% line</span><span>AI</span></div>
    <ul class="veil-detail__evidence">${evidence}</ul>
    ${treatmentButton}
    <p class="veil-detail__meta">${result.dimensions.width}×${result.dimensions.height} · ${escapeHtml(String(result.format || '').toUpperCase())} · ${result.elapsedMs} ms · ${escapeHtml(result.backend)}${result.precision ? `/${result.precision}` : ''}${result.viewsUsed > 1 ? ` · ${result.viewsUsed} views` : ''}${result.cached ? ' · cache' : ''}</p>
    <p class="veil-detail__privacy">Pixels stayed in this browser. A score is a signal, not a verdict.</p>
  `;
  detailPanel.hidden = false;
  positionDetailPanel();
}

function positionDetailPanel() {
  const record = [...records.values()].find((candidate) => candidate.id === detailPanel.dataset.anchor);
  if (!record) return;
  const rect = record.image.getBoundingClientRect();
  const width = Math.min(340, innerWidth - 20);
  detailPanel.style.width = `${width}px`;
  const left = Math.min(innerWidth - width - 10, Math.max(10, rect.right - width));
  const estimatedHeight = 390;
  const top = rect.bottom + 10 + estimatedHeight < innerHeight
    ? rect.bottom + 10
    : Math.max(10, rect.top - estimatedHeight - 10);
  detailPanel.style.left = `${left}px`;
  detailPanel.style.top = `${top}px`;
}

function upgradeImageUrl(source = '') {
  try {
    const url = new URL(source);
    if (url.pathname.includes('/_next/image') && url.searchParams.has('w')) {
      const width = Number(url.searchParams.get('w')) || 0;
      if (width && width < 828) url.searchParams.set('w', '828');
      return url.toString();
    }
    if (/pbs\.twimg\.com$/i.test(url.hostname) && /name=/.test(url.search)) {
      return source.replace(/name=\w+/, 'name=large');
    }
    return source;
  } catch {
    return source;
  }
}

function injectEngineFrame() {
  if (window !== window.top) return { ok: false };
  const existing = document.getElementById('veil-engine-frame');
  if (existing) return { ok: true, already: true };
  const frame = document.createElement('iframe');
  frame.id = 'veil-engine-frame';
  frame.src = chrome.runtime.getURL('src/offscreen/offscreen.html');
  frame.setAttribute('allow', 'gpu');
  frame.setAttribute('aria-hidden', 'true');
  Object.assign(frame.style, {
    position: 'fixed',
    width: '0',
    height: '0',
    border: '0',
    left: '-9999px',
    top: '0',
    opacity: '0',
    pointerEvents: 'none'
  });
  document.documentElement.append(frame);
  return { ok: true, already: false };
}

async function capturePixels(element) {
  if (!captureCtx) return null;
  return withCapture(() => capturePixelsUnlocked(element));
}

async function capturePixelsUnlocked(element) {
  let source = null;
  let width = 0;
  let height = 0;
  if (element instanceof HTMLImageElement && element.complete && element.naturalWidth) {
    source = element;
    width = element.naturalWidth;
    height = element.naturalHeight;
  } else if (element instanceof HTMLVideoElement && element.readyState >= 2 && element.videoWidth) {
    source = element;
    width = element.videoWidth;
    height = element.videoHeight;
  } else if (element instanceof HTMLCanvasElement && element.width && element.height) {
    source = element;
    width = element.width;
    height = element.height;
  } else {
    return null;
  }
  try {
    const box = officialCropRect(width, height);
    const sx = Math.max(0, Math.floor(box.sx));
    const sy = Math.max(0, Math.floor(box.sy));
    const sw = Math.max(1, Math.min(width - sx, Math.ceil(box.sw)));
    const sh = Math.max(1, Math.min(height - sy, Math.ceil(box.sh)));
    const bitmap = await createImageBitmap(source, sx, sy, sw, sh, {
      resizeWidth: INPUT,
      resizeHeight: INPUT,
      resizeQuality: 'high',
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none'
    });
    try {
      return grabFromBitmap(bitmap, width, height);
    } finally {
      bitmap.close();
    }
  } catch {
    try {
      return grabOfficial(source, width, height);
    } catch {
      return null;
    }
  }
}

function grabFromBitmap(bitmap, sourceWidth, sourceHeight) {
  captureCtx.setTransform(1, 0, 0, 1, 0, 0);
  captureCtx.clearRect(0, 0, INPUT, INPUT);
  captureCtx.drawImage(bitmap, 0, 0, INPUT, INPUT);
  const { data } = captureCtx.getImageData(0, 0, INPUT, INPUT);
  return {
    width: INPUT,
    height: INPUT,
    sourceWidth,
    sourceHeight,
    buffer: new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
  };
}

function grabOfficial(source, width, height) {
  captureCtx.setTransform(1, 0, 0, 1, 0, 0);
  captureCtx.clearRect(0, 0, INPUT, INPUT);
  drawOfficialCrop(captureCtx, source, width, height);
  const { data } = captureCtx.getImageData(0, 0, INPUT, INPUT);
  return {
    width: INPUT,
    height: INPUT,
    sourceWidth: width,
    sourceHeight: height,
    buffer: new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
  };
}

function resetImage(image) {
  sourceCache.delete(image);
  bgUrlCache.delete(image);
  const record = records.get(image);
  if (record) {
    clearRecordTreatment(record);
    onScreen.delete(record);
    detachFlowBadge(record);
    records.delete(image);
  }
  intersectionObserver.observe(image);
}

function rescanPage() {
  for (const record of records.values()) {
    clearRecordTreatment(record);
    detachFlowBadge(record);
  }
  records.clear();
  onScreen.clear();
  pending.length = 0;
  Object.assign(pageState, { status: 'idle', scanned: 0, aiCount: 0, realCount: 0, errors: 0, results: [] });
  discoverImages(document);
  for (const image of document.images) if (isAnalyzable(image)) enqueue(image);
}

function hideAllOverlays() {
  for (const record of records.values()) {
    record.badge.style.display = 'none';
    clearRecordTreatment(record);
  }
  detailPanel.hidden = true;
}

function injectPageStyles() {
  if (document.getElementById('veil-injected-style')) return;
  const style = document.createElement('style');
  style.id = 'veil-injected-style';
  style.textContent = `
    [data-veil-treatment="blur"] { filter: blur(16px) saturate(.65) brightness(.88) !important; }
    [data-veil-treatment="hide"] { visibility: hidden !important; }
    #veil-overlay-layer { all: initial; position: fixed; inset: 0; z-index: 2147483646; pointer-events: none; }
    .veil-cover { position: absolute !important; inset: 0 !important; z-index: 2; background: rgba(20,18,14,.22); pointer-events: none; }
    .veil-badge { position: absolute !important; top: 8px; right: 8px; left: auto; z-index: 2147483646 !important; }
    .veil-badge--fixed { position: fixed !important; top: 0; left: 0; right: auto; }
  `;
  (document.head || document.documentElement).append(style);
}

function applyMediaTreatment(record) {
  const isAi = record.result?.score >= settings.threshold;
  if (!settings.enabled || !isAi || record.revealed || settings.aiImageAction === 'label') {
    clearRecordTreatment(record);
    return;
  }
  record.image.dataset.veilTreatment = settings.aiImageAction;
  treatBackgroundSurface(record);
  detachCover(record);
}

function treatBackgroundSurface(record) {
  const el = record.image;
  if (!(el instanceof Element)) return;
  record.extraTreated ||= [];
  const parent = el.parentElement;
  if (parent && cssBackgroundUrl(parent) && !record.extraTreated.includes(parent)) {
    parent.dataset.veilTreatment = settings.aiImageAction;
    record.extraTreated.push(parent);
  }
}

function coverHost(el) {
  if (el instanceof HTMLImageElement || el instanceof HTMLVideoElement || el instanceof HTMLCanvasElement) {
    return el.parentElement;
  }
  return el instanceof HTMLElement ? el : null;
}

function attachInFlowCover(record) {
  const el = record.image;
  const host = coverHost(el);
  if (!(host instanceof HTMLElement)) return;
  if (!record.cover) {
    record.cover = document.createElement('div');
    record.cover.className = 'veil-cover';
    record.cover.setAttribute('aria-hidden', 'true');
  }
  if (record.cover.parentElement !== host) {
    if (getComputedStyle(host).position === 'static') {
      host.style.position = 'relative';
      record.coverResetPosition = true;
      record.coverPositionEl = host;
    }
    host.append(record.cover);
  }
  syncCoverToMedia(record);
}

function syncCoverToMedia(record) {
  const el = record.image;
  const cover = record.cover;
  const host = cover?.parentElement;
  if (!cover || !host || host === el) return;
  const fillsHost = el.offsetWidth >= host.clientWidth - 2
    && el.offsetHeight >= host.clientHeight - 2
    && el.offsetTop <= 1
    && el.offsetLeft <= 1;
  if (fillsHost) {
    cover.style.inset = '0';
    cover.style.width = '';
    cover.style.height = '';
    cover.style.top = '';
    cover.style.left = '';
    return;
  }
  cover.style.inset = 'auto';
  cover.style.top = `${el.offsetTop}px`;
  cover.style.left = `${el.offsetLeft}px`;
  cover.style.width = `${el.offsetWidth}px`;
  cover.style.height = `${el.offsetHeight}px`;
}

function detachCover(record) {
  record.cover?.remove();
  record.cover = undefined;
  if (record.coverResetPosition && record.coverPositionEl instanceof HTMLElement) {
    record.coverPositionEl.style.removeProperty('position');
  }
  record.coverResetPosition = false;
  record.coverPositionEl = undefined;
}

function clearRecordTreatment(record) {
  detachCover(record);
  if (record.image) {
    delete record.image.dataset.veilTreatment;
    record.image.style.removeProperty('anchor-name');
  }
  for (const extra of record.extraTreated || []) {
    delete extra.dataset.veilTreatment;
  }
  record.extraTreated = undefined;
  if (record.badge) {
    delete record.badge.dataset.anchored;
    record.badge.style.removeProperty('position-anchor');
  }
  record.anchored = false;
}

function clearMediaTreatment(image) {
  const record = records.get(image);
  if (record) clearRecordTreatment(record);
  else delete image.dataset.veilTreatment;
}

function toPublicResult(record) {
  return {
    id: record.id,
    score: record.result.score,
    dimensions: record.result.dimensions,
    format: record.result.format,
    evidenceCount: record.result.evidence.length,
    elapsedMs: record.result.elapsedMs,
    treatment: record.result.score >= settings.threshold && !record.revealed ? settings.aiImageAction : 'none',
    source: redactSource(record.source)
  };
}

function redactSource(source) {
  try {
    const url = new URL(source);
    const name = url.pathname.split('/').pop() || '';
    return `${url.hostname}${name ? `/${name.slice(0, 42)}` : ''}`;
  } catch {
    return 'Embedded image';
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Analysis timed out.')), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

async function peekEncoded(url) {
  if (!url || !/^(https?:|data:)/i.test(url)) return null;
  try {
    const response = await fetch(url, { credentials: 'omit', cache: 'force-cache' });
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    const mimeType = response.headers.get('content-type') || guessPeekMime(url);
    const encoded = inspectEncodedImage(buffer, mimeType);
    let pixels = null;
    try {
      const blob = new Blob([buffer], { type: mimeType || 'image/jpeg' });
      const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
        .catch(() => createImageBitmap(blob));
      try {
        pixels = await withCapture(() => grabFromBitmap(bitmap, bitmap.width, bitmap.height));
      } finally {
        bitmap.close();
      }
    } catch {
      pixels = null;
    }
    return { encoded, pixels };
  } catch {
    return null;
  }
}

function guessPeekMime(source = '') {
  if (/\.png(?:$|\?)/i.test(source)) return 'image/png';
  if (/\.webp(?:$|\?)/i.test(source)) return 'image/webp';
  if (/\.avif(?:$|\?)/i.test(source)) return 'image/avif';
  if (/\.gif(?:$|\?)/i.test(source)) return 'image/gif';
  return 'image/jpeg';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]
  ));
}
