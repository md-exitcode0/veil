import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

let tracked;
try {
  tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'src', 'scripts'], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean);
} catch {
  tracked = [];
}

if (tracked.length === 0) {
  const { readdir } = await import('node:fs/promises');
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) files.push(...await walk(path));
      else files.push(path);
    }
    return files;
  }
  tracked = [...await walk('src'), ...await walk('scripts')];
}

tracked = tracked.filter((file) => /\.(?:js|mjs|html|css|json)$/.test(file));

const allowedRemote = new Set([
  'scripts/download-model.mjs',
  'scripts/check-policy.mjs',
  'scripts/model-files.mjs'
]);

const forbidden = [
  [/fetch\(\s*['"]https?:/g, 'remote fetch'],
  [/XMLHttpRequest/g, 'XMLHttpRequest'],
  [/api\.openai\.com|api\.anthropic\.com|api\.replicate\.com|fal\.ai\/|stability\.ai\/|huggingface\.co\/api/gi, 'inference service reference']
];

const violations = [];
for (const file of tracked) {
  if (allowedRemote.has(file.replace(/\\/g, '/'))) continue;
  const source = await readFile(file, 'utf8');
  for (const [pattern, label] of forbidden) {
    if (pattern.test(source)) violations.push(`${file}: ${label}`);
    pattern.lastIndex = 0;
  }
}

if (violations.length) {
  console.error(`Privacy policy check failed:\n${violations.map((item) => `  - ${item}`).join('\n')}`);
  process.exit(1);
}
console.log(`Privacy policy check passed across ${tracked.length} source files.`);
