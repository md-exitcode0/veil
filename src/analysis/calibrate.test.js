import { describe, expect, it } from 'vitest';
import { calibrateDecisionScore } from './calibrate.js';

describe('calibrateDecisionScore', () => {
  it('maps the official 0.50 operating point onto the required 65% line', () => {
    expect(calibrateDecisionScore(0.5)).toBeCloseTo(0.65, 8);
  });

  it('is strictly monotone', () => {
    const low = calibrateDecisionScore(0.2);
    const mid = calibrateDecisionScore(0.5);
    const high = calibrateDecisionScore(0.8);
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
    expect(low).toBeLessThan(0.65);
    expect(high).toBeGreaterThan(0.65);
  });

  it('never returns 0 or 1', () => {
    expect(calibrateDecisionScore(0)).toBeGreaterThan(0);
    expect(calibrateDecisionScore(1)).toBeLessThan(1);
  });

  it('keeps very small raw scores distinct instead of flooring them', () => {
    const a = calibrateDecisionScore(0.00002, 0.012, 0.65);
    const b = calibrateDecisionScore(0.0008, 0.012, 0.65);
    expect(b).toBeGreaterThan(a);
  });
});
