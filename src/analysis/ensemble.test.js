import { describe, expect, it } from 'vitest';
import { fuseModelScores, shouldRunWebHead } from './ensemble.js';

describe('fuseModelScores', () => {
  it('lets embedded file metadata win only when there is no visual score', () => {
    const result = fuseModelScores({
      cfRaw: null,
      webRaw: null,
      encoded: { evidence: [{ kind: 'metadata', label: 'ComfyUI' }] }
    });
    expect(result.score).toBeGreaterThanOrEqual(0.985);
    expect(result.source).toBe('metadata');
  });

  it('does not treat a generator CDN host as a visual verdict', () => {
    const result = fuseModelScores({
      cfRaw: 0.001,
      webRaw: null,
      encoded: { evidence: [{ kind: 'host', label: 'Midjourney image host' }] }
    });
    expect(result.score).toBeLessThan(0.65);
    expect(result.source).not.toBe('metadata');
  });

  it('lets file metadata confirm AI even when CF underscored the pixels', () => {
    const result = fuseModelScores({
      cfRaw: 0.001,
      webRaw: null,
      encoded: { evidence: [{ kind: 'metadata', label: 'ComfyUI' }] }
    });
    expect(result.source).toBe('metadata');
    expect(result.score).toBeGreaterThanOrEqual(0.985);
  });

  it('does not let a photo-like web score flip a CF-real landscape', () => {
    const result = fuseModelScores({ cfRaw: 0.00114, webRaw: 0.876, encoded: { evidence: [] } });
    expect(result.score).toBeLessThan(0.65);
    expect(result.source).toBe('cf-real');
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

  it('does not let the web head flip a Preikestolen-style CF-real landscape', () => {
    const result = fuseModelScores({ cfRaw: 0.0017, webRaw: 0.21, encoded: { evidence: [] } });
    expect(result.score).toBeLessThan(0.65);
    expect(result.source).toBe('cf-real');
  });

  it('lets a raw-sure web head recover Midjourney that CF underscored', () => {
    const result = fuseModelScores({ cfRaw: 0.0001, webRaw: 0.999, encoded: { evidence: [] } });
    expect(result.score).toBeGreaterThan(0.85);
    expect(result.source).toBe('max-ai');
  });

  it('does not treat a mid web raw as sure-AI', () => {
    const result = fuseModelScores({ cfRaw: 0.002, webRaw: 0.44, encoded: { evidence: [] } });
    expect(result.score).toBeLessThan(0.65);
  });

  it('holds a camera-backed photo below the 65% line', () => {
    const result = fuseModelScores({
      cfRaw: 0.2,
      webRaw: null,
      encoded: { evidence: [], camera: { found: true, label: 'Camera EXIF (canon)' } }
    });
    expect(result.score).toBeLessThan(0.65);
    expect(result.source).toBe('camera');
  });

  it('does not let camera EXIF override a sure visual AI score', () => {
    const result = fuseModelScores({
      cfRaw: 0.97,
      webRaw: null,
      encoded: { evidence: [], camera: { found: true, label: 'Camera EXIF (apple)' } }
    });
    expect(result.score).toBeGreaterThan(0.85);
    expect(result.source).not.toBe('camera');
  });
});

describe('shouldRunWebHead', () => {
  it('skips the second head on a confident CF AI score', () => {
    expect(shouldRunWebHead(0.95, 800, 600)).toBe(false);
  });

  it('skips the second head on a CF-real photograph', () => {
    expect(shouldRunWebHead(0.0002, 1024, 1024)).toBe(false);
    expect(shouldRunWebHead(0.002, 800, 600)).toBe(false);
    expect(shouldRunWebHead(0.0002, 256, 256)).toBe(false);
  });

  it('runs the second head only when CF is in the uncertain band', () => {
    expect(shouldRunWebHead(0.20, 800, 600)).toBe(true);
    expect(shouldRunWebHead(0.40, 1024, 1024)).toBe(true);
  });

  it('still skips the extra pass when file metadata already confirmed AI', () => {
    expect(shouldRunWebHead(0.20, 1024, 1024, { fileMetadata: true })).toBe(false);
  });

  it('honors dualView=false', () => {
    expect(shouldRunWebHead(0.20, 800, 600, { dualView: false })).toBe(false);
  });
});
