import { calibrateDecisionScore } from './calibrate.js';
import { MODEL, UNCERTAIN_HIGH, UNCERTAIN_LOW, WEB_HEAD } from '../shared/constants.js';

export const FILE_AI_SCORE = 0.985;
export const HOST_AI_SCORE = 0.985;
const CAMERA_CAP = 0.58;
const WEB_RECOVER_RAW = 0.92;

export function fileEvidence(encoded) {
  return (encoded?.evidence || []).filter((item) => item.kind === 'metadata');
}

export function fuseModelScores({ cfRaw, webRaw, encoded }) {
  const fromFile = fileEvidence(encoded);
  const cf = cfRaw == null
    ? null
    : calibrateDecisionScore(cfRaw, MODEL.calibration.rawThreshold, MODEL.calibration.displayThreshold);
  const web = webRaw == null
    ? null
    : calibrateDecisionScore(webRaw, WEB_HEAD.calibration.rawThreshold, WEB_HEAD.calibration.displayThreshold);

  const visual = fuseVisual(cfRaw, webRaw, cf, web);
  if (fromFile.length) {
    if (visual.score == null) {
      return { score: FILE_AI_SCORE, source: 'metadata', cf, web };
    }
    return {
      score: Math.max(visual.score, FILE_AI_SCORE),
      source: visual.score >= FILE_AI_SCORE ? visual.source : 'metadata',
      cf,
      web
    };
  }
  if (encoded?.camera?.found && visual.score != null && visual.score < 0.88) {
    return { score: Math.min(visual.score, CAMERA_CAP), source: 'camera', cf, web };
  }
  if (visual.score == null) return { score: 0.5, source: 'none', cf, web };
  return visual;
}

function fuseVisual(cfRaw, webRaw, cf, web) {
  if (cf == null && web == null) return { score: null, source: 'none', cf, web };
  if (cf == null) return { score: web, source: 'web', cf, web };
  if (web == null) return { score: cf, source: 'cf', cf, web };

  const webRecoversCfMiss = cf <= 0.40
    ? webRaw >= WEB_RECOVER_RAW && web >= 0.93
    : webRaw >= 0.55 && web >= 0.85;

  if (cf >= 0.78 || webRecoversCfMiss) {
    return { score: Math.max(cf, web), source: 'max-ai', cf, web };
  }
  if (cf <= 0.40) return { score: cf, source: 'cf-real', cf, web };
  if (web <= 0.40) return { score: Math.min(cf, web), source: 'min-real', cf, web };
  return { score: 0.78 * cf + 0.22 * web, source: 'blend', cf, web };
}

export function shouldRunWebHead(cfRaw, _width, _height, options = {}) {
  if (options.dualView === false) return false;
  if (cfRaw == null) return true;
  if (options.fileMetadata) return false;
  if (cfRaw >= UNCERTAIN_HIGH) return false;
  if (cfRaw <= UNCERTAIN_LOW) return false;
  return true;
}
