import { MODEL, WEB_HEAD } from '../shared/constants.js';

const SIZE = MODEL.inputSize;
const PLANE = SIZE * SIZE;
const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(SIZE, SIZE) : null;

export function officialCropRect(width, height) {
  const short = Math.min(width, height);
  const crop = (SIZE * short) / MODEL.resizeShortest;
  return {
    sx: (width - crop) / 2,
    sy: (height - crop) / 2,
    sw: crop,
    sh: crop
  };
}

export function drawOfficialCrop(context, source, width, height) {
  const { sx, sy, sw, sh } = officialCropRect(width, height);
  context.drawImage(source, sx, sy, sw, sh, 0, 0, SIZE, SIZE);
}

function get2dContext(target) {
  try {
    return target.getContext('2d', { willReadFrequently: true, alpha: false, colorSpace: 'srgb' });
  } catch {
    return target.getContext('2d', { willReadFrequently: true, alpha: false });
  }
}

export async function rasterizeToImageData(bitmap, mode = 'official') {
  const target = canvas || new OffscreenCanvas(SIZE, SIZE);
  const context = get2dContext(target);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
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
    drawOfficialCrop(context, bitmap, width, height);
    context.setTransform(1, 0, 0, 1, 0, 0);
  } else {
    drawOfficialCrop(context, bitmap, width, height);
  }

  return context.getImageData(0, 0, SIZE, SIZE);
}

export async function rasterizeView(bitmap, mode, profile = 'clip') {
  return imageDataToNchw(await rasterizeToImageData(bitmap, mode), undefined, profile);
}

export function imageDataToNchw(imageData, out = new Float32Array(3 * PLANE), profile = 'clip') {
  const { data } = imageData;
  const mean = profile === 'imagenet' ? WEB_HEAD.mean : MODEL.mean;
  const std = profile === 'imagenet' ? WEB_HEAD.std : MODEL.std;
  const scaleR = 1 / (255 * std[0]);
  const scaleG = 1 / (255 * std[1]);
  const scaleB = 1 / (255 * std[2]);
  const biasR = mean[0] / std[0];
  const biasG = mean[1] / std[1];
  const biasB = mean[2] / std[2];
  const planeG = PLANE;
  const planeB = PLANE * 2;
  for (let i = 0, offset = 0; i < PLANE; i += 1, offset += 4) {
    out[i] = data[offset] * scaleR - biasR;
    out[planeG + i] = data[offset + 1] * scaleG - biasG;
    out[planeB + i] = data[offset + 2] * scaleB - biasB;
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
