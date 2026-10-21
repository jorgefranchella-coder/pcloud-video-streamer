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
    max_visual_attempts: integerSetting('MAX_VISUAL_ATTEMPTS', 5, 1, 20),
    max_visual_requests_per_day: integerSetting('MAX_VISUAL_REQUESTS_PER_DAY', 0, 0, 5000),
    max_visual_cost_per_month_usd: decimalSetting('MAX_VISUAL_COST_PER_MONTH_USD', 0, 0, 100000),
    retry_visual_failed: booleanSetting('RETRY_VISUAL_FAILED'),
    visual_video_id: videoId
  };
}

module.exports = { indexerConfiguration, visualConfiguration };
