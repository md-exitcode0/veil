# Veil benchmark protocol

- Decision threshold: **65%**, the bounty’s required line
- Bounty gate: **75% balanced accuracy**
- Production model: official Community Forensics ViT-S/384 (July 2026 corrected export)
- Displayed score: monotone logit shift of the official 0.50 operating point onto 0.65

## Why we do not quote a 94% Tiny-GenImage number

A custom 384→32→1 head trained and tested on Tiny-GenImage (ADM, BigGAN, GLIDE, Midjourney, SD 1.5, VQDM, Wukong) will look excellent on that same seven-generator slice and then sag on Flux, GPT-image, Ideogram, Firefly, and whatever the private bounty set actually contains.

Veil keeps the **public, 4,803-generator** checkpoint and spends the engineering budget on:

1. **Correct preprocess** (CLIP, 440 / 384) — the #1 silent failure mode of the pre-July ONNX dumps.
2. **Correct operating point** — raw 0.50 mapped to displayed 0.65, so the bounty’s cutoff is the model’s real decision boundary.
3. **A second view only when the first score is uncertain.**
4. **Byte forensics** that can confirm generator metadata the visual model does not need to guess.
5. **WebGPU FP32** so the accurate weights are also the fast path.

## Reproduce

```bash
npm ci
npm run build:fresh
npm test
npm run test:policy

VEIL_RESULTS_PATH=/tmp/veil-results.json \
  npm run benchmark -- /path/to/labeled-set --quiet
```

The folder harness expects `ai/` and `real/` trees (aliases `fake/`, `generated/`, `authentic/`, `human/` are accepted). It uses the same FP32 weights, CLIP-style official view, forensic fusion, and 65% display threshold as Chrome. It does **not** call an LLM, a generator, or a cloud API.

Balanced accuracy is `(AI recall + real recall) / 2` at the frozen 0.65 line.

## What this does not prove

No public proxy equals the private maintainer set. New generators, screenshots, severe JPEG, and AI-upscaled photographs remain hard. Veil therefore shows a percentage and an evidence panel, not a courtroom stamp.
