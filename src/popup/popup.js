import './popup.css';
import { MESSAGE } from '../shared/constants.js';
import { getSettings, saveSettings } from '../shared/settings.js';

const elements = Object.fromEntries(
  [...document.querySelectorAll('[id]')].map((element) => [
    element.id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()),
    element
  ])
);

let activeTab;
let settings = await getSettings();

elements.enabled.checked = settings.enabled;
elements.aiImageAction.value = settings.aiImageAction;
elements.thresholdLabel.textContent = `${Math.round(settings.threshold * 100)}% line`;

try {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  elements.siteName.textContent = getSiteLabel(activeTab?.url);
  await refresh();
} catch {
  showUnavailable();
}

elements.enabled.addEventListener('change', async () => {
  settings = await saveSettings({ enabled: elements.enabled.checked });
  elements.scanState.textContent = settings.enabled ? 'Detector on' : 'Paused';
  if (settings.enabled) await sendToPage({ type: MESSAGE.RESCAN_PAGE });
  await refresh();
});

elements.aiImageAction.addEventListener('change', async () => {
  settings = await saveSettings({ aiImageAction: elements.aiImageAction.value });
  await refresh();
});

elements.rescan.addEventListener('click', async () => {
  elements.rescan.disabled = true;
  await sendToPage({ type: MESSAGE.RESCAN_PAGE });
  setTimeout(() => window.close(), 220);
});

elements.settings.addEventListener('click', () => chrome.runtime.openOptionsPage());

async function refresh() {
  if (!settings.enabled) {
    renderState({ status: 'paused', scanned: 0, aiCount: 0, realCount: 0, errors: 0, results: [] });
    return;
  }
  const state = await sendToPage({ type: MESSAGE.GET_PAGE_STATE });
  if (!state) return showUnavailable();
  renderState(state);
}

function renderState(state) {
  elements.scannedCount.textContent = state.scanned || 0;
  elements.aiCount.textContent = state.aiCount || 0;
  elements.realCount.textContent = state.realCount || 0;
  elements.errorCount.textContent = state.errors || 0;
  const total = Math.max(1, (state.aiCount || 0) + (state.realCount || 0));
  const aiShare = Math.round(((state.aiCount || 0) / total) * 100);
  elements.dial.style.setProperty('--scan-progress', `${state.scanned ? Math.max(8, aiShare) : 0}%`);

  if (state.status === 'paused') {
    elements.scanState.textContent = 'Paused';
    elements.summary.textContent = 'Automatic checks are off.';
  } else if (state.status === 'scanning') {
    elements.scanState.textContent = 'Scanning locally';
    elements.summary.textContent = 'Reading the images in view…';
  } else if (state.scanned) {
    elements.scanState.textContent = 'Page checked';
    const action = settings.aiImageAction === 'blur' ? 'blurred' : settings.aiImageAction === 'hide' ? 'hidden' : 'flagged';
    elements.summary.textContent = state.aiCount
      ? `${state.aiCount} likely-AI image${state.aiCount === 1 ? '' : 's'} ${action}.`
      : 'No visible image crossed the AI line.';
  } else {
    elements.scanState.textContent = 'Ready';
    elements.summary.textContent = 'Scroll the page to check its images.';
  }

  renderResults(state.results || []);
}

function renderResults(results) {
  elements.results.replaceChildren();
  elements.results.hidden = results.length === 0;
  elements.emptyState.hidden = results.length > 0;
  for (const result of [...results].reverse()) {
    const item = document.createElement('li');
    const isAi = result.score >= settings.threshold;
    item.className = `result-row result-row--${isAi ? 'ai' : 'real'}`;
    item.innerHTML = `
      <span class="result-row__score">${Math.round(result.score * 100)}</span>
      <span class="result-row__copy"><strong>${isAi ? 'Likely AI' : 'Likely real'}</strong><small>${escapeHtml(result.source)} · ${result.dimensions.width}×${result.dimensions.height}</small></span>
      <span class="result-row__evidence">${result.elapsedMs ? `${result.elapsedMs}ms` : '—'}</span>
    `;
    elements.results.append(item);
  }
}

function showUnavailable() {
  elements.scanState.textContent = 'Not available here';
  elements.summary.textContent = 'Chrome blocks extensions on this page.';
  elements.siteName.textContent = 'Try a normal http or https webpage.';
  elements.rescan.disabled = true;
}

async function sendToPage(message) {
  if (!activeTab?.id) return undefined;
  try {
    return await chrome.tabs.sendMessage(activeTab.id, message);
  } catch {
    return undefined;
  }
}

function getSiteLabel(url) {
  try { return new URL(url).hostname; } catch { return 'Every check runs locally.'; }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]
  ));
}
