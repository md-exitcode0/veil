import { MODEL, WEB_HEAD } from '../shared/constants.js';

const SIZE = MODEL.inputSize;
const PLANE = SIZE * SIZE;
const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(SIZE, SIZE) : null;

/**
 * Official geometry without an intermediate 440px bitmap:
 * crop a SIZE * (short/440) window from the center, scale to 384.
 * Same crop as "shortest → 440, then center 384".
 */
export async function rasterizeView(bitmap, mode, profile = 'clip') {
  const target = canvas || new OffscreenCanvas(SIZE, SIZE);
  const context = target.getContext('2d', { willReadFrequently: true, alpha: false });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'medium';
  context.setTransform(1, 0, 0, 1, 0, 0);

  const width = bitmap.width;
  const height = bitmap.height;
  const short = Math.min(width, height);

  if (mode === 'native') {
    const sx = Math.floor((width - short) / 2);
    const sy = Math.floor((height - short) / 2);
    context.drawImage(bitmap, sx, sy, short, short, 0, 0, SIZE, SIZE);
  } else if (mode === 'flip') {
    context.setTransform(-1, 0, 0, 1, SIZE, 0);
    drawOfficial(context, bitmap, width, height, short);
    context.setTransform(1, 0, 0, 1, 0, 0);
  } else if (short < MODEL.resizeShortest) {
    context.drawImage(bitmap, 0, 0, SIZE, SIZE);
  } else {
    drawOfficial(context, bitmap, width, height, short);
  }

  return imageDataToNchw(context.getImageData(0, 0, SIZE, SIZE), undefined, profile);
}

function drawOfficial(context, bitmap, width, height, short) {
  const crop = (SIZE * short) / MODEL.resizeShortest;
  const sx = (width - crop) / 2;
  const sy = (height - crop) / 2;
  context.drawImage(bitmap, sx, sy, crop, crop, 0, 0, SIZE, SIZE);
}

export function imageDataToNchw(imageData, out = new Float32Array(3 * PLANE), profile = 'clip') {
  const { data } = imageData;
  const mean = profile === 'imagenet' ? WEB_HEAD.mean : MODEL.mean;
  const std = profile === 'imagenet' ? WEB_HEAD.std : MODEL.std;
  const [meanR, meanG, meanB] = mean;
  const [stdR, stdG, stdB] = std;
  for (let i = 0; i < PLANE; i += 1) {
    const offset = i * 4;
    out[i] = (data[offset] / 255 - meanR) / stdR;
    out[PLANE + i] = (data[offset + 1] / 255 - meanG) / stdG;
    out[2 * PLANE + i] = (data[offset + 2] / 255 - meanB) / stdB;
  }
  return out;
}

export async function downscaleForPixels(bitmap, maxEdge = 160) {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(8, Math.round(bitmap.width * scale));
  const height = Math.max(8, Math.round(bitmap.height * scale));
  const small = new OffscreenCanvas(width, height);
  const context = small.getContext('2d', { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0, width, height);
  return context.getImageData(0, 0, width, height);
}
