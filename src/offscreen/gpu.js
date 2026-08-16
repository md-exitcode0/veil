const ADAPTER_TRIES = [
  { powerPreference: 'high-performance' },
  { powerPreference: 'low-power' },
  {},
  { featureLevel: 'compatibility', powerPreference: 'high-performance' },
  { featureLevel: 'compatibility' }
];

export async function acquireGpu() {
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    return fail('This Chrome build has no WebGPU. Update Chrome, then retry.');
  }

  let adapter = null;
  let lastError = null;
  for (const options of ADAPTER_TRIES) {
    try {
      adapter = await navigator.gpu.requestAdapter(options);
      if (adapter) break;
    } catch (error) {
      lastError = error;
    }
  }

  if (!adapter) {
    return fail(
      lastError
        ? `Chrome GPU adapter request failed: ${errorMessage(lastError)}`
        : 'This document has no GPU adapter.'
    );
  }

  const info = await readAdapterInfo(adapter);
  return {
    adapter,
    device: null,
    info,
    name: formatAdapterName(info) || 'GPU',
    error: null
  };
}

export function formatAdapterName(info = {}) {
  const parts = [info.description, info.device, info.vendor]
    .map((value) => String(value || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return parts[0] || null;
}

export function isIntegratedName(name = '') {
  const text = String(name).toLowerCase();
  if (/nvidia|geforce|rtx|gtx|radeon rx|accele/.test(text)) return false;
  return /iris|uhd graphics|intel|amd radeon graphics|apple m\d/.test(text);
}

export function gpuFallbackHint({ backend, adapterName, gpuError } = {}) {
  if (backend === 'WebGPU') return null;
  if (gpuError && /no GPU adapter|navigator\.gpu|not supported/i.test(gpuError)) {
    return null;
  }
  return gpuError || null;
}

export function webgpuProviders() {
  return [{ name: 'webgpu' }];
}

async function readAdapterInfo(adapter) {
  if (adapter.info && (adapter.info.vendor || adapter.info.device || adapter.info.description)) {
    return adapter.info;
  }
  try {
    return await adapter.requestAdapterInfo?.() || {};
  } catch {
    return {};
  }
}

function fail(error, extra = {}) {
  return { adapter: null, device: null, info: null, name: null, error, ...extra };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
