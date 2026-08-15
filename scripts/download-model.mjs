import { createHash } from 'node:crypto';
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import {
  MODEL_ASSETS,
  MODEL_ID,
  MODEL_REPO,
  MODEL_REVISION,
  RUNTIME_DESTINATION_ROOT,
  RUNTIME_FILES,
  RUNTIME_SOURCE_ROOT,
  destinationPath,
  modelUrl
} from './model-files.mjs';

await mkdir(fileURLToPath(new URL(`${MODEL_ID}/onnx/`, new URL('../public/models/', import.meta.url))), { recursive: true });

for (const asset of MODEL_ASSETS) {
  const destination = destinationPath(asset.relativePath);
  if (await fileLooksComplete(destination, asset.sha256)) {
    console.log(`cached   ${asset.relativePath}`);
    continue;
  }
  console.log(`download ${asset.relativePath}`);
  await mkdir(dirname(destination), { recursive: true });
  const response = await fetch(modelUrl(asset.relativePath), { redirect: 'follow' });
  if (!response.ok) throw new Error(`Failed to download ${asset.relativePath}: HTTP ${response.status}`);
  await pipeline(response.body, createWriteStream(destination));
  const digest = await sha256File(destination);
  if (digest !== asset.sha256) {
    throw new Error(`Checksum mismatch for ${asset.relativePath}. Expected ${asset.sha256}, got ${digest}.`);
  }
  console.log(`sha256   ${digest}`);
}

await writeFile(
  fileURLToPath(new URL(`${MODEL_ID}/SOURCE.txt`, new URL('../public/models/', import.meta.url))),
  [
    `repo=${MODEL_REPO}`,
    `revision=${MODEL_REVISION}`,
    `downloaded=${new Date().toISOString()}`,
    ...MODEL_ASSETS.map((asset) => `${asset.relativePath}=${asset.sha256}`)
  ].join('\n') + '\n'
);

await copyRuntime();
console.log('model assets ready');

async function copyRuntime() {
  await mkdir(fileURLToPath(RUNTIME_DESTINATION_ROOT), { recursive: true });
  let copied = 0;
  for (const runtimeFile of RUNTIME_FILES) {
    const source = new URL(runtimeFile, RUNTIME_SOURCE_ROOT);
    if (!existsSync(source)) continue;
    await copyFile(source, new URL(runtimeFile, RUNTIME_DESTINATION_ROOT));
    copied += 1;
    console.log(`runtime  ${runtimeFile}`);
  }
  if (copied === 0) {
    throw new Error('onnxruntime-web wasm files were not found. Run npm ci first.');
  }
}

async function fileLooksComplete(path, expected) {
  try {
    const info = await stat(path);
    if (info.size < 1_000_000) return false;
    return (await sha256File(path)) === expected;
  } catch {
    return false;
  }
}

async function sha256File(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}
