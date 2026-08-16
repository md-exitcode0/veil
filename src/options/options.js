import './options.css';
import { MESSAGE } from '../shared/constants.js';
import { getSettings, saveSettings } from '../shared/settings.js';

const elements = Object.fromEntries(
  [...document.querySelectorAll('[id]')].map((element) => [
    element.id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()),
    element
  ])
);

let settings = await getSettings();
let saveTimer;
populate(settings);

for (const input of [
  elements.enabled,
  elements.threshold,
  elements.minimumDimension,
  elements.maxImages,
  elements.aiImageAction,
  elements.showRealScores,
  elements.dualView
]) {
  input.addEventListener('input', handleInput);
  input.addEventListener('change', handleInput);
}

elements.warmModel.addEventListener('click', () => checkReady());
checkReady();

async function checkReady() {
  elements.warmModel.disabled = true;
  renderModelStatus({ state: 'loading' });
  const result = await chrome.runtime.sendMessage({ type: MESSAGE.WARM_MODEL });
  renderModelStatus(result);
  elements.warmModel.disabled = false;
  elements.warmModel.textContent = result?.ok ? 'Readiness check passed' : 'Try readiness check again';
}

async function handleInput() {
  elements.thresholdOutput.textContent = `${elements.threshold.value}%`;
  settings = await saveSettings({
    enabled: elements.enabled.checked,
    threshold: Number(elements.threshold.value) / 100,
    minimumDimension: Number(elements.minimumDimension.value),
    maxImagesPerPage: Number(elements.maxImages.value),
    aiImageAction: elements.aiImageAction.value,
    showRealScores: elements.showRealScores.checked,
    dualView: elements.dualView.checked
  });
  clearTimeout(saveTimer);
  elements.saved.textContent = 'Saved locally';
  saveTimer = setTimeout(() => { elements.saved.textContent = ''; }, 1500);
}

function populate(value) {
  elements.enabled.checked = value.enabled;
  elements.threshold.value = String(Math.round(value.threshold * 100));
  elements.thresholdOutput.textContent = `${Math.round(value.threshold * 100)}%`;
  elements.minimumDimension.value = String(value.minimumDimension);
  elements.maxImages.value = String(value.maxImagesPerPage);
  elements.aiImageAction.value = value.aiImageAction;
  elements.showRealScores.checked = value.showRealScores;
  elements.dualView.checked = value.dualView;
}

function renderModelStatus(result) {
  const state = result?.ok ? (result.state || 'ready') : (result?.state || 'error');
  elements.modelStatus.className = `model-status model-status--${state}`;
  if (state === 'loading') {
    elements.modelStatus.innerHTML = '<i></i> Loading the local model…';
  } else if (result?.ok && state === 'ready') {
    const extra = [result.backend, result.adapter, result.precision].filter(Boolean).join(' · ');
    const hint = result.gpuHint
      ? `<small class="model-status__hint">${escapeHtml(result.gpuHint)}</small>`
      : '';
    elements.modelStatus.innerHTML = `<i></i> <span>Ready${extra ? ` · ${escapeHtml(extra)}` : ''}${hint}</span>`;
  } else {
    const hint = result?.gpuHint && result.gpuHint !== result.error
      ? `<small class="model-status__hint">${escapeHtml(result.gpuHint)}</small>`
      : '';
    elements.modelStatus.innerHTML = `<i></i> <span>${escapeHtml(result?.error || 'Readiness check failed')}${hint}</span>`;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]
  ));
}
