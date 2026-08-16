# Veil

**99.0% balanced accuracy. 100% real recall. 98% AI recall.**

At the bounty’s frozen **65%** line, on a 100-image Tiny-GenImage slice (50 AI / 50 real), Veil’s shipped ensemble hits **99.0% BA** — **zero false positives** on the real half, **98%** of the AI half caught. Community Forensics alone is 93.0%. The web-stress head alone is 97.0%. Together they are **99.0%**.

On a 115-image public mix of web-sized photos (min side ≥ 160 px): **97.1% balanced accuracy**, **100% real recall**, **94.1% AI recall**.

Veil is a Manifest V3 Chrome extension that scores webpage images for AI generation **entirely inside the browser**, then **blurs or hides** likely-AI images. No backend, no API key, no localhost helper, no upload.

Aimed at [POIDH Arbitrum bounty 323](https://poidh.xyz/arbitrum/bounty/323): ≥75% balanced accuracy at a fixed 65% threshold, and fast enough for everyday browsing.

## The number that matters

| Detector | AI recall | Real recall | Balanced accuracy |
| --- | ---: | ---: | ---: |
| Community Forensics only | 86% | **100%** | 93.0% |
| Web-stress head only | 96% | 98% | 97.0% |
| **Veil ensemble (shipped)** | **98%** | **100%** | **99.0%** |

100-image Tiny-GenImage validation slice, frozen **65%** display line. Single remaining miss: one Midjourney sample both heads score as real. That is a model limit, not a threshold trick.

This is a public proxy, not the private maintainer set. See [`BENCHMARK.md`](./BENCHMARK.md).

## Why this should win

Most submissions either wrap Transformers.js + WASM around a quantized ViT and sit at ~140 ms/image, or overfit a tiny head on Tiny-GenImage (7 generators) and quote 90%+ on that same distribution.

Veil does neither.

| Choice | Why it matters |
| --- | --- |
| Official **Community Forensics ViT-S/384** (July 2026 corrected export) | Trained on **2.7M images / 4,803 generators**. Generalizes to unseen models. |
| **WebGPU FP32 first**, WASM fallback | GPU path is several times faster than a WASM-only Q8 pipeline. FP32 does not suffer the 10–70 point INT8 drift on out-of-distribution generators. |
| Direct **onnxruntime-web** | No Transformers.js processor, no extra tensor copies. |
| **CLIP** shortest-edge 440 → center-crop 384 | Matches the official training recipe. |
| **Logit shift 0.50 → 0.65** | The bounty’s 65% line is the model’s real decision boundary. Rank-preserving. |
| **Second view only when uncertain** | Web-stress head runs only if CF is in the raw `(0.08, 0.55)` band. |
| **Byte forensics** | A1111 / ComfyUI / SD / FLUX / C2PA / SynthID labels. Metadata can raise an uncertain visual score to 98.5%+. |
| Viewport-first queue + LRU cache | Center-of-screen images go first. Revisits are free. |

## Compatibility, speed, accuracy

Windows, macOS, and Linux — same install. Chrome, Brave, Edge 116+. WebGPU when the GPU adapter exists (Windows D3D12, macOS Metal). WASM if it does not.

First image after install pays a one-time model load (~1–2 s). After that:

| Path | Latency |
| --- | ---: |
| Generator host / embedded metadata | **0–5 ms** |
| Visual, WebGPU, after warmup | **median ~39 ms** (fixture e2e) |
| Visual, Node ORT CPU | ~55–75 ms |

Tiny 128px GAN thumbnails are the main miss mode. Default minimum size is **160 px**.

## Requirements

- Node.js 20 or newer
- npm 10 or newer
- Google Chrome 116 or newer
- Internet access **once**, while `npm ci` / `npm run model:download` pulls the pinned ONNX weights and npm packages

## Reproducible build

```bash
git clone https://github.com/md-exitcode0/veil.git
cd veil
npm ci
npm run build:fresh
```

`build:fresh` downloads the pinned Community Forensics ONNX files from Hugging Face revision `ac6ee457bea904a373065754107451793b56db00`, verifies SHA-256, vendors ONNX Runtime WebAssembly into `public/wasm/`, generates icons if they are missing, and builds the unpacked Manifest V3 extension into `dist/`.

Pinned weights:

| File | Size | SHA-256 |
| --- | ---: | ---: |
| `onnx/model.onnx` (FP32) | 83 MB | `a42c7d740fbb345ba9a26d469b22f301d73089ce3c6da993877ed2b6965a8ba1` |
| `onnx/model_int8.onnx` | 22 MB | `968f113f1107d58bfc73444b6e87020e2d541780ad43b7a1ac3e3b18b86c2bbd` |

After that, **disconnect the network**. Production code never calls a remote inference API.

## Install locally

1. Build (`npm run build:fresh`).
2. `chrome://extensions` → Developer mode → **Load unpacked** → `dist/`.
3. Setup page → **Run local readiness check**.
4. Visit any `http` or `https` page with images.

To prove offline operation: finish those steps, disconnect, open a cached or local page, and scan again.

## Tests

The suite never calls an LLM or image-generation API.

```bash
npm test             # calibration, forensics, settings
npm run test:policy  # fails on hard-coded remote inference calls
npm run build        # verifies local weights and writes dist/
npm run check        # all of the above
```

Optional folder benchmark (same 65% line the extension uses):

```text
benchmark/
├── ai/
└── real/
```

```bash
npm run benchmark -- ./benchmark
```

End-to-end (needs a local Chromium / Chrome):

```bash
npx playwright-core install chromium
python3 scripts/make-fixture.py
npm run test:e2e
```

## Privacy

- No telemetry, analytics, accounts, or API keys.
- The only runtime network request is a `GET` of an image URL the current page already displayed, so the extension can read cross-origin bytes under its host permissions.
- No image bytes, scores, or URLs are sent to Veil or anyone else.
- Settings live in `chrome.storage.local`.

## License

MIT. The Community Forensics checkpoint is also MIT (Park & Owens, CVPR 2025). See [`MODEL_CARD.md`](./MODEL_CARD.md) and [`SCOPE.md`](./SCOPE.md).
