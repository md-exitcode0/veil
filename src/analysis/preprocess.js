import { MODEL } from '../shared/constants.js';

const SIZE = MODEL.inputSize;
const PLANE = SIZE * SIZE;

const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(SIZE, SIZE) : null;
const tensorScratch = new Float32Array(3 * PLANE);

export async function prepareViews(bitmap, wantNative) {
  const official = await rasterizeView(bitmap, 'official');
  const native = wantNative && Math.min(bitmap.width, bitmap.height) >= MODEL.inputSize
    ? await rasterizeView(bitmap, 'native')
    : null;
  return { official, native, width: bitmap.width, height: bitmap.height };
}

export async function rasterizeView(bitmap, mode) {
  const target = canvas || new OffscreenCanvas(SIZE, SIZE);
  const context = target.getContext('2d', { willReadFrequently: true, alpha: false });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.setTransform(1, 0, 0, 1, 0, 0);

  if (mode === 'native') {
    const crop = Math.min(bitmap.width, bitmap.height);
    const sx = Math.floor((bitmap.width - crop) / 2);
    const sy = Math.floor((bitmap.height - crop) / 2);
    context.drawImage(bitmap, sx, sy, crop, crop, 0, 0, SIZE, SIZE);
  } else if (mode === 'flip') {
    context.setTransform(-1, 0, 0, 1, SIZE, 0);
    await drawOfficial(context, bitmap);
    context.setTransform(1, 0, 0, 1, 0, 0);
  } else if (Math.min(bitmap.width, bitmap.height) < MODEL.resizeShortest) {
    context.drawImage(bitmap, 0, 0, SIZE, SIZE);
  } else {
    await drawOfficial(context, bitmap);
  }

  return imageDataToNchw(context.getImageData(0, 0, SIZE, SIZE));
}

async function drawOfficial(context, bitmap) {
  const scale = MODEL.resizeShortest / Math.min(bitmap.width, bitmap.height);
  const resizedWidth = Math.max(SIZE, Math.round(bitmap.width * scale));
  const resizedHeight = Math.max(SIZE, Math.round(bitmap.height * scale));
  let source = bitmap;
  if (resizedWidth !== bitmap.width || resizedHeight !== bitmap.height) {
    source = await createImageBitmap(bitmap, {
      resizeWidth: resizedWidth,
      resizeHeight: resizedHeight,
      resizeQuality: 'high'
    });
  }
  const sx = Math.floor((source.width - SIZE) / 2);
  const sy = Math.floor((source.height - SIZE) / 2);
  context.drawImage(source, sx, sy, SIZE, SIZE, 0, 0, SIZE, SIZE);
  if (source !== bitmap) source.close();
}

export function imageDataToNchw(imageData, out = new Float32Array(3 * PLANE)) {
  const { data } = imageData;
  const [meanR, meanG, meanB] = MODEL.mean;
  const [stdR, stdG, stdB] = MODEL.std;
  for (let i = 0; i < PLANE; i += 1) {
    const offset = i * 4;
    out[i] = (data[offset] / 255 - meanR) / stdR;
    out[PLANE + i] = (data[offset + 1] / 255 - meanG) / stdG;
    out[2 * PLANE + i] = (data[offset + 2] / 255 - meanB) / stdB;
  }
  return out;
}

export function copyTensor(source) {
  tensorScratch.set(source);
  return tensorScratch;
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
