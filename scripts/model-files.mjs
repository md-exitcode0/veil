import { fileURLToPath } from 'node:url';

export const MODEL_ID = 'community-forensics-384';
export const MODEL_REPO = 'buildborderless/CommunityForensics-DeepfakeDet-ViT';
export const MODEL_REVISION = 'ac6ee457bea904a373065754107451793b56db00';
export const MODEL_ROOT = new URL(`../public/models/`, import.meta.url);
export const RUNTIME_DESTINATION_ROOT = new URL('../public/wasm/', import.meta.url);
export const RUNTIME_SOURCE_ROOT = new URL('../node_modules/onnxruntime-web/dist/', import.meta.url);

export const MODEL_ASSETS = [
  {
    relativePath: 'onnx/model.onnx',
    sha256: 'a42c7d740fbb345ba9a26d469b22f301d73089ce3c6da993877ed2b6965a8ba1',
    required: true
  },
  {
    relativePath: 'onnx/model_int8.onnx',
    sha256: '968f113f1107d58bfc73444b6e87020e2d541780ad43b7a1ac3e3b18b86c2bbd',
    required: true
  }
];

export const RUNTIME_FILES = [
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
  'ort-wasm-simd-threaded.asyncify.mjs'
];

export function modelUrl(relativePath) {
  return `https://huggingface.co/${MODEL_REPO}/resolve/${MODEL_REVISION}/${relativePath}`;
}

export function destinationPath(relativePath) {
  return fileURLToPath(new URL(`${MODEL_ID}/${relativePath}`, MODEL_ROOT));
}
