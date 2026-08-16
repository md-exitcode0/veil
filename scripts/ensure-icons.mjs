import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const icons = [16, 32, 48, 128].map((size) => join(root, 'public', 'icons', `icon-${size}.png`));
if (icons.every((path) => existsSync(path))) {
  console.log('icons ready');
  process.exit(0);
}

const script = join(here, 'generate-icons.py');
const commands = process.platform === 'win32'
  ? [['py', '-3', script], ['python', script], ['python3', script]]
  : [['python3', script], ['python', script]];

for (const [bin, ...args] of commands) {
  const result = spawnSync(bin, args, { stdio: 'inherit' });
  if (result.status === 0) process.exit(0);
}

console.error('Could not generate icons. Install Python 3 and Pillow, or keep public/icons/*.png in the tree.');
process.exit(1);
