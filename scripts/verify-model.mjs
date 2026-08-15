import { createHash } from 'node:crypto';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  MODEL_ASSETS,
  RUNTIME_DESTINATION_ROOT,
  RUNTIME_FILES,
  RUNTIME_SOURCE_ROOT,
  destinationPath
} from './model-files.mjs';

for (const asset of MODEL_ASSETS) {
  const path = destinationPath(asset.relativePath);
  const info = await stat(path);
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  const actual = digest.digest('hex');
  if (actual !== asset.sha256) {
    throw new Error(`Checksum mismatch for ${asset.relativePath}. Expected ${asset.sha256}, got ${actual}.`);
  }
  console.log(`ok ${asset.relativePath} (${formatBytes(info.size)}) ${actual}`);
}

await mkdir(fileURLToPath(RUNTIME_DESTINATION_ROOT), { recursive: true });
let copied = 0;
for (const runtimeFile of RUNTIME_FILES) {
  const source = new URL(runtimeFile, RUNTIME_SOURCE_ROOT);
  if (!existsSync(source)) continue;
  await copyFile(source, new URL(runtimeFile, RUNTIME_DESTINATION_ROOT));
  copied += 1;
  console.log(`runtime ${runtimeFile}`);
}
if (copied === 0) throw new Error('No onnxruntime-web wasm runtime files were copied.');

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
