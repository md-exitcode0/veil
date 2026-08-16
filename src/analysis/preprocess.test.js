import { describe, expect, it } from 'vitest';
import { MODEL } from '../shared/constants.js';
import { imageDataToNchw, officialCropRect } from './preprocess.js';

describe('official crop', () => {
  it('is always smaller than the short side, so small captures are not stretched', () => {
    for (const short of [96, 200, 384, 440, 512, 1024]) {
      const crop = (MODEL.inputSize * short) / MODEL.resizeShortest;
      expect(crop).toBeLessThan(short);
    }
  });

  it('stays inside the source rectangle', () => {
    const box = officialCropRect(2000, 1500);
    expect(box.sx).toBeGreaterThanOrEqual(0);
    expect(box.sy).toBeGreaterThanOrEqual(0);
    expect(box.sx + box.sw).toBeLessThanOrEqual(2000);
    expect(box.sy + box.sh).toBeLessThanOrEqual(1500);
    expect(box.sw).toBeCloseTo(box.sh, 8);
  });
});

describe('imageDataToNchw', () => {
  it('writes three CLIP-normalized planes from RGBA', () => {
    const data = new Uint8ClampedArray(MODEL.inputSize * MODEL.inputSize * 4);
    data.fill(255);
    const out = imageDataToNchw({ data, width: MODEL.inputSize, height: MODEL.inputSize }, undefined, 'clip');
    expect(out.length).toBe(3 * MODEL.inputSize * MODEL.inputSize);
    expect(out[0]).toBeCloseTo((1 - MODEL.mean[0]) / MODEL.std[0], 5);
    expect(out[MODEL.inputSize * MODEL.inputSize]).toBeCloseTo((1 - MODEL.mean[1]) / MODEL.std[1], 5);
  });
});
