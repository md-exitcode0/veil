import { describe, expect, it } from 'vitest';
import { sanitizeSettings } from './settings.js';

describe('sanitizeSettings', () => {
  it('fills defaults', () => {
    const settings = sanitizeSettings({});
    expect(settings.enabled).toBe(true);
    expect(settings.threshold).toBe(0.65);
    expect(settings.aiImageAction).toBe('blur');
    expect(settings.dualView).toBe(true);
  });

  it('clamps the bounty threshold into a legal range', () => {
    expect(sanitizeSettings({ threshold: 0.1 }).threshold).toBe(0.5);
    expect(sanitizeSettings({ threshold: 1.4 }).threshold).toBe(0.95);
  });

  it('rejects unknown treatments', () => {
    expect(sanitizeSettings({ aiImageAction: 'nuke' }).aiImageAction).toBe('blur');
  });
});
