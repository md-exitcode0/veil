import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
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
  console.log('http', request.url);
  const url = new URL(request.url, 'http://127.0.0.1');
  const file = resolve(fixtureDir, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
  if (!file.startsWith(fixtureDir)) {
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

const launchOptions = {
  headless: false,
  args: [
    `--disable-extensions-except=${dist}`,
    `--load-extension=${dist}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check'
  ]
};

const context = await chromium.launchPersistentContext(userDataDir, launchOptions);
context.on('console', (message) => logs.push(`${message.type()}: ${message.text()}`));
context.on('page', (page) => {
  page.on('console', (message) => logs.push(`${message.type()}: ${message.text()}`));
  page.on('pageerror', (error) => logs.push(`pageerror: ${error.message}`));
});

try {
  console.log('workers', context.serviceWorkers().map((worker) => worker.url()));
  console.log('pages', context.pages().map((item) => item.url()));
  const page = await context.newPage();
  page.on('console', (message) => logs.push(`${message.type()}: ${message.text()}`));
  page.on('pageerror', (error) => logs.push(`pageerror: ${error.message}`));
  page.on('requestfailed', (request) => logs.push(`fail ${request.failure()?.errorText} ${request.url()}`));
  page.on('response', (response) => {
    if (response.status() >= 400) logs.push(`http ${response.status()} ${response.url()}`);
  });
  await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });
  console.log('opened', page.url());
  try {
    await page.waitForSelector('.veil-badge--ai, .veil-badge--real, .veil-badge--error, .veil-badge--loading', { timeout: 30_000 });
  } catch {
    logs.push('timeout waiting for any badge');
  }
  await page.waitForTimeout(8000);
  const snapshot = await page.evaluate(() => ({
    badges: [...document.querySelectorAll('.veil-badge')].map((el) => el.className + ' ' + el.textContent),
    blurred: document.querySelectorAll('img[data-veil-treatment="blur"]').length,
    hidden: document.querySelectorAll('img[data-veil-treatment="hide"]').length,
    overlay: Boolean(document.querySelector('#veil-overlay-layer'))
  }));
  console.log(JSON.stringify(snapshot, null, 2));
  await page.screenshot({ path: resolve('tests/fixture/last-e2e.png'), fullPage: true });
  if (logs.length) console.log('logs:\n' + logs.slice(-40).join('\n'));
  if (!snapshot.overlay) throw new Error('content script did not inject the overlay');
  if (snapshot.badges.length === 0) throw new Error('no badges rendered');
  console.log(`e2e ok: ${snapshot.badges.length} badges, ${snapshot.blurred} blurred`);
} finally {
  await context.close();
  server.close();
}
