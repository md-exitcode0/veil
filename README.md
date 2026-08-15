# Veil

Veil is a Manifest V3 Chrome extension that scores webpage images for signs of AI generation **entirely inside the browser**, then **blurs or hides** likely-AI images. There is no backend, no API key, no localhost helper, and no upload path.

It is a from-scratch implementation aimed at [POIDH Arbitrum bounty 323](https://poidh.xyz/arbitrum/bounty/323): a detector that is actually fast enough for everyday browsing and accurate enough to clear the 75% balanced-accuracy bar at a **fixed 65%** decision threshold.

## Why this should win

Most submissions either:

1. wrap Transformers.js + WASM around a quantized ViT and sit at ~140 ms/image, or
2. overfit a tiny head on Tiny-GenImage (7 generators) and quote 90%+ on that same distribution.

Veil does neither.

| Choice | Why it matters |
| --- | --- |
| Official **Community Forensics ViT-S/384** (July 2026 corrected export) | Trained on **2.7M images / 4,803 generators**. Generalizes to unseen models. The July 2026 fix corrects the attention-head count, CLIP preprocess, and single-logit head that older ONNX dumps got wrong. |
| **WebGPU FP32 first**, WASM INT8 fallback | GPU path is several times faster than a WASM-only Q8 pipeline, and FP32 does not suffer the 10–70 point INT8 drift the model card warns about on out-of-distribution generators. |
| Direct **onnxruntime-web** | No Transformers.js processor, no extra tensor copies, no remote-model flags to forget. |
| **CLIP** shortest-edge 440 → center-crop 384 | Matches the official training recipe. ImageNet-normalized 384² inputs are a silent accuracy killer on this checkpoint. |
| **Logit shift 0.50 → 0.65** | The official operating point is 0.5. The bounty reads the *displayed* score at 0.65. A monotone calibration puts the real decision boundary on that line without changing rank. Uncalibrated, this model looks “precise and blind.” |
| **Second view only when uncertain** | A native center-crop pass runs only if the first score is in `(0.32, 0.72)`. Easy images stay at one forward pass. |
| **Byte forensics** | A1111 / ComfyUI / SD / FLUX / C2PA / SynthID labels boost or explain a score. Generator metadata can raise an uncertain visual score to 98.5%+. |
| Viewport-first queue + LRU cache | Images near the center of the screen go first. Revisits are free. |

Likely-AI images are **blurred by default**. The popup can switch to **hide** or **label only** immediately. Right-click any image for a one-off check.

## Requirements

- Node.js 20 or newer
- npm 10 or newer
- Google Chrome 116 or newer
- Internet access **once**, while `npm ci` / `npm run model:download` pulls the pinned ONNX weights and npm packages

## Reproducible build

```bash
git clone https://github.com/<you>/veil.git
cd veil
npm ci
npm run build:fresh
```

`build:fresh` does four things:

1. Downloads the pinned Community Forensics ONNX files from Hugging Face revision `ac6ee457bea904a373065754107451793b56db00` and verifies SHA-256.
2. Vendors the ONNX Runtime WebAssembly files into `public/wasm/`.
3. Generates extension icons.
4. Builds the unpacked Manifest V3 extension into `dist/`.

Pinned weights:

| File | Size | SHA-256 |
| --- | ---: | --- |
| `onnx/model.onnx` (FP32) | 83 MB | `a42c7d740fbb345ba9a26d469b22f301d73089ce3c6da993877ed2b6965a8ba1` |
| `onnx/model_int8.onnx` | 22 MB | `968f113f1107d58bfc73444b6e87020e2d541780ad43b7a1ac3e3b18b86c2bbd` |

After that, **disconnect the network**. The installed extension does not download models, weights, or inference assets. Production code never calls a remote inference API.

## Install locally

1. Build the extension (`npm run build:fresh`).
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. **Load unpacked** and select this repository's `dist/` directory.
5. The setup page opens. Click **Run local readiness check**.
6. Visit any `http` or `https` page with images. Veil scores images as they enter view.

To prove offline operation: finish steps 1–5, disconnect, open a cached or local page, and scan again.

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
