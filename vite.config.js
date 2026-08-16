import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import { resolve } from 'node:path';
import manifest from './src/manifest.js';

const ortWebgpu = resolve(import.meta.dirname, 'node_modules/onnxruntime-web/dist/ort.webgpu.min.mjs');

export default defineConfig({
  base: './',
  plugins: [crx({ manifest })],
  resolve: {
    alias: {
      'onnxruntime-web/webgpu': ortWebgpu
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    modulePreload: false,
    rollupOptions: {
      input: {
        offscreen: resolve(import.meta.dirname, 'src/offscreen/offscreen.html')
      },
      output: {
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]'
      }
    }
  },
  optimizeDeps: {
    exclude: ['onnxruntime-web']
  }
});
