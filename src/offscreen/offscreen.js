import * as ort from 'onnxruntime-web/webgpu';
import { MESSAGE, MODEL, UNCERTAIN_HIGH, UNCERTAIN_LOW } from '../shared/constants.js';
import { calibrateDecisionScore, sigmoid } from '../analysis/calibrate.js';
import { computePixelSignals, fuseEvidence, inspectEncodedImage } from '../analysis/forensics.js';
import { downscaleForPixels, prepareViews } from '../analysis/preprocess.js';

const WASM_DIR = chrome.runtime.getURL('wasm/');
const FP32_URL = chrome.runtime.getURL(`models/${MODEL.id}/${MODEL.fp32File}`);
const INT8_URL = chrome.runtime.getURL(`models/${MODEL.id}/${MODEL.int8File}`);

let sessionPromise;
let modelState = { state: 'cold', backend: 'none', precision: null, error: null };

configureOrt();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === MESSAGE.OFFSCREEN_ANALYZE) {
    analyzeImage(message.payload).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: humanizeError(error) });
    });
    return true;
  }
  if (message.type === MESSAGE.WARM_MODEL) {
    getSession().then(() => sendResponse({ ok: true, ...modelState })).catch((error) => {
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

async function getSession() {
  if (!sessionPromise) {
    modelState = { state: 'loading', backend: 'none', precision: null, error: null };
    sessionPromise = createSession().catch((error) => {
      sessionPromise = undefined;
      modelState = { state: 'error', backend: 'none', precision: null, error: humanizeError(error) };
      throw error;
    });
  }
  return sessionPromise;
}

async function createSession() {
  const attempts = [
    { url: FP32_URL, providers: ['webgpu'], backend: 'WebGPU', precision: 'fp32' },
    { url: FP32_URL, providers: ['wasm'], backend: 'WebAssembly', precision: 'fp32' },
    { url: INT8_URL, providers: ['wasm'], backend: 'WebAssembly', precision: 'int8' }
  ];

  let lastError;
  for (const attempt of attempts) {
    try {
      const session = await ort.InferenceSession.create(attempt.url, {
        executionProviders: attempt.providers,
        graphOptimizationLevel: 'all',
        enableMemPattern: true,
        executionMode: 'sequential'
      });
      modelState = {
        state: 'ready',
        backend: attempt.backend,
        precision: attempt.precision,
        error: null,
        inputName: session.inputNames[0],
        outputName: session.outputNames[0]
      };
      return session;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('No usable ONNX backend.');
}

async function analyzeImage({ source, fallbackDataUrl, requestId, dualView = true }) {
  const startedAt = performance.now();
  const { buffer, mimeType } = await readImageBytes(source, fallbackDataUrl);
  const encoded = inspectEncodedImage(buffer, mimeType);

  const blob = new Blob([buffer], { type: mimeType || 'image/jpeg' });
  const bitmap = await createImageBitmap(blob);
  const session = await getSession();

  const views = await prepareViews(bitmap, false);
  const officialScore = await infer(session, views.official);
  let modelScore = officialScore;
  let viewsUsed = 1;

  const uncertain = officialScore > UNCERTAIN_LOW && officialScore < UNCERTAIN_HIGH;
  if (dualView && uncertain && Math.min(bitmap.width, bitmap.height) >= MODEL.inputSize) {
    const nativeViews = await prepareViews(bitmap, true);
    if (nativeViews.native) {
      const nativeScore = await infer(session, nativeViews.native);
      modelScore = (officialScore + nativeScore) / 2;
      viewsUsed = 2;
    }
  }

  let pixel = { adjustment: 0, signals: [] };
  if (uncertain || encoded.evidence.length === 0) {
    pixel = computePixelSignals(await downscaleForPixels(bitmap));
  }
  bitmap.close();

  const uncalibrated = fuseEvidence(modelScore, encoded, pixel);
  const score = calibrateDecisionScore(
    uncalibrated,
    MODEL.calibration.rawThreshold,
    MODEL.calibration.displayThreshold
  );

  return {
    ok: true,
    requestId,
    score,
    modelScore,
    officialScore,
    viewsUsed,
    model: MODEL.id,
    backend: modelState.backend,
    precision: modelState.precision,
    format: encoded.format,
    dimensions: { width: views.width, height: views.height },
    evidence: [...encoded.evidence, ...encoded.watermarks, ...encoded.provenance, ...pixel.signals],
    watermarks: encoded.watermarks,
    provenance: encoded.provenance,
    elapsedMs: Math.round(performance.now() - startedAt)
  };
}

async function infer(session, tensor) {
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const feeds = {
    [inputName]: new ort.Tensor('float32', tensor, [1, 3, MODEL.inputSize, MODEL.inputSize])
  };
  const outputs = await session.run(feeds);
  const data = outputs[outputName].data;
  return sigmoid(Number(data[0]));
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
