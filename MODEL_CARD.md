# Model card — Veil / Community Forensics ViT-S/384

## Identity

- **Runtime id:** `community-forensics-384`
- **Upstream:** [`buildborderless/CommunityForensics-DeepfakeDet-ViT`](https://huggingface.co/buildborderless/CommunityForensics-DeepfakeDet-ViT)
- **Pinned revision:** `ac6ee457bea904a373065754107451793b56db00`
- **Paper:** Park & Owens, *Community Forensics: Using Thousands of Generators to Train Fake Image Detectors*, CVPR 2025. [arXiv:2411.04125](https://arxiv.org/abs/2411.04125)
- **License:** MIT
- **Architecture:** ViT-Small, `hidden_size=384`, **6** attention heads, 12 layers, `intermediate_size=1536`, `patch_size=16`, `num_labels=1`

This is the **July 2026 corrected** export. Earlier public ONNX dumps of this name used 12 heads, ImageNet normalization, and a 2-class head. Those are the wrong model. Veil refuses to ship them.

## Input

1. RGB
2. Resize **shortest edge to 440**, keep aspect ratio
3. Center-crop **384×384**
4. CLIP normalize  
   mean `[0.48145466, 0.4578275, 0.40821073]`  
   std `[0.26862954, 0.26130258, 0.27577711]`
5. NCHW `float32` tensor `[1, 3, 384, 384]`

## Output

A single logit. `sigmoid(logit)` is P(AI-generated) under the official training recipe. Veil then applies a **monotone logit shift** so the official 0.50 operating point lands on the bounty’s required **0.65** display line.

## Files

| Variant | Path | SHA-256 | Role |
| --- | --- | --- | --- |
| FP32 | `public/models/community-forensics-384/onnx/model.onnx` | `a42c7d740fbb345ba9a26d469b22f301d73089ce3c6da993877ed2b6965a8ba1` | WebGPU primary |
| INT8 | `public/models/community-forensics-384/onnx/model_int8.onnx` | `968f113f1107d58bfc73444b6e87020e2d541780ad43b7a1ac3e3b18b86c2bbd` | WASM fallback |

The upstream card warns that uncalibrated INT8 can diverge from FP32 by 10–70 points on out-of-distribution generators. That is why Veil prefers FP32 on GPU.

## Intended use

Browser-local, non-consequential screening of ordinary webpage images. Not a forensic court instrument. Not a detector of “which generator.” Not trained by Veil; we consume the public MIT checkpoint as-is and add calibration, a second crop on uncertain scores, and byte-level forensics.

## Training data (upstream)

2.7 million images across 4,803 generators, described in the Community Forensics paper. Veil does not redistribute those images.

## Citation

```bibtex
@InProceedings{Park_2025_CVPR,
    author    = {Park, Jeongsoo and Owens, Andrew},
    title     = {Community Forensics: Using Thousands of Generators to Train Fake Image Detectors},
    booktitle = {Proceedings of the Computer Vision and Pattern Recognition Conference (CVPR)},
    month     = {June},
    year      = {2025},
    pages     = {8245-8257}
}
```
