import * as ort from 'onnxruntime-web/webgpu';
import { MESSAGE, MODEL, WEB_HEAD } from '../shared/constants.js';
import { sigmoid } from '../analysis/calibrate.js';
import { inspectEncodedImage } from '../analysis/forensics.js';
import { fuseModelScores, shouldRunWebHead } from '../analysis/ensemble.js';
import { rasterizeView } from '../analysis/preprocess.js';

const WASM_DIR = chrome.runtime.getURL('wasm/');
const FP32_URL = chrome.runtime.getURL(`models/${MODEL.id}/${MODEL.fp32File}`);
const INT8_URL = chrome.runtime.getURL(`models/${MODEL.id}/${MODEL.int8File}`);
const WEB_URL = chrome.runtime.getURL(`models/${WEB_HEAD.id}/${WEB_HEAD.weightFile}`);
const SHAPE = [1, 3, MODEL.inputSize, MODEL.inputSize];

let enginePromise;
let reusedTensor;
let runQueue = Promise.resolve();
let modelState = { state: 'cold', backend: 'none', precision: null, error: null };

configureOrt();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === MESSAGE.OFFSCREEN_ANALYZE) {
    enqueue(() => analyzeImage(message.payload)).then(sendResponse).catch((error) => {
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

function configureOrt() {
  ort.env.wasm.wasmPaths = WASM_DIR;
  ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 1);
  ort.env.wasm.simd = true;
  ort.env.wasm.proxy = false;
  ort.env.logLevel = 'error';
}

function enqueue(work) {
  const run = runQueue.then(work, work);
  runQueue = run.then(() => undefined, () => undefined);
  return run;
}

async function getEngine() {
  if (!enginePromise) {
    modelState = { state: 'loading', backend: 'none', precision: null, error: null };
    enginePromise = createEngine().catch((error) => {
      enginePromise = undefined;
      modelState = { state: 'error', backend: 'none', precision: null, error: humanizeError(error) };
      throw error;
    });
  }
  return enginePromise;
}

async function createOnnx(url, providers) {
  return ort.InferenceSession.create(url, {
    executionProviders: providers,
    graphOptimizationLevel: 'all',
    enableMemPattern: true,
    executionMode: 'sequential'
  });
}

async function createEngine() {
  reusedTensor = new ort.Tensor('float32', new Float32Array(3 * MODEL.inputSize * MODEL.inputSize), SHAPE);

  const cfAttempts = [
    { url: FP32_URL, providers: ['webgpu'], backend: 'WebGPU', precision: 'fp32' },
    { url: INT8_URL, providers: ['wasm'], backend: 'WebAssembly', precision: 'int8' }
  ];

  let lastError;
  let cfSession;
  let backend = 'none';
  let precision = null;
  for (const attempt of cfAttempts) {
    try {
      cfSession = await createOnnx(attempt.url, attempt.providers);
      backend = attempt.backend;
      precision = attempt.precision;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!cfSession) throw lastError || new Error('No usable ONNX backend.');

  let webSession = null;
  try {
    webSession = await createOnnx(WEB_URL, backend === 'WebGPU' ? ['webgpu'] : ['wasm']);
  } catch {
    try {
      webSession = await createOnnx(WEB_URL, ['wasm']);
    } catch {
      webSession = null;
    }
  }

  modelState = {
    state: 'ready',
    backend,
    precision,
    webHead: Boolean(webSession),
    error: null
  };

  await infer(cfSession, reusedTensor.data);
  if (webSession) await infer(webSession, reusedTensor.data);
  return { cfSession, webSession };
}

async function analyzeImage({ source, fallbackDataUrl, requestId }) {
  const startedAt = performance.now();
  const { buffer, mimeType } = await readImageBytes(source, fallbackDataUrl);
  const encoded = inspectEncodedImage(buffer, mimeType);

  if (encoded.evidence.length > 0) {
    const fused = fuseModelScores({ cfRaw: null, webRaw: null, encoded });
    return finish({
      requestId,
      startedAt,
      fused,
      cfRaw: null,
      webRaw: null,
      viewsUsed: 0,
      skippedModel: true,
      encoded,
      width: 0,
      height: 0
    });
  }

  const blob = new Blob([buffer], { type: mimeType || 'image/jpeg' });
  const bitmap = await createImageBitmap(blob);
  const width = bitmap.width;
  const height = bitmap.height;
  const { cfSession, webSession } = await getEngine();

  const official = await rasterizeView(bitmap, 'official', 'clip');
  const cfRaw = await infer(cfSession, official);
  let viewsUsed = 1;
  let webRaw = null;

  if (webSession && shouldRunWebHead(cfRaw, width, height)) {
    const webTensor = await rasterizeView(bitmap, 'official', 'imagenet');
    webRaw = await infer(webSession, webTensor);
    viewsUsed += 1;
  }

  bitmap.close();
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
    format: encoded.format,
    dimensions: { width, height },
    evidence: [...encoded.evidence, ...encoded.watermarks, ...encoded.provenance],
    watermarks: encoded.watermarks,
    provenance: encoded.provenance,
    elapsedMs: Math.round(performance.now() - startedAt)
  };
}

async function infer(session, tensor) {
  reusedTensor.data.set(tensor);
  const feeds = { [session.inputNames[0]]: reusedTensor };
  const outputs = await session.run(feeds);
  return sigmoid(Number(outputs[session.outputNames[0]].data[0]));
}

async function readImageBytes(source, fallbackDataUrl) {
  for (const candidate of [source, fallbackDataUrl]) {
    if (!candidate) continue;
    try {
      const response = await fetch(candidate, { credentials: 'omit', cache: 'force-cache' });
      if (!response.ok) continue;
      const buffer = await response.arrayBuffer();
      const mimeType = response.headers?.get?.('content-type') || guessMimeType(candidate);
      return { buffer, mimeType };
    } catch {
      // try the next candidate
    }
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
  if (/not found|404|no available backend|failed to fetch|no such file/i.test(message)) {
    return `The local detector model could not be loaded. ${message}`;
  }
  return message;
}
