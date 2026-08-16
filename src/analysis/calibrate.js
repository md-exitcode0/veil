export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function logit(value) {
  const bounded = clamp(value, 1e-6, 1 - 1e-6);
  return Math.log(bounded / (1 - bounded));
}

export function sigmoid(value) {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exponential = Math.exp(value);
  return exponential / (1 + exponential);
}

export function calibrateDecisionScore(score, rawThreshold = 0.5, displayThreshold = 0.65) {
  const bounded = clamp(Number(score) || 0.5, 1e-6, 1 - 1e-6);
  const rawCut = clamp(rawThreshold, 1e-6, 1 - 1e-6);
  const displayCut = clamp(displayThreshold, 0.01, 0.99);
  const floor = 0.22;
  if (bounded <= rawCut) {
    return clamp(floor + (bounded / rawCut) * (displayCut - floor), 0.01, 0.999);
  }
  return clamp(
    sigmoid(logit(bounded) - logit(rawCut) + logit(displayCut)),
    displayCut,
    0.999
  );
}
