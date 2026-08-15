import { describe, expect, it } from 'vitest';
import { fuseModelScores, shouldRunWebHead } from './ensemble.js';

describe('fuseModelScores', () => {
  it('lets generator metadata win', () => {
    const result = fuseModelScores({
      cfRaw: 0.01,
      webRaw: 0.01,
      encoded: { evidence: [{ label: 'ComfyUI' }] }
    });
    expect(result.score).toBeGreaterThanOrEqual(0.985);
    expect(result.source).toBe('metadata');
  });

  it('takes the high score when either head is sure it is AI', () => {
    const result = fuseModelScores({ cfRaw: 0.9, webRaw: 0.01, encoded: { evidence: [] } });
    expect(result.score).toBeGreaterThan(0.8);
  });

  it('stays low when both heads say real', () => {
    const result = fuseModelScores({ cfRaw: 0.0001, webRaw: 0.0001, encoded: { evidence: [] } });
    expect(result.score).toBeLessThan(0.3);
  });

  it('does not let a barely-over web score flip a real CF photo', () => {
    const result = fuseModelScores({ cfRaw: 0.003, webRaw: 0.05, encoded: { evidence: [] } });
    expect(result.score).toBeLessThan(0.65);
  });
});

describe('shouldRunWebHead', () => {
  it('skips the second head on a confident CF AI score', () => {
    expect(shouldRunWebHead(0.95, 800, 600)).toBe(false);
  });

  it('runs the second head on a large square that CF thinks is real', () => {
    expect(shouldRunWebHead(0.0002, 1024, 1024)).toBe(true);
  });
});
