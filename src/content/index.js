const MESSAGE = {
  ANALYZE_IMAGE: 'veil/analyze-image',
  GET_PAGE_STATE: 'veil/get-page-state',
  RESCAN_PAGE: 'veil/rescan-page',
  ANALYZE_URL: 'veil/analyze-url'
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
    maxImagesPerPage: Math.round(number(value.maxImagesPerPage, 5, 200, 80)),
    showRealScores: value.showRealScores !== false,
    aiImageAction: ['blur', 'hide', 'label'].includes(value.aiImageAction) ? value.aiImageAction : 'blur',
    dualView: value.dualView !== false
  };
}

async function getSettings() {
  const stored = await chrome.storage.local.get('settings');
  return sanitizeSettings(stored.settings);
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
let settings = sanitizeSettings();
let requestSequence = 0;
let updateFrame;
let inFlight = 0;
const MAX_IN_FLIGHT = 2;
const pending = [];

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
  discoverImages(document);
});
discoverImages(document);
const mutationObserver = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node instanceof Element) discoverImages(node);
    }
    if (mutation.type === 'attributes' && mutation.target instanceof HTMLImageElement) {
      resetImage(mutation.target);
    }
  }
});
mutationObserver.observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['src', 'srcset']
});

window.addEventListener('scroll', schedulePositions, { passive: true });
window.addEventListener('resize', schedulePositions, { passive: true });
document.addEventListener('visibilitychange', schedulePositions);

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

function discoverImages(root) {
  if (!settings.enabled) return;
  const images = root instanceof HTMLImageElement ? [root] : root.querySelectorAll?.('img') || [];
  for (const image of images) {
    if (observed.has(image)) continue;
    observed.add(image);
    intersectionObserver.observe(image);
  }
}

function handleIntersections(entries) {
  const visible = [];
  for (const entry of entries) {
    if (!entry.isIntersecting || !(entry.target instanceof HTMLImageElement)) continue;
    visible.push(entry);
  }
  visible.sort((a, b) => Math.abs(a.boundingClientRect.top + a.boundingClientRect.height / 2 - innerHeight / 2)
    - Math.abs(b.boundingClientRect.top + b.boundingClientRect.height / 2 - innerHeight / 2));
  for (const entry of visible) {
    const image = entry.target;
    if (isAnalyzable(image)) enqueue(image);
  }
}

function isAnalyzable(image) {
  if (!settings.enabled || records.has(image)) return false;
  if (!image.complete || !image.currentSrc) {
    image.addEventListener('load', () => isAnalyzable(image) && enqueue(image), { once: true });
    return false;
  }
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  if (Math.min(width, height) < settings.minimumDimension) return false;
  if (width * height < settings.minimumDimension ** 2) return false;
  if (records.size + pending.length >= settings.maxImagesPerPage) return false;
  const rect = image.getBoundingClientRect();
  return rect.width >= 48 && rect.height >= 48;
}

function enqueue(image) {
  if (records.has(image) || pending.includes(image)) return;
  pending.push(image);
  pump();
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
    source: image.currentSrc,
    status: 'analyzing',
    result: null,
    badge: createBadge(id)
  };
  records.set(image, record);
  overlayLayer.append(record.badge);
  pageState.status = 'scanning';
  schedulePositions();
  inFlight += 1;

  try {
    const fallbackDataUrl = /^(?:blob:|data:)/.test(record.source) ? captureImage(image) : undefined;
    const result = await chrome.runtime.sendMessage({
      type: MESSAGE.ANALYZE_IMAGE,
      payload: {
        requestId: id,
        source: record.source,
        fallbackDataUrl,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        dualView: settings.dualView,
        pageUrl: location.href
      }
    });
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
  badge.addEventListener('click', () => {
    const record = [...records.values()].find((candidate) => candidate.id === id);
    if (record?.result) showDetails(record);
  });
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
  record.badge.title = `${Math.round(score * 100)}% AI · ${record.result.elapsedMs} ms · ${record.result.backend || ''}`;
  record.badge.dataset.veilElapsed = String(record.result.elapsedMs || 0);
  record.badge.setAttribute(
    'aria-label',
    `${Math.round(score * 100)} percent probability this image is AI-generated. Open details.`
  );
  applyMediaTreatment(record);
  schedulePositions();
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
    for (const record of records.values()) positionBadge(record);
    if (!detailPanel.hidden) positionDetailPanel();
  });
}

function positionBadge(record) {
  if (!record.image.isConnected || record.badge.hidden || !settings.enabled) {
    record.badge.style.display = 'none';
    return;
  }
  const rect = record.image.getBoundingClientRect();
  if (rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth || rect.width < 36 || rect.height < 36) {
    record.badge.style.display = 'none';
    return;
  }
  record.badge.style.display = 'flex';
  record.badge.style.top = `${Math.max(6, rect.top + 8)}px`;
  record.badge.style.left = `${Math.min(innerWidth - record.badge.offsetWidth - 6, Math.max(6, rect.right - record.badge.offsetWidth - 8))}px`;
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

function captureImage(image) {
  try {
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 1024 / Math.max(image.naturalWidth, image.naturalHeight));
    canvas.width = Math.round(image.naturalWidth * scale);
    canvas.height = Math.round(image.naturalHeight * scale);
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.94);
  } catch {
    return undefined;
  }
}

function resetImage(image) {
  const record = records.get(image);
  if (record) {
    clearMediaTreatment(record.image);
    record.badge.remove();
    records.delete(image);
  }
  intersectionObserver.observe(image);
}

function rescanPage() {
  for (const record of records.values()) {
    clearMediaTreatment(record.image);
    record.badge.remove();
  }
  records.clear();
  pending.length = 0;
  Object.assign(pageState, { status: 'idle', scanned: 0, aiCount: 0, realCount: 0, errors: 0, results: [] });
  discoverImages(document);
  for (const image of document.images) if (isAnalyzable(image)) enqueue(image);
}

function hideAllOverlays() {
  for (const record of records.values()) {
    record.badge.style.display = 'none';
    clearMediaTreatment(record.image);
  }
  detailPanel.hidden = true;
}

function applyMediaTreatment(record) {
  const isAi = record.result?.score >= settings.threshold;
  if (!settings.enabled || !isAi || record.revealed || settings.aiImageAction === 'label') {
    clearMediaTreatment(record.image);
    return;
  }
  record.image.dataset.veilTreatment = settings.aiImageAction;
}

function clearMediaTreatment(image) {
  delete image.dataset.veilTreatment;
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

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]
  ));
}
