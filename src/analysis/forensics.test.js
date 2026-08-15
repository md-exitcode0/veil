import { describe, expect, it } from 'vitest';
import { calibrateDecisionScore } from './calibrate.js';
import { computePixelSignals, fuseEvidence, inspectEncodedImage } from './forensics.js';

describe('encoded image forensics', () => {
  it('finds Stable Diffusion generation parameters in PNG text chunks', () => {
    const bytes = makePngWithText('parameters\0a lighthouse\nSteps: 30, Sampler: Euler, Seed: 42, Model hash: abc123, stable diffusion');
    const result = inspectEncodedImage(bytes.buffer, 'image/png');
    expect(result.format).toBe('png');
    expect(result.evidence.map((item) => item.label)).toContain('Stable Diffusion generator metadata');
    expect(result.evidence.map((item) => item.label)).toContain('Embedded generation parameters');
  });

  it('surfaces provenance and watermark labels separately', () => {
    const bytes = new TextEncoder().encode('RIFFxxxxWEBPXMP Content Credentials c2pa synthid');
    const result = inspectEncodedImage(bytes.buffer, 'image/webp');
    expect(result.provenance.length).toBeGreaterThan(0);
    expect(result.watermarks[0].label).toMatch(/SynthID/);
  });

  it('does not treat ordinary EXIF camera text as AI evidence', () => {
    const bytes = new TextEncoder().encode('Exif\0\0Make=Fujifilm;Model=X-T5;Software=Capture One');
    const result = inspectEncodedImage(bytes.buffer, 'image/jpeg');
    expect(result.evidence).toEqual([]);
    expect(result.watermarks).toEqual([]);
  });
});

describe('hybrid score fusion', () => {
  it('maps the official operating point to the visible 65% decision line', () => {
    expect(calibrateDecisionScore(0.5)).toBeCloseTo(0.65, 8);
    expect(calibrateDecisionScore(0.35)).toBeLessThan(0.65);
    expect(calibrateDecisionScore(0.7)).toBeGreaterThan(0.65);
  });

  it('lets explicit generator metadata override an uncertain model', () => {
    const encoded = {
      evidence: [{ kind: 'metadata', label: 'ComfyUI workflow metadata', strength: 0.98 }],
      watermarks: []
    };
    expect(fuseEvidence(0.4, encoded, { adjustment: 0 })).toBeGreaterThanOrEqual(0.985);
  });

  it('keeps weak pixel calibration bounded', () => {
    const encoded = { evidence: [], watermarks: [] };
    expect(fuseEvidence(0.5, encoded, { adjustment: 0.04 })).toBeLessThan(0.56);
    expect(fuseEvidence(0.5, encoded, { adjustment: -0.03 })).toBeGreaterThan(0.47);
  });

  it('returns finite signals for a simple image', () => {
    const data = new Uint8ClampedArray(16 * 16 * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = (i / 4) % 255;
      data[i + 1] = 90;
      data[i + 2] = 150;
      data[i + 3] = 255;
    }
    const result = computePixelSignals({ data, width: 16, height: 16 });
    expect(Number.isFinite(result.adjustment)).toBe(true);
    expect(Number.isFinite(result.metrics.luminanceEntropy)).toBe(true);
  });
});

function makePngWithText(text) {
  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const payload = new TextEncoder().encode(text);
  const chunk = new Uint8Array(12 + payload.length);
  new DataView(chunk.buffer).setUint32(0, payload.length, false);
  chunk.set(new TextEncoder().encode('tEXt'), 4);
  chunk.set(payload, 8);
  return Uint8Array.from([...signature, ...chunk]);
}
