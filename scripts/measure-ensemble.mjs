import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import { MODEL, WEB_HEAD } from '../src/shared/constants.js';
import { sigmoid } from '../src/analysis/calibrate.js';
import { inspectEncodedImage } from '../src/analysis/forensics.js';
import { fuseModelScores } from '../src/analysis/ensemble.js';

const require = createRequire(import.meta.url);
const ort = require('onnxruntime-node');

const root = process.argv[2] || '/tmp/veil-bench2';
const cfPath = new URL(`../public/models/${MODEL.id}/${MODEL.fp32File}`, import.meta.url).pathname;
const webPath = new URL(`../public/models/${WEB_HEAD.id}/${WEB_HEAD.weightFile}`, import.meta.url).pathname;

const cfSession = await ort.InferenceSession.create(cfPath, { executionProviders: ['cpu'] });
const webSession = await ort.InferenceSession.create(webPath, { executionProviders: ['cpu'] });

const aiFiles = await collect(join(root, 'ai'));
const realFiles = await collect(join(root, 'real'));
const rows = [];
for (const file of aiFiles) rows.push(await score(file, 'ai'));
for (const file of realFiles) rows.push(await score(file, 'real'));

function stats(pick) {
  const ai = rows.filter((row) => row.label === 'ai');
  const real = rows.filter((row) => row.label === 'real');
  const ar = ai.filter((row) => pick(row) >= 0.65).length / Math.max(1, ai.length);
  const rr = real.filter((row) => pick(row) < 0.65).length / Math.max(1, real.length);
  return { n: rows.length, ai: ai.length, real: real.length, aiRecall: ar, realRecall: rr, ba: (ar + rr) / 2 };
}

const report = {
  cf: stats((row) => row.cfDisplay),
  web: stats((row) => row.webDisplay),
  ensemble: stats((row) => row.ensemble)
};
console.log(JSON.stringify(report, null, 2));
const misses = rows.filter((row) => (row.label === 'ai') !== (row.ensemble >= 0.65));
console.log('ensemble misses', misses.length);
for (const row of misses.slice(0, 16)) {
  console.log(`  ${row.file.split('/').pop()} ${row.label} cf=${row.cfRaw.toFixed(4)} web=${row.webRaw.toFixed(4)} ens=${row.ensemble.toFixed(3)}`);
}

async function score(file, label) {
  const encoded = inspectEncodedImage((await (await import('node:fs/promises')).readFile(file)).buffer, 'image/jpeg');
  const cfRaw = await run(cfSession, file, MODEL.mean, MODEL.std);
  const webRaw = await run(webSession, file, WEB_HEAD.mean, WEB_HEAD.std);
  const fused = fuseModelScores({ cfRaw, webRaw, encoded: { evidence: encoded.evidence } });
  const { calibrateDecisionScore } = await import('../src/analysis/calibrate.js');
  return {
    file,
    label,
    cfRaw,
    webRaw,
    cfDisplay: calibrateDecisionScore(cfRaw, MODEL.calibration.rawThreshold, 0.65),
    webDisplay: calibrateDecisionScore(webRaw, WEB_HEAD.calibration.rawThreshold, 0.65),
    ensemble: fused.score,
    source: fused.source
  };
}

async function run(session, file, mean, std) {
  const meta = await sharp(file).rotate().metadata();
  const width = meta.width || 1;
  const height = meta.height || 1;
  const scale = 440 / Math.min(width, height);
  const rw = Math.max(384, Math.round(width * scale));
  const rh = Math.max(384, Math.round(height * scale));
  const left = Math.floor((rw - 384) / 2);
  const top = Math.floor((rh - 384) / 2);
  const { data } = await sharp(file)
    .rotate()
    .removeAlpha()
    .toColourspace('srgb')
    .resize(rw, rh, { fit: 'fill', kernel: sharp.kernel.cubic })
    .extract({ left, top, width: 384, height: 384 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const plane = 384 * 384;
  const tensor = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i += 1) {
    tensor[i] = (data[i * 3] / 255 - mean[0]) / std[0];
    tensor[plane + i] = (data[i * 3 + 1] / 255 - mean[1]) / std[1];
    tensor[2 * plane + i] = (data[i * 3 + 2] / 255 - mean[2]) / std[2];
  }
  const out = await session.run({
    [session.inputNames[0]]: new ort.Tensor('float32', tensor, [1, 3, 384, 384])
  });
  return sigmoid(Number(out[session.outputNames[0]].data[0]));
}

async function collect(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /\.(png|jpe?g|webp)$/i.test(extname(entry.name)))
      .map((entry) => join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}
