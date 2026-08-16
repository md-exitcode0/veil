# Poidh claim text

Paste this on https://poidh.xyz/arbitrum/bounty/323 after the repo is public.

---

**Veil** — local AI image detector for Chrome. MIT. Manifest V3.

Repo: https://github.com/md-exitcode0/veil

Veil scores every visible webpage image entirely inside Chrome and **blurs likely-AI images by default** (popup can switch to hide or label-only). No cloud, no API, no localhost helper, no telemetry.

**Why this one is faster and more general than the WASM-only forks:**

- Official **Community Forensics ViT-S/384** (July 2026 corrected export — 6 heads, CLIP normalize, single logit). Trained on 2.7M images / 4,803 generators, not a 7-generator Tiny-GenImage head.
- Cascaded **web-stress head** (MIT) only when Community Forensics is actually uncertain. A CF-real photo cannot be flipped by a weakly-high web score. Official 0.50 operating point mapped onto the 65% line.
- **WebGPU FP32** when Chrome exposes a GPU adapter (Windows / macOS default). Otherwise **threaded WASM**, no flags.
- Direct **onnxruntime-web** — no Transformers.js wrapper.
- Byte forensics (A1111 / Comfy / SD / FLUX / C2PA / SynthID labels). Generator **CDN hosts** short-circuit in a few milliseconds.
- Embedded generator metadata raises the score to 98.5%+.

**Build / install**

```bash
git clone https://github.com/md-exitcode0/veil.git
cd veil
npm ci
npm run build:fresh
```

Chrome → Extensions → Developer mode → Load unpacked → `dist/`.
Setup page → **Run local readiness check**. Then visit any http(s) page.

After the one-time weight download at build time you can disconnect the network. `npm run test:policy` fails the build if production source grows a remote inference call.

**Local proxy (not the private maintainer set):** 100-image Tiny-GenImage slice at the frozen 65% line — **99.0% balanced accuracy**, **100% real recall**, **98% AI recall**. Fixture e2e: SD-metadata AI skips the model and blurs; Midjourney CDN host skips the model and blurs; the real photograph stays well under 65% and is not blurred.

A score is a lead, not a verdict.
---
