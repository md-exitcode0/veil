import * as ort from 'onnxruntime-web/webgpu';
import { MESSAGE, MODEL, UNCERTAIN_HIGH, UNCERTAIN_LOW } from '../shared/constants.js';
import { calibrateDecisionScore, sigmoid } from '../analysis/calibrate.js';
import { computePixelSignals, fuseEvidence, inspectEncodedImage } from '../analysis/forensics.js';
import { downscaleForPixels, rasterizeView } from '../analysis/preprocess.js';

const WASM_DIR = chrome.runtime.getURL('wasm/');
const FP32_URL = chrome.runtime.getURL(`models/${MODEL.id}/${MODEL.fp32File}`);
const INT8_URL = chrome.runtime.getURL(`models/${MODEL.id}/${MODEL.int8File}`);
const SHAPE = [1, 3, MODEL.inputSize, MODEL.inputSize];

let sessionPromise;
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

function enqueue(work) {
  const run = runQueue.then(work, work);
  runQueue = run.then(() => undefined, () => undefined);
  return run;
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
    { url: INT8_URL, providers: ['wasm'], backend: 'WebAssembly', precision: 'int8' },
    { url: FP32_URL, providers: ['wasm'], backend: 'WebAssembly', precision: 'fp32' }
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
      reusedTensor = new ort.Tensor('float32', new Float32Array(3 * MODEL.inputSize * MODEL.inputSize), SHAPE);
      modelState = {
        state: 'ready',
        backend: attempt.backend,
        precision: attempt.precision,
        error: null,
        inputName: session.inputNames[0],
        outputName: session.outputNames[0]
      };
      await infer(session, reusedTensor.data);
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

  if (encoded.evidence.length > 0) {
    const score = calibrateDecisionScore(
      0.985,
      MODEL.calibration.rawThreshold,
      MODEL.calibration.displayThreshold
    );
    return {
      ok: true,
      requestId,
      score,
      modelScore: 0.985,
      officialScore: null,
      viewsUsed: 0,
      skippedModel: true,
      model: MODEL.id,
      backend: modelState.backend,
      precision: modelState.precision,
      format: encoded.format,
      dimensions: { width: 0, height: 0 },
      evidence: [...encoded.evidence, ...encoded.watermarks, ...encoded.provenance],
      watermarks: encoded.watermarks,
      provenance: encoded.provenance,
      elapsedMs: Math.round(performance.now() - startedAt)
    };
  }

  const blob = new Blob([buffer], { type: mimeType || 'image/jpeg' });
  const bitmap = await createImageBitmap(blob);
  const width = bitmap.width;
  const height = bitmap.height;
  const session = await getSession();
  const minSide = Math.min(width, height);
  const fastGpu = modelState.backend === 'WebGPU';

  const official = await rasterizeView(bitmap, 'official');
  const officialScore = await infer(session, official);
  let modelScore = officialScore;
  let viewsUsed = 1;

  const uncertain = officialScore > UNCERTAIN_LOW && officialScore < UNCERTAIN_HIGH;
  const maybeMissedAi = officialScore < 0.08 && minSide >= 384;
  const wantSecond = dualView && minSide >= MODEL.inputSize && (uncertain || (fastGpu && maybeMissedAi));

  if (wantSecond) {
    const native = await rasterizeView(bitmap, 'native');
    const nativeScore = await infer(session, native);
    modelScore = (officialScore + nativeScore) / 2;
    viewsUsed = 2;
    if (fastGpu && maybeMissedAi && modelScore < 0.08) {
      const flipped = await rasterizeView(bitmap, 'flip');
      const flipScore = await infer(session, flipped);
      modelScore = (officialScore + nativeScore + flipScore) / 3;
      viewsUsed = 3;
    }
  }

  let pixel = { adjustment: 0, signals: [] };
  if (uncertain) {
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
    skippedModel: false,
    model: MODEL.id,
    backend: modelState.backend,
    precision: modelState.precision,
    format: encoded.format,
    dimensions: { width, height },
    evidence: [...encoded.evidence, ...encoded.watermarks, ...encoded.provenance, ...pixel.signals],
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
