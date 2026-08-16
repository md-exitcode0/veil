import { describe, expect, it } from 'vitest';
import { formatAdapterName, gpuFallbackHint, isIntegratedName } from './gpu.js';

describe('formatAdapterName', () => {
  it('prefers the human description', () => {
    expect(formatAdapterName({
      description: 'NVIDIA GeForce RTX 4050 Laptop GPU',
      vendor: 'nvidia',
      device: 'NVIDIA GeForce RTX 4050 Laptop GPU'
    })).toBe('NVIDIA GeForce RTX 4050 Laptop GPU');
  });

  it('returns null when Chrome gives no adapter info', () => {
    expect(formatAdapterName({})).toBeNull();
  });
});

describe('isIntegratedName', () => {
  it('treats Iris as integrated and RTX as discrete', () => {
    expect(isIntegratedName('Intel(R) Iris(R) Xe Graphics')).toBe(true);
    expect(isIntegratedName('NVIDIA GeForce RTX 4050 Laptop GPU')).toBe(false);
    expect(isIntegratedName('GPU')).toBe(false);
  });
});

describe('gpuFallbackHint', () => {
  it('stays quiet on WebGPU, including integrated adapters', () => {
    expect(gpuFallbackHint({
      backend: 'WebGPU',
      adapterName: 'Intel(R) Iris(R) Xe Graphics'
    })).toBeNull();
  });

  it('does not ask anyone to flip Chrome flags', () => {
    expect(gpuFallbackHint({
      backend: 'CPU (WebAssembly)',
      gpuError: 'Chrome returned no GPU adapter. On NVIDIA + Intel laptops enable chrome://flags/#force-high-performance-gpu'
    })).toBeNull();
  });

  it('surfaces a real runtime error', () => {
    expect(gpuFallbackHint({
      backend: 'CPU (WebAssembly)',
      gpuError: 'Model file missing (404).'
    })).toBe('Model file missing (404).');
  });
});
