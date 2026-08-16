import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { MODEL } from '../src/shared/constants.js';
import { imageDataToNchw } from '../src/analysis/preprocess.js';
import { fuseModelScores } from '../src/analysis/ensemble.js';
import { inspectSourceUrl } from '../src/analysis/forensics.js';
import { sigmoid } from '../src/analysis/calibrate.js';

const require = createRequire(import.meta.url);
const ort = require('onnxruntime-node');

const photo = fileURLToPath(new URL('../tests/fixture/photo.jpg', import.meta.url));
const modelPath = fileURLToPath(new URL(`../public/models/${MODEL.id}/${MODEL.fp32File}`, import.meta.url));
const mode = process.argv[2] || 'baseline';
const outPath = process.argv[3];

const session = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] });

const host = inspectSourceUrl('https://cdn.midjourney.com/abc/0_0.png');
const native = await sharp(photo).rotate().removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });

async function officialRgbaFromRaw(raw, width, height) {
  const crop = (MODEL.inputSize * Math.min(width, height)) / MODEL.resizeShortest;
  const left = Math.max(0, Math.floor((width - crop) / 2));
  const top = Math.max(0, Math.floor((height - crop) / 2));
  const cropped = await sharp(raw, { raw: { width, height, channels: 3 } })
    .extract({
      left,
      top,
      width: Math.min(width, Math.round(crop)),
      height: Math.min(height, Math.round(crop))
    })
    .resize(MODEL.inputSize, MODEL.inputSize, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return cropped.data;
}

const readyRgba = await officialRgbaFromRaw(native.data, native.info.width, native.info.height);

async function scoreTensor(rgba) {
  const tensor = imageDataToNchw({ data: rgba, width: MODEL.inputSize, height: MODEL.inputSize }, undefined, 'clip');
  const feeds = { [session.inputNames[0]]: new ort.Tensor('float32', tensor, [1, 3, MODEL.inputSize, MODEL.inputSize]) };
  const outputs = await session.run(feeds);
  const raw = sigmoid(Number(outputs[session.outputNames[0]].data[0]));
  const fused = fuseModelScores({ cfRaw: raw, webRaw: null, encoded: { evidence: host.evidence } });
  return {
    raw,
    score: fused.score,
    source: fused.source,
    skippedModel: false,
    hostForced: fused.source === 'metadata'
  };
}

async function currentPath() {
  const started = performance.now();
  const jpeg = await sharp(native.data, {
    raw: { width: native.info.width, height: native.info.height, channels: 3 }
  }).resize(384, 384, { fit: 'inside' }).jpeg({ quality: 72 }).toBuffer();
  const decoded = await sharp(jpeg).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  const rgba = await officialRgbaFromRaw(decoded.data, decoded.info.width, decoded.info.height);
  const scored = await scoreTensor(rgba);
  return { elapsedMs: performance.now() - started, ...scored };
}

async function fastPath() {
  const started = performance.now();
  const scored = await scoreTensor(readyRgba);
  return { elapsedMs: performance.now() - started, ...scored };
}

const run = mode === 'fast' ? fastPath : currentPath;
await run();
const samples = [];
for (let i = 0; i < 4; i += 1) samples.push(await run());
const report = {
  mode,
  warmDiscarded: true,
  samples,
  meanMs: samples.reduce((sum, row) => sum + row.elapsedMs, 0) / samples.length,
  minMs: Math.min(...samples.map((row) => row.elapsedMs)),
  hostForcedAny: samples.some((row) => row.hostForced),
  belowLine: samples.every((row) => row.score < 0.65)
};
const text = JSON.stringify(report, null, 2);
console.log(text);
if (outPath) await writeFile(outPath, text);
