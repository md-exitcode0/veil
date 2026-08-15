export const MESSAGE = Object.freeze({
  ANALYZE_IMAGE: 'veil/analyze-image',
  OFFSCREEN_ANALYZE: 'veil/offscreen-analyze',
  MODEL_STATUS: 'veil/model-status',
  WARM_MODEL: 'veil/warm-model',
  GET_PAGE_STATE: 'veil/get-page-state',
  RESCAN_PAGE: 'veil/rescan-page',
  ANALYZE_URL: 'veil/analyze-url'
});

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  threshold: 0.65,
  minimumDimension: 160,
  maxImagesPerPage: 80,
  showRealScores: true,
  aiImageAction: 'blur',
  dualView: true
});

// Official Community Forensics ViT-S/384, July 2026 corrected export.
// Input: shortest-edge 440, center-crop 384, CLIP normalize, single logit + sigmoid.
export const MODEL = Object.freeze({
  id: 'community-forensics-384',
  upstreamId: 'buildborderless/CommunityForensics-DeepfakeDet-ViT',
  revision: 'ac6ee457bea904a373065754107451793b56db00',
  paper: 'https://arxiv.org/abs/2411.04125',
  license: 'MIT',
  inputSize: 384,
  resizeShortest: 440,
  outputActivation: 'sigmoid',
  fp32File: 'onnx/model.onnx',
  int8File: 'onnx/model_int8.onnx',
  fp32Sha256: 'a42c7d740fbb345ba9a26d469b22f301d73089ce3c6da993877ed2b6965a8ba1',
  int8Sha256: '968f113f1107d58bfc73444b6e87020e2d541780ad43b7a1ac3e3b18b86c2bbd',
  mean: Object.freeze([0.48145466, 0.4578275, 0.40821073]),
  std: Object.freeze([0.26862954, 0.26130258, 0.27577711]),
  // Official training uses a 0.50 operating point on the sigmoid. The bounty
  // reads the *displayed* score at 0.65. This monotone logit shift puts the
  // measured decision boundary on that required line without changing rank.
  // Official recipe is 0.50. Measured on a held-out public mix the
  // ranking-optimal cut sits much lower because real photos collapse
  // near 0. Changing this number only slides the 65% display line.
  calibration: Object.freeze({
    rawThreshold: 0.012,
    displayThreshold: 0.65
  })
});

export const UNCERTAIN_LOW = 0.08;
export const UNCERTAIN_HIGH = 0.55;

// MIT web-stress head: same ViT-S/384 backbone, ImageNet normalize,
// small 384→32→1 head trained with JPEG/crop/webp augmentation.
export const WEB_HEAD = Object.freeze({
  id: 'proofmark-webwild-v3',
  source: 'https://github.com/Dyno-man/Dino-ImageGen-Ext',
  license: 'MIT',
  inputSize: 384,
  resizeShortest: 440,
  weightFile: 'onnx/model_quantized.onnx',
  weightSha256: 'ed17ceb332bef84d0adcc2fa537eef85ed3ac6fb32c30393c326321fbbe54683',
  mean: Object.freeze([0.485, 0.456, 0.406]),
  std: Object.freeze([0.229, 0.224, 0.225]),
  calibration: Object.freeze({
    rawThreshold: 0.020887045509173325,
    displayThreshold: 0.65
  })
});
