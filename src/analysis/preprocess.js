import { MODEL } from '../shared/constants.js';

/**
 * Two complementary 384×384 views of the same bitmap.
 *
 * official  — paper recipe: shortest edge → 440, center-crop 384
 * native    — center-crop at source aspect, then scale to 384
 *
 * Averaging the two is only done when the first score is uncertain. That
 * keeps the common case to a single forward pass.
 */
export async function prepareViews(bitmap, wantNative) {
  const official = await rasterizeView(bitmap, 'official');
  const native = wantNative && Math.min(bitmap.width, bitmap.height) >= MODEL.inputSize
    ? await rasterizeView(bitmap, 'native')
    : null;
  return { official, native, width: bitmap.width, height: bitmap.height };
}

export async function rasterizeView(bitmap, mode) {
  const size = MODEL.inputSize;
  const canvas = new OffscreenCanvas(size, size);
  const context = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';

  if (mode === 'native') {
    const crop = Math.min(bitmap.width, bitmap.height);
    const sx = Math.floor((bitmap.width - crop) / 2);
    const sy = Math.floor((bitmap.height - crop) / 2);
    context.drawImage(bitmap, sx, sy, crop, crop, 0, 0, size, size);
  } else if (Math.min(bitmap.width, bitmap.height) < MODEL.resizeShortest) {
    // Tiny sources: stretch to 384². Upscaling to 440 and then cropping
    // invents a border the model never saw in training at that scale.
    context.drawImage(bitmap, 0, 0, size, size);
  } else {
    const scale = MODEL.resizeShortest / Math.min(bitmap.width, bitmap.height);
    const resizedWidth = Math.max(size, Math.round(bitmap.width * scale));
    const resizedHeight = Math.max(size, Math.round(bitmap.height * scale));
    let source = bitmap;
    if (resizedWidth !== bitmap.width || resizedHeight !== bitmap.height) {
      source = await createImageBitmap(bitmap, {
        resizeWidth: resizedWidth,
        resizeHeight: resizedHeight,
        resizeQuality: 'high'
      });
    }
    const sx = Math.floor((source.width - size) / 2);
    const sy = Math.floor((source.height - size) / 2);
    context.drawImage(source, sx, sy, size, size, 0, 0, size, size);
    if (source !== bitmap) source.close();
  }

  return imageDataToNchw(context.getImageData(0, 0, size, size));
}

export function imageDataToNchw(imageData) {
  const { data, width, height } = imageData;
  const plane = width * height;
  const tensor = new Float32Array(3 * plane);
  const [meanR, meanG, meanB] = MODEL.mean;
  const [stdR, stdG, stdB] = MODEL.std;
  for (let i = 0; i < plane; i += 1) {
    const offset = i * 4;
    tensor[i] = (data[offset] / 255 - meanR) / stdR;
    tensor[plane + i] = (data[offset + 1] / 255 - meanG) / stdG;
    tensor[2 * plane + i] = (data[offset + 2] / 255 - meanB) / stdB;
  }
  return tensor;
}

export async function downscaleForPixels(bitmap, maxEdge = 192) {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(8, Math.round(bitmap.width * scale));
  const height = Math.max(8, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0, width, height);
  return context.getImageData(0, 0, width, height);
}
