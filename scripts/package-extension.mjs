import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

await mkdir('dist-pack', { recursive: true });
execFileSync('zip', ['-r', '-q', '../dist-pack/veil-local-ai-image-detector.zip', '.'], {
  cwd: 'dist',
  stdio: 'inherit'
});
console.log('wrote dist-pack/veil-local-ai-image-detector.zip');
