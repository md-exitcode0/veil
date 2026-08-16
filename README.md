# Veil

Local AI-image detector for Chrome. It scores every visible image on a page **inside the browser**, then **blurs** likely-AI images. No backend, no API key, no upload.

[![license](https://img.shields.io/badge/license-MIT-2f6f5e)](./LICENSE)

Works in **Chrome, Brave, and Edge 116+** on Windows, macOS, and Linux.

## What you get

- **On-device** Community Forensics ViT-S/384 (2.7M images / 4,803 generators, MIT)
- **WebGPU** first, threaded WASM fallback
- **~40 ms** per image after warmup on a discrete GPU (one forward pass)
- **0–5 ms** for generator CDN hosts and embedded SD / Comfy / A1111 metadata
- Official **0.50 → 65%** operating point, so real photos stay unlabeled
- Blur by default; popup switches to hide or label-only

A score is a lead, not a verdict.

## Install from source

Needs Node.js 20+ and Chrome 116+.

```bash
git clone https://github.com/md-exitcode0/veil.git
cd veil
npm ci
npm run build:fresh
```

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the `dist/` folder
4. Setup page → **Run local readiness check**
5. Visit any `http` or `https` page with images

`build:fresh` downloads the pinned ONNX weights once (SHA-256 checked) and vendors ONNX Runtime WASM. After that you can disconnect. The installed extension never calls a remote inference API.

Windows / macOS / Linux all use the same steps. Chrome on Windows and macOS exposes WebGPU by default. If the GPU adapter is missing, Veil falls back to WASM without extra flags.

## Usage

- Images that cross the **65%** line are blurred
- Click a badge for evidence
- Right-click an image → **Analyze image with Veil**
- Popup: enable/disable, blur / hide / label, threshold

## Tests

```bash
npm test
npm run test:policy
npm run check
```

Optional labeled-folder benchmark (`ai/` + `real/`):

```bash
npm run benchmark -- ./benchmark
```

## How it decides

1. Displayed URL is a known generator host → AI, skip the model
2. Embedded generator metadata (A1111, Comfy, SD, FLUX, C2PA, SynthID labels) → AI, skip the model
3. Otherwise one Community Forensics pass on a CLIP 440→384 crop
4. Second web-stress head only if that score is uncertain
5. Camera EXIF can hold a mid score under the 65% line

See [`BENCHMARK.md`](./BENCHMARK.md) and [`MODEL_CARD.md`](./MODEL_CARD.md).

## Privacy

- No telemetry, accounts, or API keys
- The only runtime network request is a `GET` of an image URL the page already showed
- Pixels never leave the browser
- Settings live in `chrome.storage.local`

## License

MIT. The Community Forensics checkpoint is also MIT (Park & Owens, CVPR 2025).
