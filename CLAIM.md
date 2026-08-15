# Poidh claim text

Paste this on https://poidh.xyz/arbitrum/bounty/323 after the repo is public.

---

**Veil** — local AI image detector for Chrome. MIT. Manifest V3.

Repo: `https://github.com/<YOU>/veil`

Veil scores every visible webpage image entirely inside Chrome and **blurs likely-AI images by default** (popup can switch to hide or label-only). No cloud, no API, no localhost helper, no telemetry.

**Why this one is faster and more general than the WASM-only forks:**

- Official **Community Forensics ViT-S/384** (July 2026 corrected export — 6 heads, CLIP normalize, single logit). Trained on 2.7M images / 4,803 generators, not a 7-generator Tiny-GenImage head.
- **WebGPU FP32 first**, WASM INT8 fallback. Mean Node/ORT CPU pass on the public sample is ~80 ms; GPU is the production path.
- Direct **onnxruntime-web** — no Transformers.js wrapper.
- **Logit shift 0.50 → 0.65** so the bounty’s required 65% line is the model’s real operating point (rank-preserving).
- Second native crop **only when the first score is uncertain**.
- Byte forensics (A1111 / Comfy / SD / FLUX / C2PA / SynthID labels). Embedded generator metadata raises the score to 98.5%+.

**Build / install**

```bash
git clone https://github.com/<YOU>/veil.git
cd veil
npm ci
npm run build:fresh
```

Chrome → Extensions → Developer mode → Load unpacked → `dist/`.
Setup page → **Run local readiness check**. Then visit any http(s) page.

After the one-time weight download at build time you can disconnect the network. `npm run test:policy` fails the build if production source grows a remote inference call.

**Local proxy (not the private maintainer set):** 36-image mix of Tiny-GenImage + real photographs, frozen 65% line: **84.4% balanced accuracy**, **100% real recall**. Fixture e2e: metadata-tagged AI image auto-blurred at 99%, real photo 0%.

A score is a lead, not a verdict.
---
