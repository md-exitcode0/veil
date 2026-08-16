import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

await mkdir('dist-pack', { recursive: true });
const zipPath = resolve('dist-pack/veil-local-ai-image-detector.zip');
if (process.platform === 'win32') {
  execFileSync('powershell', [
    '-NoProfile',
    '-Command',
    `Compress-Archive -Path (Join-Path (Get-Location) 'dist\\*') -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`
  ], { stdio: 'inherit' });
} else {
  execFileSync('zip', ['-r', '-q', zipPath, '.'], {
    cwd: 'dist',
    stdio: 'inherit'
  });
}
console.log(`wrote ${zipPath}`);
