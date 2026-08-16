import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, relative, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const dist = resolve('dist');
const fixtureDir = resolve('tests/fixture');
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg'
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const file = resolve(fixtureDir, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
  const rel = relative(fixtureDir, file);
  if (!rel || rel.startsWith('..') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    response.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404).end('not found');
  }
});

await new Promise((done) => server.listen(0, '127.0.0.1', done));
const fixtureUrl = `http://127.0.0.1:${server.address().port}/`;
const userDataDir = await mkdtemp(join(tmpdir(), 'veil-e2e-'));
const logs = [];
const failures = [];

const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: [
    `--disable-extensions-except=${dist}`,
    `--load-extension=${dist}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--ignore-gpu-blocklist',
    '--enable-gpu',
    '--enable-unsafe-webgpu',
    ...(process.platform === 'linux'
      ? ['--enable-features=Vulkan,DefaultANGLEVulkan,VulkanFromANGLE']
      : [])
  ]
});

const onLog = (message) => logs.push(`${message.type()}: ${message.text()}`);
context.on('console', onLog);

try {
  const worker = context.serviceWorkers()[0]
    || await context.waitForEvent('serviceworker', { timeout: 20000 });
  const extensionId = new URL(worker.url()).host;
  console.log('extension', extensionId);

  const options = await context.newPage();
  options.on('console', onLog);
  await options.goto(`chrome-extension://${extensionId}/src/options/options.html`, { waitUntil: 'domcontentloaded' });
  await options.waitForFunction(() => {
    const text = document.getElementById('model-status')?.innerText || '';
    return /Ready|failed|error|WebGPU|WebAssembly|CPU/i.test(text) && !/Loading|Not checked/i.test(text);
  }, null, { timeout: 120000 });
  const status = await options.evaluate(() => document.getElementById('model-status')?.innerText || '');
  console.log('STATUS\n' + status);
  if (!/Ready/i.test(status)) failures.push(`readiness was not ready: ${status}`);

  const page = await context.newPage();
  page.on('console', onLog);
  page.on('pageerror', (error) => logs.push(`pageerror: ${error.message}`));
  await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.veil-badge--ai, .veil-badge--real, .veil-badge--error', { timeout: 45000 });
  await page.waitForFunction(() => !document.querySelector('.veil-badge--loading'), null, { timeout: 60000 });
  await page.waitForTimeout(500);

  const snapshot = await page.evaluate(() => {
    const images = [...document.querySelectorAll('img, [data-veil-score], [class*="bg-cover"]')].map((img) => ({
      alt: img.alt || img.getAttribute('aria-label') || '',
      src: img.currentSrc || img.src || img.getAttribute('style') || '',
      treatment: img.getAttribute('data-veil-treatment'),
      score: img.getAttribute('data-veil-score'),
      source: img.getAttribute('data-veil-source'),
      model: img.getAttribute('data-veil-model'),
      web: img.getAttribute('data-veil-web'),
      complete: img.complete,
      naturalWidth: img.naturalWidth || 0
    }));
    const badges = [...document.querySelectorAll('.veil-badge')].map((el) => ({
      text: el.textContent.replace(/\s+/g, ' ').trim(),
      kind: [...el.classList].find((name) => name.startsWith('veil-badge--'))?.slice('veil-badge--'.length),
      ms: Number(el.dataset.veilElapsed || 0),
      title: el.title
    }));
    return {
      overlay: Boolean(document.querySelector('#veil-overlay-layer')),
      covers: document.querySelectorAll('.veil-cover').length,
      badges,
      images
    };
  });
  console.log(JSON.stringify(snapshot, null, 2));
  await page.screenshot({ path: resolve('tests/fixture/last-e2e.png'), fullPage: true });

  if (!snapshot.overlay) failures.push('content script did not inject the overlay');
  if (snapshot.badges.length === 0) failures.push('no badges rendered');
  if (!snapshot.badges.some((badge) => badge.kind === 'real' || badge.kind === 'ai')) {
    failures.push('no completed score badges');
  }
  const photo = snapshot.images.find((image) => /photograph/i.test(image.alt));
  if (photo && photo.treatment === 'blur') failures.push('real photograph was blurred');
  const photoScored = snapshot.images.find((image) => /photograph/i.test(image.alt));
  if (photoScored && !photoScored.score) failures.push('photograph was not visually scored');
  if (photoScored && photoScored.source === 'metadata') failures.push('photograph was scored by host blacklist');
  const fixtureAi = snapshot.images.find((image) => /fixture AI/i.test(image.alt));
  if (fixtureAi && Number(fixtureAi.score) < 65) {
    failures.push(`fixture AI image was treated as real (${fixtureAi.score}% / ${fixtureAi.source})`);
  }
  const googleTile = snapshot.images.find((image) => /google images tile/i.test(image.alt));
  if (googleTile && googleTile.treatment === 'blur') {
    failures.push('Google Images wrap must not be auto-blurred from the Midjourney URL');
  }
  if (googleTile && googleTile.source === 'metadata') {
    failures.push('Google Images wrap used host blacklist instead of the model');
  }

  const visualMs = snapshot.badges
    .filter((badge) => badge.kind === 'real' || (badge.kind === 'ai' && badge.ms > 0))
    .map((badge) => badge.ms)
    .sort((a, b) => a - b);
  const median = visualMs.length ? visualMs[Math.floor(visualMs.length / 2)] : 0;
  const hot = visualMs.length ? visualMs[visualMs.length - 1] : 0;
  console.log('hot visual ms', visualMs, 'median', median, 'max', hot);
  if (visualMs.length && /WebGPU/i.test(status) && median > 50) {
    failures.push(`hot visual median ${median} ms exceeds 50 ms (${visualMs.join(', ')})`);
  }

  if (failures.length) {
    console.log('logs\n' + logs.slice(-50).join('\n'));
    throw new Error(failures.join('; '));
  }
  console.log(`e2e ok: ${snapshot.badges.length} badges, ${snapshot.images.filter((image) => image.treatment === 'blur').length} blurred`);
} finally {
  await context.close();
  server.close();
}
