import * as ort from 'onnxruntime-web/webgpu';
import { MESSAGE, MODEL, WEB_HEAD } from '../shared/constants.js';
import { sigmoid } from '../analysis/calibrate.js';
import { inspectEncodedImage, inspectOwnHost } from '../analysis/forensics.js';
import { FILE_AI_SCORE, HOST_AI_SCORE, fileEvidence, fuseModelScores, shouldRunWebHead } from '../analysis/ensemble.js';
import { imageDataToNchw, rasterizeToImageData } from '../analysis/preprocess.js';
import { acquireGpu, gpuFallbackHint, webgpuProviders } from './gpu.js';

const WASM_MJS = chrome.runtime.getURL('wasm/ort-wasm-simd-threaded.asyncify.mjs');
const WASM_BIN = chrome.runtime.getURL('wasm/ort-wasm-simd-threaded.asyncify.wasm');
const FP32_URL = chrome.runtime.getURL(`models/${MODEL.id}/${MODEL.fp32File}`);
const WEB_URL = chrome.runtime.getURL(`models/${WEB_HEAD.id}/${WEB_HEAD.weightFile}`);
const SHAPE = [1, 3, MODEL.inputSize, MODEL.inputSize];

let enginePromise;
let modelSlots = 0;
const MODEL_SLOTS = 1;
const modelWaiters = [];
const tensorPool = [];
let gpuHandle = { adapter: null, device: null, name: null, error: null };
let modelState = emptyState('cold');

quietOrtConsole();
configureOrt();
announceAlive();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === MESSAGE.OFFSCREEN_ANALYZE) {
    analyzeImage(message.payload).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: humanizeError(error) });
    });
    return true;
  }
  if (message.type === MESSAGE.WARM_MODEL) {
    getEngine().then(() => sendResponse({ ok: true, ...modelState })).catch((error) => {
      sendResponse({ ok: false, ...modelState, error: humanizeError(error) });
    });
    return true;
  }
  if (message.type === MESSAGE.MODEL_STATUS) {
    sendResponse({ ok: true, ...modelState });
  }
});

function quietOrtConsole() {
  const ignore = /VerifyEachNodeIsAssignedToAnEp|not assigned to the preferred execution providers|Rerunning with verbose output/i;
  for (const method of ['error', 'warn', 'info', 'log']) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      if (ignore.test(args.map((value) => String(value ?? '')).join(' '))) return;
      original(...args);
    };
  }
}

function configureOrt() {
  ort.env.wasm.wasmPaths = { mjs: WASM_MJS, wasm: WASM_BIN };
  const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
  const cores = Number(navigator.hardwareConcurrency) || 1;
  ort.env.wasm.numThreads = isolated ? Math.max(1, Math.min(4, cores)) : 1;
  ort.env.wasm.simd = true;
  ort.env.wasm.proxy = false;
  ort.env.webgpu.powerPreference = 'high-performance';
  ort.env.logLevel = 'error';
}

function announceAlive() {
  chrome.runtime.sendMessage({
    type: MESSAGE.ENGINE_ALIVE,
    gpu: Boolean(navigator.gpu),
    isolated: Boolean(typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated)
  }).catch(() => {});
}

function emptyState(state, extra = {}) {
  return {
    state,
    backend: extra.backend || 'none',
    precision: extra.precision || null,
    threads: extra.threads || ort.env.wasm.numThreads,
    adapter: extra.adapter || null,
    webHead: Boolean(extra.webHead),
    gpuHint: extra.gpuHint || null,
    error: extra.error || null
  };
}

async function withModelSlot(work) {
  if (modelSlots >= MODEL_SLOTS) {
    await new Promise((resolve) => modelWaiters.push(resolve));
  }
  modelSlots += 1;
  try {
    return await work();
  } finally {
    modelSlots -= 1;
    const next = modelWaiters.shift();
    if (next) next();
  }
}

function acquireTensor() {
  const tensor = tensorPool.pop();
  if (tensor) return tensor;
  return new ort.Tensor('float32', new Float32Array(3 * MODEL.inputSize * MODEL.inputSize), SHAPE);
}

function releaseTensor(tensor) {
  tensorPool.push(tensor);
}

async function getEngine() {
  if (!enginePromise) {
    modelState = emptyState('loading');
    enginePromise = createEngine().catch((error) => {
      enginePromise = undefined;
      modelState = emptyState('error', {
        error: humanizeError(error),
        adapter: gpuHandle.name,
        gpuHint: gpuFallbackHint({
          backend: 'CPU (WebAssembly)',
          adapterName: gpuHandle.name,
          gpuError: gpuHandle.error || humanizeError(error)
        })
      });
      throw error;
    });
  }
  return enginePromise;
}

async function createOnnx(url, providers) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Model file missing (${response.status}).`);
  const buffer = await response.arrayBuffer();
  const usesGpu = providers.some((provider) => provider === 'webgpu' || provider?.name === 'webgpu');
  return ort.InferenceSession.create(buffer, {
    executionProviders: providers,
    graphOptimizationLevel: 'all',
    enableMemPattern: !usesGpu,
    executionMode: 'sequential',
    logSeverityLevel: 3,
    preferredOutputLocation: usesGpu ? 'cpu' : undefined
  });
}

async function trySession(url, providers) {
  const session = await createOnnx(url, providers);
  const blank = new Float32Array(3 * MODEL.inputSize * MODEL.inputSize);
  await infer(session, blank);
  await infer(session, blank);
  return session;
}

async function createEngine() {
  gpuHandle = await acquireGpu();
  if (gpuHandle.adapter) ort.env.webgpu.adapter = gpuHandle.adapter;

  const gpuProviders = webgpuProviders();
  const attempts = [];
  if (gpuHandle.adapter) {
    attempts.push(
      { url: FP32_URL, providers: gpuProviders, kind: 'cf', backend: 'WebGPU', precision: 'fp32' }
    );
  }
  attempts.push(
    { url: FP32_URL, providers: ['wasm'], kind: 'cf', backend: 'WebAssembly', precision: 'fp32' }
  );
  if (gpuHandle.adapter) {
    attempts.push(
      { url: WEB_URL, providers: gpuProviders, kind: 'web', backend: 'WebGPU', precision: 'q8' }
    );
  }
  attempts.push(
    { url: WEB_URL, providers: ['wasm'], kind: 'web', backend: 'WebAssembly', precision: 'q8' }
  );

  let lastError = gpuHandle.error ? new Error(gpuHandle.error) : null;
  let visual;
  for (const attempt of attempts) {
    try {
      const session = await trySession(attempt.url, attempt.providers);
      visual = { session, ...attempt };
      break;
    } catch (error) {
      lastError = error;
      if (attempt.backend === 'WebGPU' && !gpuHandle.error) {
        gpuHandle.error = humanizeError(error);
      }
    }
  }
  if (!visual) throw lastError || new Error('No usable ONNX backend.');

  const threads = ort.env.wasm.numThreads;
  const backend = visual.backend === 'WebGPU'
    ? 'WebGPU'
    : threads > 1
      ? `CPU (WebAssembly, ${threads} threads)`
      : 'CPU (WebAssembly)';
  modelState = emptyState('ready', {
    backend,
    precision: visual.precision,
    adapter: gpuHandle.name || (visual.backend === 'WebGPU' ? 'GPU' : null),
    webHead: visual.kind === 'web',
    threads,
    gpuHint: gpuFallbackHint({
      backend,
      adapterName: gpuHandle.name,
      gpuError: visual.backend === 'WebGPU' ? null : gpuHandle.error
    })
  });

  const engine = {
    cfSession: visual.kind === 'cf' ? visual.session : null,
    webSession: visual.kind === 'web' ? visual.session : null,
    webProviders: visual.backend === 'WebGPU' ? gpuProviders : ['wasm'],
    async ensureWeb() {
      if (engine.webSession) return engine.webSession;
      try {
        engine.webSession = await trySession(WEB_URL, engine.webProviders);
      } catch {
        try { engine.webSession = await trySession(WEB_URL, ['wasm']); } catch { engine.webSession = null; }
      }
      modelState = { ...modelState, webHead: Boolean(engine.webSession) };
      return engine.webSession;
    }
  };
  return engine;
}

async function analyzeImage({
  source,
  displaySrc,
  fallbackDataUrl,
  pixelBuffer,
  pixelWidth,
  pixelHeight,
  naturalWidth,
  naturalHeight,
  requestId,
  dualView,
  encodedPeek,
  fetchedBytes
}) {
  const renderedUrl = displaySrc || source;
  const host = inspectOwnHost(renderedUrl);
  if (host.evidence.length) {
    return finish({
      requestId,
      startedAt: performance.now(),
      fused: { score: HOST_AI_SCORE, source: 'host', cf: null, web: null },
      cfRaw: null,
      webRaw: null,
      viewsUsed: 0,
      skippedModel: true,
      encoded: { format: '', evidence: host.evidence, watermarks: [], provenance: [], camera: null },
      width: Number(naturalWidth) || 0,
      height: Number(naturalHeight) || 0
    });
  }

  const encoded = { format: '', evidence: [], watermarks: [], provenance: [], camera: null };
  if (encodedPeek) {
    encoded.format = encodedPeek.format || '';
    encoded.evidence.push(...(encodedPeek.evidence || []));
    encoded.watermarks = encodedPeek.watermarks || [];
    encoded.provenance = encodedPeek.provenance || [];
    encoded.camera = encodedPeek.camera || null;
  }
  if (fileEvidence(encoded).length) {
    return finish({
      requestId,
      startedAt: performance.now(),
      fused: { score: FILE_AI_SCORE, source: 'metadata', cf: null, web: null },
      cfRaw: null,
      webRaw: null,
      viewsUsed: 0,
      skippedModel: true,
      encoded,
      width: Number(naturalWidth) || 0,
      height: Number(naturalHeight) || 0
    });
  }
  const havePayloadPixels = usablePixels(pixelBuffer, pixelWidth, pixelHeight);
  const bytesPromise = havePayloadPixels
    ? Promise.resolve(null)
    : readImageBytesOptional(fetchableUrls(renderedUrl, fallbackDataUrl));

  return withModelSlot(async () => {
    const engine = await getEngine();
    const startedAt = performance.now();
    const { cfSession } = engine;
    const prepared = await prepareImageData({
      pixelBuffer,
      pixelWidth,
      pixelHeight,
      encoded,
      bytesPromise,
      fetchedBytes
    });

    const width = prepared.bitmapWidth || Number(naturalWidth) || prepared.width;
    const height = prepared.bitmapHeight || Number(naturalHeight) || prepared.height;

    if (!cfSession && !engine.webSession) {
      throw new Error('The local detector model could not be started.');
    }

    let cfRaw = null;
    let webRaw = null;
    let viewsUsed = 0;

    const inferPromise = cfSession
      ? inferFromImage(cfSession, prepared.imageData, 'clip')
      : engine.ensureWeb().then((session) => {
        if (!session) throw new Error('The local detector model could not be started.');
        return inferFromImage(session, prepared.imageData, 'imagenet');
      });

    const metaPromise = bytesPromise.then((fetched) => {
      if (fetched) applyFileInspection(encoded, fetched.buffer, fetched.mimeType);
      return fetched;
    }).catch(() => null);

    cfRaw = await inferPromise;
    if (cfSession) viewsUsed += 1;
    else {
      viewsUsed += 1;
      webRaw = cfRaw;
      cfRaw = null;
    }

    if (!fileEvidence(encoded).length && cfRaw != null && cfRaw > 0.08 && cfRaw < 0.55) {
      await Promise.race([metaPromise, delay(12)]);
    }

    if (fileEvidence(encoded).length && (cfRaw == null || cfRaw < 0.55)) {
      return finish({
        requestId,
        startedAt,
        fused: { score: FILE_AI_SCORE, source: 'metadata', cf: cfRaw, web: webRaw },
        cfRaw,
        webRaw,
        viewsUsed,
        skippedModel: false,
        encoded,
        width,
        height
      });
    }

    if (cfSession && shouldRunWebHead(cfRaw, width, height, {
      dualView,
      fileMetadata: fileEvidence(encoded).length > 0
    })) {
      const webSession = await engine.ensureWeb();
      if (webSession) {
        webRaw = await inferFromImage(webSession, prepared.imageData, 'imagenet');
        viewsUsed += 1;
      }
    }

    const fused = fuseModelScores({ cfRaw, webRaw, encoded });
    return finish({
      requestId,
      startedAt,
      fused,
      cfRaw,
      webRaw,
      viewsUsed,
      skippedModel: false,
      encoded,
      width,
      height
    });
  });
}

function toRgbaBytes(pixelBuffer) {
  if (pixelBuffer instanceof ArrayBuffer) return new Uint8ClampedArray(pixelBuffer);
  if (ArrayBuffer.isView(pixelBuffer)) {
    return new Uint8ClampedArray(pixelBuffer.buffer, pixelBuffer.byteOffset, pixelBuffer.byteLength);
  }
  return null;
}

function usablePixels(pixelBuffer, pixelWidth, pixelHeight) {
  const rgba = toRgbaBytes(pixelBuffer);
  const expected = MODEL.inputSize * MODEL.inputSize * 4;
  if (rgba && rgba.length === expected) return rgba;
  const width = Number(pixelWidth);
  const height = Number(pixelHeight);
  if (rgba && width === MODEL.inputSize && height === MODEL.inputSize && rgba.length === expected) {
    return rgba;
  }
  return null;
}

function applyFileInspection(encoded, buffer, mimeType) {
  const fromBytes = inspectEncodedImage(buffer, mimeType);
  encoded.format = fromBytes.format || encoded.format;
  encoded.evidence.push(...fromBytes.evidence);
  encoded.watermarks = fromBytes.watermarks;
  encoded.provenance = fromBytes.provenance;
  encoded.camera = fromBytes.camera;
}

async function bytesToPrepared(encoded, buffer, mimeType) {
  applyFileInspection(encoded, buffer, mimeType);
  const blob = new Blob([buffer], { type: mimeType || 'image/jpeg' });
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
    .catch(() => createImageBitmap(blob));
  try {
    return {
      imageData: await rasterizeToImageData(bitmap, 'official'),
      width: bitmap.width,
      height: bitmap.height,
      bitmapWidth: bitmap.width,
      bitmapHeight: bitmap.height
    };
  } finally {
    bitmap.close();
  }
}

function fetchableUrls(...candidates) {
  return candidates.filter((url) => url && /^(https?:|data:)/i.test(url));
}

async function prepareImageData({
  pixelBuffer,
  pixelWidth,
  pixelHeight,
  encoded,
  bytesPromise,
  fetchedBytes
}) {
  const rgba = usablePixels(pixelBuffer, pixelWidth, pixelHeight);
  if (rgba) {
    encoded.format = encoded.format || 'rgba';
    return {
      imageData: { data: rgba, width: MODEL.inputSize, height: MODEL.inputSize },
      width: MODEL.inputSize,
      height: MODEL.inputSize
    };
  }

  if (fetchedBytes?.buffer) {
    return bytesToPrepared(encoded, fetchedBytes.buffer, fetchedBytes.mimeType);
  }

  const fetched = await bytesPromise;
  if (fetched) return bytesToPrepared(encoded, fetched.buffer, fetched.mimeType);

  throw new Error('The image could not be read. It may be protected by the website.');
}

function delay(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readImageBytesOptional(candidates) {
  for (const candidate of candidates) {
    const read = await tryReadImageBytes(candidate);
    if (read) return read;
  }
  return null;
}

async function inferFromImage(session, imageData, profile) {
  const tensor = acquireTensor();
  imageDataToNchw(imageData, tensor.data, profile);
  try {
    const outputs = await Promise.race([
      session.run({ [session.inputNames[0]]: tensor }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Infer timed out.')), 12000))
    ]);
    const output = outputs[session.outputNames[0]];
    const data = output.location && output.location !== 'cpu' && output.getData
      ? await output.getData()
      : output.data;
    return sigmoid(Number(data[0]));
  } catch (error) {
    if (/timed out|lost|GPU/i.test(String(error?.message || error))) {
      enginePromise = undefined;
    }
    throw error;
  } finally {
    releaseTensor(tensor);
  }
}

function finish({ requestId, startedAt, fused, cfRaw, webRaw, viewsUsed, skippedModel, encoded, width, height }) {
  return {
    ok: true,
    requestId,
    score: fused.score,
    modelScore: cfRaw,
    webScore: webRaw,
    fuseSource: fused.source,
    viewsUsed,
    skippedModel,
    model: WEB_HEAD.id && webRaw != null ? `${MODEL.id}+${WEB_HEAD.id}` : MODEL.id,
    backend: modelState.backend,
    precision: modelState.precision,
    adapter: modelState.adapter,
    format: encoded.format,
    dimensions: { width, height },
    evidence: [...encoded.evidence, ...encoded.watermarks, ...encoded.provenance],
    watermarks: encoded.watermarks,
    provenance: encoded.provenance,
    elapsedMs: Math.round(performance.now() - startedAt)
  };
}

async function infer(session, values) {
  const tensor = acquireTensor();
  tensor.data.set(values);
  try {
    const outputs = await Promise.race([
      session.run({ [session.inputNames[0]]: tensor }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Infer timed out.')), 12000))
    ]);
    const output = outputs[session.outputNames[0]];
    const data = output.location && output.location !== 'cpu' && output.getData
      ? await output.getData()
      : output.data;
    return sigmoid(Number(data[0]));
  } catch (error) {
    if (/timed out|lost|GPU/i.test(String(error?.message || error))) {
      enginePromise = undefined;
    }
    throw error;
  } finally {
    releaseTensor(tensor);
  }
}

async function tryReadImageBytes(candidate) {
  if (!candidate) return null;
  try {
    const response = await fetch(candidate, { credentials: 'omit', cache: 'force-cache' });
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    const mimeType = response.headers?.get?.('content-type') || guessMimeType(candidate);
    return { buffer, mimeType };
  } catch {
    return null;
  }
}

async function readImageBytes(...candidates) {
  for (const candidate of candidates) {
    const read = await tryReadImageBytes(candidate);
    if (read) return read;
  }
  throw new Error('The image could not be read. It may be protected by the website.');
}

function guessMimeType(source = '') {
  if (/\.png(?:$|\?)/i.test(source)) return 'image/png';
  if (/\.webp(?:$|\?)/i.test(source)) return 'image/webp';
  if (/\.avif(?:$|\?)/i.test(source)) return 'image/avif';
  if (/\.gif(?:$|\?)/i.test(source)) return 'image/gif';
  return 'image/jpeg';
}

function humanizeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/ConvInteger|not find an implementation/i.test(message)) {
    return 'This Chrome build cannot run the quantized weights. Reload the extension and try again — Veil will use a different local model.';
  }
  if (/Failed to get GPU adapter|WebGPU is not supported|no GPU adapter|GPU device request/i.test(message)) {
    return 'This Chrome window did not expose a GPU adapter.';
  }
  if (/not found|404|no available backend|failed to fetch|no such file/i.test(message)) {
    return `The local detector model could not be loaded. ${message}`;
  }
  return message;
}
