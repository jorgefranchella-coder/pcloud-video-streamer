const crypto = require('node:crypto');

function integerSetting(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (raw !== undefined && !/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function booleanSetting(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === '0') return false;
  if (raw === '1') return true;
  throw new Error(`${name} must be 0 or 1`);
}

function decimalSetting(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (raw !== undefined && !/^(?:\d+)(?:\.\d{1,6})?$/.test(raw)) {
    throw new Error(`${name} must be a decimal number between ${minimum} and ${maximum}`);
  }
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be a decimal number between ${minimum} and ${maximum}`);
  }
  return value;
}

function indexerConfiguration() {
  const mode = process.env.INDEX_MODE;
  if (mode !== undefined && mode !== '' && mode !== 'inventory') {
    throw new Error('INDEX_MODE must be inventory or unset');
  }
  return {
    probe_timeout_ms: integerSetting('PROBE_TIMEOUT_MS', 30000, 1000, 600000),
    max_probes: integerSetting('MAX_PROBES', 50, 0, 1000000),
    retry_failed: booleanSetting('RETRY_FAILED'),
    inventory_only: mode === 'inventory'
  };
}

function visualConfiguration() {
  const videoIdRaw = process.env.VISUAL_VIDEO_ID;
  const videoId = videoIdRaw === undefined || videoIdRaw === ''
    ? null
    : integerSetting('VISUAL_VIDEO_ID', 0, 1, Number.MAX_SAFE_INTEGER);
  const model = (process.env.OPENROUTER_MODEL || 'openrouter/free').trim();
  if (!model || model.length > 200) throw new Error('OPENROUTER_MODEL must contain 1 to 200 characters');
  return {
    visual_model: model,
    max_visual: integerSetting('MAX_VISUAL', 1, 1, 100),
    max_visual_frames: integerSetting('MAX_VISUAL_FRAMES', 4, 1, 8),
    visual_request_timeout_ms: integerSetting('VISUAL_REQUEST_TIMEOUT_MS', 300000, 30000, 600000),
    max_visual_attempts: integerSetting('MAX_VISUAL_ATTEMPTS', 5, 1, 20),
    max_visual_requests_per_day: integerSetting('MAX_VISUAL_REQUESTS_PER_DAY', 0, 0, 5000),
    max_visual_cost_per_month_usd: decimalSetting('MAX_VISUAL_COST_PER_MONTH_USD', 0, 0, 100000),
    max_visual_cost_reserve_per_request_usd: decimalSetting('MAX_VISUAL_COST_RESERVE_PER_REQUEST_USD', 0.05, 0, 1000),
    retry_visual_failed: booleanSetting('RETRY_VISUAL_FAILED'),
    visual_video_id: videoId
  };
}

function faceConfiguration() {
  const modelVersion = (process.env.FACE_MODEL_VERSION || 'opencv-yunet-2023mar-sface-2021dec-v1').trim();
  if (!modelVersion || modelVersion.length > 120) throw new Error('FACE_MODEL_VERSION must contain 1 to 120 characters');
  const sampleInterval = integerSetting('FACE_SAMPLE_INTERVAL_SECONDS', 20, 5, 3600);
  const maxFrames = integerSetting('FACE_MAX_FRAMES_PER_VIDEO', 24, 1, 200);
  const maxDimension = integerSetting('FACE_MAX_DIMENSION', 960, 320, 1920);
  const minFaceSize = integerSetting('FACE_MIN_FACE_SIZE', 48, 20, 512);
  const detectionThreshold = decimalSetting('FACE_DETECTION_THRESHOLD', 0.75, 0.1, 1);
  const suggestionThreshold = decimalSetting('FACE_SUGGESTION_THRESHOLD', 0.5, 0, 1);
  const autoAssignmentThreshold = decimalSetting('FACE_AUTO_ASSIGNMENT_THRESHOLD', 0.75, 0, 1);
  if (suggestionThreshold >= autoAssignmentThreshold) {
    throw new Error('FACE_SUGGESTION_THRESHOLD must be lower than FACE_AUTO_ASSIGNMENT_THRESHOLD');
  }
  const indexParameters = JSON.stringify({ sampleInterval, maxFrames, maxDimension, minFaceSize, detectionThreshold });
  const indexVersion = `${modelVersion}@${crypto.createHash('sha256').update(indexParameters).digest('hex').slice(0, 12)}`;
  return {
    enabled: booleanSetting('FACE_INDEXING_ENABLED'),
    model_version: modelVersion,
    index_version: indexVersion,
    max_videos: integerSetting('FACE_MAX_VIDEOS', 10, 1, 100),
    sample_interval_seconds: sampleInterval,
    max_frames_per_video: maxFrames,
    max_dimension: maxDimension,
    min_face_size: minFaceSize,
    detection_threshold: detectionThreshold,
    suggestion_threshold: suggestionThreshold,
    auto_assignment_threshold: autoAssignmentThreshold,
    auto_assignment_batch_size: integerSetting('FACE_AUTO_ASSIGNMENT_BATCH_SIZE', 1000, 1, 10000),
    retry_failed: booleanSetting('FACE_RETRY_FAILED'),
    video_id: process.env.FACE_VIDEO_ID === undefined || process.env.FACE_VIDEO_ID === ''
      ? null : integerSetting('FACE_VIDEO_ID', 0, 1, Number.MAX_SAFE_INTEGER)
  };
}

module.exports = { indexerConfiguration, visualConfiguration, faceConfiguration };
