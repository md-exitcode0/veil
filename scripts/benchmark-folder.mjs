import { readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import { MODEL } from '../src/shared/constants.js';
import { calibrateDecisionScore, sigmoid } from '../src/analysis/calibrate.js';
import { fuseEvidence, inspectEncodedImage } from '../src/analysis/forensics.js';

const require = createRequire(import.meta.url);
const ort = require('onnxruntime-node');

const root = process.argv[2];
if (!root) {
  console.error('Usage: npm run benchmark -- ./benchmark');
  process.exit(2);
}

const threshold = Number(process.env.VEIL_THRESHOLD || 0.65);
const required = Number(process.env.VEIL_REQUIRED_ACCURACY || 0.75);
const modelPath = process.env.VEIL_MODEL_PATH
  || fileURLToPath(new URL(`../public/models/${MODEL.id}/${MODEL.fp32File}`, import.meta.url));

const session = await ort.InferenceSession.create(modelPath, {
  executionProviders: ['cpu'],
  graphOptimizationLevel: 'all'
});

const aiDir = await findLabelDir(root, ['ai', 'fake', 'synthetic', 'generated']);
const realDir = await findLabelDir(root, ['real', 'authentic', 'human', 'photo']);
if (!aiDir || !realDir) {
  throw new Error('Expected ai/ (or fake/) and real/ folders inside the benchmark root.');
}

const aiFiles = await collectImages(aiDir);
const realFiles = await collectImages(realDir);
const rows = [];

for (const file of aiFiles) rows.push(await scoreFile(file, 'ai'));
for (const file of realFiles) rows.push(await scoreFile(file, 'real'));

const ai = rows.filter((row) => row.label === 'ai');
const real = rows.filter((row) => row.label === 'real');
const aiRecall = ai.filter((row) => row.score >= threshold).length / Math.max(1, ai.length);
const realRecall = real.filter((row) => row.score < threshold).length / Math.max(1, real.length);
const balanced = (aiRecall + realRecall) / 2;
const meanMs = rows.reduce((sum, row) => sum + row.elapsedMs, 0) / Math.max(1, rows.length);

const report = {
  threshold,
  model: MODEL.id,
  counts: { ai: ai.length, real: real.length },
  aiRecall,
  realRecall,
  balancedAccuracy: balanced,
  meanMs
};

if (!process.argv.includes('--quiet')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(
    `BA=${(balanced * 100).toFixed(1)}%  AI=${(aiRecall * 100).toFixed(1)}%  REAL=${(realRecall * 100).toFixed(1)}%  mean=${meanMs.toFixed(0)}ms  n=${rows.length}`
  );
}

if (process.env.VEIL_RESULTS_PATH) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(process.env.VEIL_RESULTS_PATH, JSON.stringify({ report, rows }, null, 2));
}

if (balanced + 1e-9 < required) {
  console.error(`Balanced accuracy ${(balanced * 100).toFixed(1)}% is below the ${(required * 100).toFixed(1)}% gate.`);
  process.exit(1);
}

async function scoreFile(file, label) {
  const started = performance.now();
  const meta = await sharp(file).rotate().metadata();
  const width = meta.width || 0;
  const height = meta.height || 0;
  const short = Math.min(width, height);
  const crop = short < MODEL.resizeShortest
    ? Math.min(width, height)
    : (MODEL.inputSize * short) / MODEL.resizeShortest;
  const left = Math.max(0, Math.floor((width - crop) / 2));
  const top = Math.max(0, Math.floor((height - crop) / 2));
  const extractWidth = Math.min(width, Math.round(crop));
  const extractHeight = Math.min(height, Math.round(crop));
  const { data } = await sharp(file)
    .rotate()
    .removeAlpha()
    .toColourspace('srgb')
    .extract({ left, top, width: extractWidth, height: extractHeight })
    .resize(MODEL.inputSize, MODEL.inputSize, { fit: 'fill', kernel: sharp.kernel.cubic })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const bytes = await readFile(file);
  const encoded = inspectEncodedImage(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    guessMime(file)
  );
  const tensor = cropNormalize(data, MODEL.inputSize, MODEL.inputSize, 0, 0, MODEL.inputSize);
  const feeds = {
    [session.inputNames[0]]: new ort.Tensor('float32', tensor, [1, 3, MODEL.inputSize, MODEL.inputSize])
  };
  const outputs = await session.run(feeds);
  const modelScore = sigmoid(Number(outputs[session.outputNames[0]].data[0]));
  const score = calibrateDecisionScore(
    fuseEvidence(modelScore, encoded, { adjustment: 0 }),
    MODEL.calibration.rawThreshold,
    MODEL.calibration.displayThreshold
  );
  return {
    file,
    label,
    score,
    modelScore,
    format: encoded.format,
    evidence: encoded.evidence.length,
    elapsedMs: performance.now() - started
  };
}

function rasterizeOfficial(rgba, width, height) {
  const scale = MODEL.resizeShortest / Math.min(width, height);
  const rw = Math.max(MODEL.inputSize, Math.round(width * scale));
  const rh = Math.max(MODEL.inputSize, Math.round(height * scale));
  const resized = resizeBilinear(rgba, width, height, rw, rh);
  const sx = Math.floor((rw - MODEL.inputSize) / 2);
  const sy = Math.floor((rh - MODEL.inputSize) / 2);
  return cropNormalize(resized, rw, rh, sx, sy, MODEL.inputSize);
}

function resizeBilinear(src, sw, sh, dw, dh) {
  const channels = src.length / (sw * sh);
  const out = new Uint8Array(dw * dh * channels);
  const xRatio = sw / dw;
  const yRatio = sh / dh;
  for (let y = 0; y < dh; y += 1) {
    const fy = (y + 0.5) * yRatio - 0.5;
    const y0 = Math.max(0, Math.floor(fy));
    const y1 = Math.min(sh - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < dw; x += 1) {
      const fx = (x + 0.5) * xRatio - 0.5;
      const x0 = Math.max(0, Math.floor(fx));
      const x1 = Math.min(sw - 1, x0 + 1);
      const wx = fx - x0;
      const di = (y * dw + x) * channels;
      for (let c = 0; c < channels; c += 1) {
        const v00 = src[(y0 * sw + x0) * channels + c];
        const v10 = src[(y0 * sw + x1) * channels + c];
        const v01 = src[(y1 * sw + x0) * channels + c];
        const v11 = src[(y1 * sw + x1) * channels + c];
        const top = v00 + (v10 - v00) * wx;
        const bot = v01 + (v11 - v01) * wx;
        out[di + c] = Math.round(top + (bot - top) * wy);
      }
    }
  }
  return out;
}

function cropNormalize(src, sw, sh, sx, sy, size) {
  const channels = src.length / (sw * sh);
  const plane = size * size;
  const tensor = new Float32Array(3 * plane);
  const [meanR, meanG, meanB] = MODEL.mean;
  const [stdR, stdG, stdB] = MODEL.std;
  let i = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const si = ((sy + y) * sw + (sx + x)) * channels;
      tensor[i] = (src[si] / 255 - meanR) / stdR;
      tensor[plane + i] = (src[si + 1] / 255 - meanG) / stdG;
      tensor[2 * plane + i] = (src[si + 2] / 255 - meanB) / stdB;
      i += 1;
    }
  }
  return tensor;
}

async function findLabelDir(rootDir, names) {
  const entries = await readdir(rootDir, { withFileTypes: true });
  for (const name of names) {
    const hit = entries.find((entry) => entry.isDirectory() && entry.name.toLowerCase() === name);
    if (hit) return join(rootDir, hit.name);
  }
  return null;
}

async function collectImages(dir) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await collectImages(path));
    else if (/\.(png|jpe?g|webp|avif|gif|bmp)$/i.test(extname(entry.name))) out.push(path);
  }
  out.sort();
  return out;
}

function guessMime(file) {
  const ext = extname(file).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.avif') return 'image/avif';
  return 'image/jpeg';
}


