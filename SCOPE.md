# Veil scope

Veil targets POIDH Arbitrum bounty 323, **“local AI challenge: AI image detector for Chrome.”** Rechecked against the live brief on 2026-08-15.

## Acceptance matrix

| Bounty requirement | Implementation | Verification |
| --- | --- | --- |
| MIT open source | Root `LICENSE`; Veil source and the upstream Community Forensics checkpoint are MIT | Inspect repository and `MODEL_CARD.md` |
| Native Manifest V3 | Service worker, content script, popup, options, offscreen inference document | Inspect `dist/manifest.json`; load `dist/` unpacked |
| Browser-local inference | Official CF ViT-S/384 via onnxruntime-web. WebGPU FP32 primary, WASM INT8 fallback | Readiness check; `src/offscreen/offscreen.js` |
| No cloud inference or external API | Production has no inference endpoint, telemetry, API key, or localhost dependency | `npm run test:policy` |
| Offline after setup | Weights and ORT wasm are vendored into `dist/` at build time | Disconnect after `npm run build:fresh` |
| Automatic ordinary-page analysis and treatment | Content script scores visible `<img>` elements; likely-AI images blur by default; hide / label-only in the popup | Manual + `npm run test:e2e` |
| Confidence on every analyzed image | Overlay badge shows a percentage; click opens evidence | Fixture page |
| Watermark / metadata support | Local PNG/JPEG/WebP/AVIF scans for generation parameters, C2PA labels, SynthID labels, known watermark markers | `src/analysis/forensics.test.js` |
| Complete reproducible build/install | Pinned HF revision, SHA-256, `npm ci`, `npm run build:fresh` | `README.md` |
| ≥75% balanced accuracy at 65% | Official CF operating point is mapped onto the required 65% line; dual-view + forensics on hard cases | `BENCHMARK.md`; `npm run benchmark` |

## Bounty threat model

Maintainers build from source in a clean Chrome profile, disable the internet after the initial model fetch, block native localhost APIs, and evaluate at a 65% confidence threshold. Node is a build tool only. The installed extension is JavaScript + ONNX + WebAssembly.

## Deliberate boundaries

- A score is probabilistic evidence, not proof of authorship.
- Invisible watermarks are reported when a **label** is present. Veil does not claim to decode vendor-private watermarks.
- Very small images, Chrome-internal pages, video frames, and canvases are out of scope for v1. Ordinary webpage `<img>` elements are in scope.
- The maintainer benchmark is private. Our public protocol is evidence of method, not a claim that our sample equals theirs.
