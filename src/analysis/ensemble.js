import { calibrateDecisionScore } from './calibrate.js';
import { MODEL, WEB_HEAD } from '../shared/constants.js';

/**
 * Combine the official Community Forensics score with the web-stress head.
 * CF generalizes to unseen generators. The web head recovers Midjourney /
 * JPEG-degraded samples CF often under-scores. Metadata still wins.
 */
export function fuseModelScores({ cfRaw, webRaw, encoded }) {
  if (encoded?.evidence?.length) {
    return {
      score: 0.985,
      source: 'metadata',
      cf: null,
      web: null
    };
  }

  const cf = cfRaw == null
    ? null
    : calibrateDecisionScore(cfRaw, MODEL.calibration.rawThreshold, MODEL.calibration.displayThreshold);
  const web = webRaw == null
    ? null
    : calibrateDecisionScore(webRaw, WEB_HEAD.calibration.rawThreshold, WEB_HEAD.calibration.displayThreshold);

  if (cf == null && web == null) return { score: 0.5, source: 'none', cf, web };
  if (cf == null) return { score: web, source: 'web', cf, web };
  if (web == null) return { score: cf, source: 'cf', cf, web };

  let score;
  let source;
  const webSureAi = webRaw >= 0.15 && web >= 0.85;
  if (cf >= 0.78 || webSureAi) {
    score = Math.max(cf, web);
    source = 'max-ai';
  } else if (cf <= 0.22 && web <= 0.40) {
    score = Math.min(cf, web);
    source = 'min-real';
  } else {
    score = 0.62 * cf + 0.38 * web;
    source = 'blend';
  }

  return { score, source, cf, web };
}

export function shouldRunWebHead(cfRaw, width, height) {
  if (cfRaw == null) return true;
  const cf = calibrateDecisionScore(cfRaw, MODEL.calibration.rawThreshold, MODEL.calibration.displayThreshold);
  if (cf >= 0.84) return false;
  const minSide = Math.min(width, height);
  const maxSide = Math.max(width, height);
  const squareish = minSide >= 384 && minSide / maxSide >= 0.82;
  if (cf <= 0.16 && !squareish) return false;
  return true;
}
