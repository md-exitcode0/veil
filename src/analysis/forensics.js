import { clamp, logit, sigmoid } from './calibrate.js';

const AI_MARKERS = [
  ['stable diffusion', 'Stable Diffusion generator metadata'],
  ['automatic1111', 'AUTOMATIC1111 generator metadata'],
  ['comfyui', 'ComfyUI workflow metadata'],
  ['invokeai', 'InvokeAI generator metadata'],
  ['midjourney', 'Midjourney generator metadata'],
  ['dall-e', 'DALL·E generator metadata'],
  ['dalle', 'DALL·E generator metadata'],
  ['openai', 'OpenAI generator metadata'],
  ['adobe firefly', 'Adobe Firefly generator metadata'],
  ['generative fill', 'Generative Fill metadata'],
  ['fooocus', 'Fooocus generator metadata'],
  ['novelai', 'NovelAI generator metadata'],
  ['nai diffusion', 'NovelAI diffusion metadata'],
  ['flux.1', 'FLUX generator metadata'],
  ['flux1', 'FLUX generator metadata'],
  ['ideogram', 'Ideogram generator metadata'],
  ['leonardo.ai', 'Leonardo generator metadata'],
  ['dreamstudio', 'DreamStudio generator metadata'],
  ['diffusion model', 'Diffusion generator metadata'],
  ['positive prompt', 'Generation prompt metadata'],
  ['negative prompt', 'Generation prompt metadata']
];

const WATERMARK_MARKERS = [
  ['synthid', 'Embedded SynthID label (watermark not decoded)'],
  ['invisible-watermark', 'Embedded invisible-watermark label'],
  ['stegano', 'Embedded steganographic-watermark label'],
  ['stealthpng', 'Stealth PNG watermark marker']
];

const PROVENANCE_MARKERS = [
  ['c2pa', 'C2PA provenance manifest'],
  ['content credentials', 'Content Credentials manifest'],
  ['contentcredentials', 'Content Credentials manifest'],
  ['cai:', 'Content Authenticity Initiative metadata']
];

const HEAD_SCAN = 262_144;
const TAIL_SCAN = 65_536;

export function inspectEncodedImage(buffer, mimeType = '') {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const format = detectFormat(bytes, mimeType);
  const chunks = format === 'png' ? parsePngChunks(bytes) : [];
  const searchable = extractSearchableText(bytes, chunks, format);
  const normalized = searchable.toLowerCase();
  const evidence = [];
  const watermarks = [];
  const provenance = [];

  collectMarkers(normalized, AI_MARKERS, evidence, 'metadata');
  collectMarkers(normalized, WATERMARK_MARKERS, watermarks, 'watermark');
  collectMarkers(normalized, PROVENANCE_MARKERS, provenance, 'provenance');

  const hasPromptPayload = /(?:parameters|prompt|workflow)(?:[\s\x00]*[:=])?/i.test(searchable)
    && /(?:steps|sampler|seed|cfg scale|model hash|denoise)/i.test(searchable);
  if (hasPromptPayload) {
    evidence.push({ kind: 'metadata', label: 'Embedded generation parameters', strength: 0.99 });
  }

  if (format === 'png' && chunks.some((chunk) => chunk.type === 'caBX')) {
    provenance.push({ kind: 'provenance', label: 'C2PA PNG assertion box', strength: 0.9 });
  }

  return {
    format,
    byteLength: bytes.byteLength,
    evidence: uniqueSignals(evidence),
    watermarks: uniqueSignals(watermarks),
    provenance: uniqueSignals(provenance)
  };
}

export function computePixelSignals(imageData) {
  const { data, width, height } = imageData;
  if (!data || width < 8 || height < 8) return { adjustment: 0, signals: [] };

  let residualTotal = 0;
  let residualSquared = 0;
  let edgeTotal = 0;
  let saturationCount = 0;
  const histogram = new Uint32Array(32);
  let samples = 0;

  for (let y = 1; y < height - 1; y += 3) {
    for (let x = 1; x < width - 1; x += 3) {
      const index = (y * width + x) * 4;
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      histogram[Math.min(31, luminance >> 3)] += 1;
      const max = r > g ? (r > b ? r : b) : (g > b ? g : b);
      const min = r < g ? (r < b ? r : b) : (g < b ? g : b);
      if (max - min > 150 && max > 210) saturationCount += 1;

      const left = luminanceAt(data, width, x - 1, y);
      const right = luminanceAt(data, width, x + 1, y);
      const up = luminanceAt(data, width, x, y - 1);
      const down = luminanceAt(data, width, x, y + 1);
      const localMean = (left + right + up + down) * 0.25;
      const residual = Math.abs(luminance - localMean);
      residualTotal += residual;
      residualSquared += residual * residual;
      edgeTotal += Math.abs(right - left) + Math.abs(down - up);
      samples += 1;
    }
  }

  if (!samples) return { adjustment: 0, signals: [] };

  let luminanceEntropy = 0;
  for (const count of histogram) {
    if (!count) continue;
    const probability = count / samples;
    luminanceEntropy -= probability * Math.log2(probability);
  }

  const residualMean = residualTotal / samples;
  const residualVariance = residualSquared / samples - residualMean * residualMean;
  const edgeDensity = edgeTotal / samples / 510;
  const saturation = saturationCount / samples;
  const signals = [];
  let adjustment = 0;

  if (residualMean < 4.2 && edgeDensity > 0.055) {
    adjustment += 0.02;
    signals.push({ kind: 'pixels', label: 'Unusually smooth high-detail texture', strength: 0.25 });
  }
  if (residualVariance > 230 && edgeDensity < 0.045) {
    adjustment += 0.015;
    signals.push({ kind: 'pixels', label: 'Irregular synthetic texture residual', strength: 0.2 });
  }
  if (saturation > 0.13 && luminanceEntropy > 4.4) {
    adjustment += 0.01;
    signals.push({ kind: 'pixels', label: 'High chroma distribution', strength: 0.15 });
  }
  if (residualMean > 13 && edgeDensity > 0.12) {
    adjustment -= 0.02;
    signals.push({ kind: 'pixels', label: 'Camera-like sensor texture', strength: 0.2 });
  }

  return {
    adjustment: clamp(adjustment, -0.03, 0.04),
    signals,
    metrics: { residualMean, residualVariance, edgeDensity, saturation, luminanceEntropy }
  };
}

export function fuseEvidence(modelAiScore, encoded, pixel) {
  let score = clamp(Number(modelAiScore) || 0.5, 0.001, 0.999);
  const pixelAdj = pixel?.adjustment || 0;
  if (pixelAdj) score = sigmoid(logit(score) + pixelAdj * 3);

  if (encoded.evidence.length > 0) score = Math.max(score, 0.985);
  return clamp(score, 0.001, 0.999);
}

function detectFormat(bytes, mimeType) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 4) === 'PNG') return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'webp';
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === 'ftyp') return 'avif';
  return mimeType.split('/')[1]?.toLowerCase() || 'unknown';
}

function parsePngChunks(bytes) {
  if (bytes.length < 12) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset, false);
    const type = ascii(bytes, offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || offset + 12 + length > bytes.length) break;
    chunks.push({ type, start: offset + 8, length });
    offset += length + 12;
    if (type === 'IEND') break;
  }
  return chunks;
}

function extractSearchableText(bytes, chunks, format) {
  const decoder = new TextDecoder('latin1');
  const parts = [];
  const head = Math.min(bytes.length, HEAD_SCAN);
  parts.push(decoder.decode(bytes.subarray(0, head)));
  if (bytes.length > HEAD_SCAN + TAIL_SCAN) {
    parts.push(decoder.decode(bytes.subarray(bytes.length - TAIL_SCAN)));
  }

  if (format === 'png') {
    for (const chunk of chunks) {
      if (!['tEXt', 'iTXt', 'zTXt', 'eXIf', 'caBX'].includes(chunk.type)) continue;
      const length = Math.min(chunk.length, 1_000_000);
      parts.push(decoder.decode(bytes.subarray(chunk.start, chunk.start + length)));
    }
  }

  return parts.join('\n');
}

function collectMarkers(haystack, markers, target, kind) {
  for (const [needle, label] of markers) {
    if (haystack.includes(needle)) {
      target.push({ kind, label, strength: kind === 'provenance' ? 0.8 : 0.98 });
    }
  }
}

function uniqueSignals(signals) {
  return [...new Map(signals.map((signal) => [signal.label, signal])).values()];
}

function ascii(bytes, start, end) {
  let text = '';
  for (let i = start; i < end && i < bytes.length; i += 1) text += String.fromCharCode(bytes[i]);
  return text;
}

function luminanceAt(data, width, x, y) {
  const index = (y * width + x) * 4;
  return 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];
}
