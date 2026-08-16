import { describe, expect, it } from 'vitest';
import { calibrateDecisionScore } from './calibrate.js';
import { computePixelSignals, firstHttpImageUrl, fuseEvidence, inspectEncodedImage, inspectOwnHost, inspectSourceUrl, largestSrcFromSrcset } from './forensics.js';

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

  it('treats a Midjourney CDN URL as generator evidence', () => {
    const result = inspectSourceUrl('https://cdn.midjourney.com/abc/0_0.png');
    expect(result.evidence.map((item) => item.label)).toContain('Midjourney image host');
    const proxied = inspectSourceUrl('https://www.midjourney.com/_next/image?url=https%3A%2F%2Fcdn.midjourney.com%2Fabc%2F0_0.png&w=256');
    expect(proxied.evidence.map((item) => item.label)).toContain('Midjourney image host');
  });

  it('flags any Civitai subdomain as a generator host', () => {
    expect(inspectSourceUrl('https://www.civitai.com/images/123').evidence.length).toBeGreaterThan(0);
  });

  it('unwraps a Bing mediaurl locator', () => {
    const bing = 'https://www.bing.com/images/search?view=detail&mediaurl=https%3A%2F%2Fcdn.leonardo.ai%2Fabc.png';
    expect(inspectSourceUrl(bing).evidence.map((item) => item.label).join(' ')).toMatch(/Leonardo/i);
  });

  it('unwraps a Google Images imgurl locator to the Midjourney CDN', () => {
    const google = 'https://www.google.com/imgres?imgurl=https%3A%2F%2Fcdn.midjourney.com%2Fabc%2F0_0.png&imgrefurl=https%3A%2F%2Fexample.com';
    const result = inspectSourceUrl(google);
    expect(result.evidence.map((item) => item.label)).toContain('Midjourney image host');
    expect(result.resolved).toContain('cdn.midjourney.com');
  });

  it('pulls the CDN URL out of an image-set background', () => {
    const css = 'image-set(url("https://cdn.midjourney.com/abc/0_1_384_N.webp?method=shortest") 1dppx, url("https://cdn.midjourney.com/abc/0_1_640_N.webp") 2dppx)';
    expect(firstHttpImageUrl(css)).toBe('https://cdn.midjourney.com/abc/0_1_384_N.webp?method=shortest');
  });

  it('reads protocol-relative and blob CSS urls', () => {
    expect(firstHttpImageUrl('url("//cdn.midjourney.com/abc.png")')).toBe('https://cdn.midjourney.com/abc.png');
    expect(firstHttpImageUrl('url("blob:https://example.com/1")')).toBe('blob:https://example.com/1');
  });

  it('picks the largest srcset candidate', () => {
    expect(largestSrcFromSrcset('a.jpg 320w, b.jpg 1280w, c.jpg 640w')).toBe('b.jpg');
  });

  it('does not treat ordinary EXIF camera text as AI evidence', () => {
    const bytes = jpegWithExif('Make\0Fujifilm\0Model\0X-T5\0Software\0Capture One');
    const result = inspectEncodedImage(bytes.buffer, 'image/jpeg');
    expect(result.evidence).toEqual([]);
    expect(result.watermarks).toEqual([]);
    expect(result.camera.found).toBe(true);
  });

  it('does not treat a Google Images wrap as this image\'s host', () => {
    const wrap = 'https://www.google.com/imgres?imgurl=https%3A%2F%2Fcdn.midjourney.com%2Fabc%2F0_0.png';
    expect(inspectOwnHost(wrap).evidence).toEqual([]);
    expect(inspectOwnHost('https://cdn.midjourney.com/abc/0_0.png').evidence.length).toBeGreaterThan(0);
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

  it('does not let a generator host override a low visual score', () => {
    const encoded = {
      evidence: [{ kind: 'host', label: 'Midjourney image host', strength: 0.4 }],
      watermarks: []
    };
    expect(fuseEvidence(0.001, encoded, { adjustment: 0 })).toBeLessThan(0.65);
    expect(fuseEvidence(0.4, encoded, { adjustment: 0 })).toBeCloseTo(0.4, 5);
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

function jpegWithExif(ascii) {
  const payload = new TextEncoder().encode(`Exif\0\0${ascii}`);
  const bytes = new Uint8Array(4 + payload.length);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  bytes[3] = 0xe1;
  bytes.set(payload, 4);
  return bytes;
}
