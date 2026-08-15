import { DEFAULT_SETTINGS } from './constants.js';

export async function getSettings() {
  const stored = await chrome.storage.local.get('settings');
  return sanitizeSettings(stored.settings);
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const settings = sanitizeSettings({ ...current, ...patch });
  await chrome.storage.local.set({ settings });
  return settings;
}

export function sanitizeSettings(value = {}) {
  return {
    enabled: value.enabled !== false,
    threshold: clampNumber(value.threshold, 0.5, 0.95, DEFAULT_SETTINGS.threshold),
    minimumDimension: clampNumber(value.minimumDimension, 48, 512, DEFAULT_SETTINGS.minimumDimension),
    maxImagesPerPage: Math.round(clampNumber(value.maxImagesPerPage, 5, 200, DEFAULT_SETTINGS.maxImagesPerPage)),
    showRealScores: value.showRealScores !== false,
    aiImageAction: ['blur', 'hide', 'label'].includes(value.aiImageAction)
      ? value.aiImageAction
      : DEFAULT_SETTINGS.aiImageAction,
    dualView: value.dualView !== false
  };
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}
