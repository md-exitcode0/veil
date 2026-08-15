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

/**
 * Monotone map that places `rawThreshold` on `displayThreshold`.
 * Rank order is preserved. Used so the bounty's required 65% line is the
 * actual operating point of the Community Forensics sigmoid, not a raw cutoff.
 */
export function calibrateDecisionScore(score, rawThreshold = 0.5, displayThreshold = 0.65) {
  const bounded = clamp(Number(score) || 0.5, 1e-6, 1 - 1e-6);
  return clamp(
    sigmoid(logit(bounded) - logit(rawThreshold) + logit(displayThreshold)),
    0.001,
    0.999
  );
}
