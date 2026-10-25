const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const {
  db, buildVisualSearchText, withJobLock, setWorkerConfiguration, setWorkerActivity,
  reserveVisualDailyRequest, getVisualProviderControl, setVisualProviderControl, nativeMetadataSearchText,
  clearVisualProviderControl, getVisualMonthlySpend, getVisualCostEstimate, getAutomationControl
} = require('./metadata-store');
const { visualConfiguration } = require('./config');

const execFileAsync = promisify(execFile);
const VIDEO_ROOT = path.resolve(process.env.VIDEO_ROOT || '/mnt/pcloud/My Videos');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const CONFIG = visualConfiguration();
const MODEL = CONFIG.visual_model;
const API_URL = process.env.OPENROUTER_API_URL || 'https://openrouter.ai/api/v1/chat/completions';
let parsedApiUrl;
try { parsedApiUrl = new URL(API_URL); }
catch { throw new Error('OPENROUTER_API_URL must be a valid HTTPS URL'); }
if (parsedApiUrl.protocol !== 'https:' || parsedApiUrl.username || parsedApiUrl.password) {
  throw new Error('OPENROUTER_API_URL must use HTTPS and must not contain credentials');
}
const PROMPT_VERSION = 'visual-v3';
const MAX_VISUAL = CONFIG.max_visual;
const MAX_VISUAL_FRAMES = CONFIG.max_visual_frames;
const MAX_VISUAL_ATTEMPTS = CONFIG.max_visual_attempts;
const MAX_VISUAL_REQUESTS_PER_DAY = CONFIG.max_visual_requests_per_day;
const MAX_VISUAL_COST_PER_MONTH_USD = CONFIG.max_visual_cost_per_month_usd;
const MAX_VISUAL_COST_RESERVE_PER_REQUEST_USD = CONFIG.max_visual_cost_reserve_per_request_usd;
const RETRY_FAILED = CONFIG.retry_visual_failed;
const TARGET_ID = CONFIG.visual_video_id;

function visualRequestReserveUsd() {
  return getVisualCostEstimate(MODEL, MAX_VISUAL_COST_RESERVE_PER_REQUEST_USD).reserve_usd;
}

function providerConfigurationFingerprint(apiKey) {
  return crypto.createHash('sha256').update(`${API_URL}\0${MODEL}\0${apiKey}`).digest('hex');
}

function sampleTimes(durationMs, maximum = MAX_VISUAL_FRAMES) {
  if (!durationMs || durationMs < 2000 || maximum === 1) return [0];
  const seconds = durationMs / 1000;
  const count = Math.min(maximum, Math.max(2, Math.ceil(seconds / 1800) + 2));
  const times = Array.from({ length: count }, (_, index) =>
    Math.floor(seconds * (0.05 + 0.9 * index / (count - 1))));
  return [...new Set(times)];
}

async function safeVideoPath(relativePath) {
  const fullPath = path.resolve(VIDEO_ROOT, relativePath);
  const realRoot = await fs.promises.realpath(VIDEO_ROOT);
  const realPath = await fs.promises.realpath(fullPath);
  const relative = path.relative(realRoot, realPath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Video path is outside VIDEO_ROOT');
  }
  const stat = await fs.promises.stat(realPath);
  if (!stat.isFile()) throw new Error('Video path is not a file');
  return { fullPath: realPath, stat };
}

async function extractFrame(fullPath, atSeconds) {
  const { stdout } = await execFileAsync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-ss', String(atSeconds), '-i', fullPath,
    '-map', '0:v:0', '-frames:v', '1',
    '-vf', 'scale=768:768:force_original_aspect_ratio=decrease',
    '-q:v', '5', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'
  ], { encoding: 'buffer', maxBuffer: 750000, timeout: 45000 });
  if (!stdout?.length || stdout.length > 700000) throw new Error('Frame extraction returned an invalid image');
  return stdout;
}

function text(value, limit = 500) {
  if (typeof value !== 'string') throw new Error('Invalid model response: expected text');
  return value.trim().slice(0, limit);
}

function normalizeEvidence(items, frames) {
  if (!Array.isArray(items) || items.length > 30) throw new Error('Invalid model response: evidence list');
  return items.map(item => {
    if (!Number.isInteger(item.frame_index) || item.frame_index < 1 || item.frame_index > frames.length) {
      throw new Error('Invalid model response: frame index');
    }
    return { description: text(item.description), at_seconds: frames[item.frame_index - 1].at_seconds };
  });
}

function normalizeResult(result, frames) {
  const list = value => {
    if (!Array.isArray(value) || value.length > 30) throw new Error('Invalid model response: list');
    return value.map(item => text(item, 100));
  };
  return {
    title: text(result.title, 120),
    summary: text(result.summary, 1600),
    events: normalizeEvidence(result.events, frames),
    people: normalizeEvidence(result.people, frames),
    places: list(result.places),
    keywords: list(result.keywords),
    date_clues: normalizeEvidence(result.date_clues, frames),
    uncertainty: text(result.uncertainty, 500)
  };
}

async function persistEvidence(videoId, revision, frames, result) {
  const usedSeconds = [...new Set([
    ...result.people, ...result.events, ...result.date_clues
  ].map(item => item.at_seconds))];
  const frameBySecond = new Map(frames.map(frame => [frame.at_seconds, frame]));
  const evidence = usedSeconds.filter(seconds => frameBySecond.has(seconds)).map(at_seconds => ({ at_seconds }));
  if (!evidence.length) return [];

  const parent = path.join(DATA_DIR, 'evidence', String(videoId));
  const staging = path.join(parent, `.${revision}.tmp`);
  const destination = path.join(parent, revision);
  await fs.promises.mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    for (const { at_seconds } of evidence) {
      await fs.promises.writeFile(path.join(staging, `${at_seconds}.jpg`), frameBySecond.get(at_seconds).image, { mode: 0o600, flag: 'wx' });
    }
    await fs.promises.rename(staging, destination);
    return evidence;
  } catch (error) {
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function removeOldEvidence(videoId, keepRevisions) {
  const parent = path.join(DATA_DIR, 'evidence', String(videoId));
  try {
    const entries = await fs.promises.readdir(parent, { withFileTypes: true });
    await Promise.all(entries.filter(entry => entry.isDirectory() && !keepRevisions.has(entry.name))
      .map(entry => fs.promises.rm(path.join(parent, entry.name), { recursive: true, force: true })));
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`Evidence cleanup failed for video ${videoId}: ${error.message}`);
  }
}

async function readLimitedResponse(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error('Provider response exceeds the allowed size');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8');
}

function summarizeProviderError(body) {
  let detail = String(body).slice(0, 300);
  try {
    const parsed = JSON.parse(body);
    const error = parsed.error;
    if (typeof error?.message === 'string') detail = error.message;
    const funnel = error?.metadata?.routing_funnel;
    if (Array.isArray(funnel) && funnel.length) {
      const stages = funnel.slice(0, 8).map(stage => Object.entries(stage)
        .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
        .map(([key, value]) => `${key}=${String(value).slice(0, 100)}`).join(','))
        .filter(Boolean).join(' > ');
      if (stages) detail += ` [routing_funnel: ${stages}]`;
    }
  } catch { /* Keep a bounded text snippet for non-JSON error bodies. */ }
  return detail.slice(0, 900);
}

function safeRoutingDiagnostics(error) {
  const details = [];
  if (typeof error?.code === 'string' || typeof error?.code === 'number') {
    details.push(`code=${String(error.code).slice(0, 100)}`);
  }
  const metadata = error?.metadata;
  if (metadata && typeof metadata === 'object') {
    const provider = metadata.provider_name || metadata.provider;
    if (typeof provider === 'string') details.push(`provider=${provider.slice(0, 100)}`);
    const funnel = metadata.routing_funnel;
    if (Array.isArray(funnel)) {
      const stages = funnel.slice(0, 5).map(stage => Object.entries(stage || {})
        .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
        .map(([key, value]) => `${key}=${String(value).slice(0, 80)}`).join(','))
        .filter(Boolean).join(' > ');
      if (stages) details.push(`routing_funnel=${stages.slice(0, 500)}`);
    }
  }
  return details.join('; ').slice(0, 700);
}

function summarizeJsonShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return `root=${Array.isArray(value) ? 'array' : typeof value}`;
  return Object.entries(value).slice(0, 30).map(([key, item]) => {
    const type = Array.isArray(item) ? `array${item[0] && typeof item[0] === 'object' ? `{${Object.keys(item[0]).slice(0, 12).join(',')}}` : ''}` : item === null ? 'null' : typeof item;
    return `${key}:${type}`;
  }).join(',').slice(0, 700);
}

function parseJsonObject(textValue) {
  const source = String(textValue || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(source); } catch { /* Try a JSON object surrounded by prose. */ }

  for (let start = source.indexOf('{'); start >= 0; start = source.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < source.length; index++) {
      const char = source[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) {
        try { return JSON.parse(source.slice(start, index + 1)); } catch { break; }
      }
    }
  }
  throw new SyntaxError('No valid JSON object found in model response');
}

function responseDiagnostics(data, message, requestId) {
  const content = message?.content;
  return {
    provider: typeof data.provider === 'string' ? data.provider.slice(0, 100) : null,
    model: typeof data.model === 'string' ? data.model.slice(0, 160) : MODEL,
    request_id: requestId ? String(requestId).slice(0, 160) : null,
    finish_reason: data.choices?.[0]?.finish_reason || null,
    response_id: typeof data.id === 'string' ? data.id.slice(0, 160) : null,
    content_type: Array.isArray(content) ? 'array' : typeof content,
    content_chars: typeof content === 'string' ? content.length
      : Array.isArray(content) ? content.reduce((sum, item) => sum + (typeof item?.text === 'string' ? item.text.length : 0), 0) : 0,
    refusal: typeof message?.refusal === 'string' ? message.refusal.slice(0, 300) : null,
    tool_calls: Array.isArray(message?.tool_calls) ? message.tool_calls.length : 0,
    usage: data.usage || null
  };
}

function combineUsage(first, second) {
  if (!first) return second || {};
  if (!second) return first;
  const result = { ...first, ...second };
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'cost']) {
    const a = Number(first[key]);
    const b = Number(second[key]);
    if (Number.isFinite(a) || Number.isFinite(b)) result[key] = (Number.isFinite(a) ? a : 0) + (Number.isFinite(b) ? b : 0);
  }
  return result;
}

async function describeFrames(frames, apiKey) {
  const requestReserve = visualRequestReserveUsd();
  const content = [{ type: 'text', text: 'Estas son imágenes puntuales del mismo video, en orden temporal. Usa el índice de cada fotograma para respaldar eventos, personas y pistas de fecha.' }];
  for (const [index, frame] of frames.entries()) {
    content.push({ type: 'text', text: `Fotograma ${index + 1}, segundo ${frame.at_seconds}:` });
    content.push({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${frame.image.toString('base64')}`, detail: 'high' }
    });
  }
  const requestCounts = { made: 0 };
  const request = async compact => {
    const monthlySpendBeforeRequest = getVisualMonthlySpend();
    if (MAX_VISUAL_COST_PER_MONTH_USD > 0 &&
        (monthlySpendBeforeRequest >= MAX_VISUAL_COST_PER_MONTH_USD ||
         monthlySpendBeforeRequest + requestReserve * (requestCounts.made + 1) > MAX_VISUAL_COST_PER_MONTH_USD)) {
      const error = new Error('Visual monthly cost reserve exhausted');
      error.code = 'VISUAL_MONTHLY_BUDGET_EXHAUSTED';
      throw error;
    }
    if (!reserveVisualDailyRequest(MAX_VISUAL_REQUESTS_PER_DAY)) {
      const error = new Error('Visual daily request budget exhausted');
      error.code = 'VISUAL_DAILY_BUDGET_EXHAUSTED';
      throw error;
    }
    requestCounts.made++;
    const compactInstruction = ' Responde con un JSON mínimo y válido, sin markdown ni texto fuera del objeto. Limita events a 3 elementos, people a 8, places y keywords a 8 cada uno; descripciones breves. No agregues campos.';
    const systemPrompt = 'Redacta una ficha en español natural basada SOLO en lo visible. Devuelve exclusivamente un objeto JSON válido con estas claves: title, summary, events ({description, frame_index}), people ({description, frame_index}), places (textos), keywords (textos), date_clues ({description, frame_index}) y uncertainty. Todos los textos en español. No inventes diálogos, acciones entre fotogramas, lugares ni fechas. Incluye personas/grupos claramente visibles sin asignar identidades; si hay personas y no se distinguen, dilo brevemente. Deja people vacío solo si no hay personas visibles. Las pistas de fecha requieren texto legible. frame_index debe estar entre 1 y el número de fotogramas.' + (compact ? compactInstruction : ' Mantén todos los campos concisos.');
    let response;
    try {
      response = await fetch(API_URL, {
        method: 'POST',
        redirect: 'error',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content }],
          max_tokens: compact ? 1400 : 2200
        }),
        signal: AbortSignal.timeout(CONFIG.visual_request_timeout_ms)
      });
    } catch (error) {
      const networkError = new Error(error.message || 'Provider request failed');
      networkError.code = 'VISUAL_PROVIDER_NETWORK';
      throw networkError;
    }
    if (!response.ok) {
      const body = await readLimitedResponse(response, 16 * 1024);
      let requestId = response.headers.get('x-request-id') || response.headers.get('x-openrouter-generation-id');
      let diagnostics = '';
      try {
        const parsed = JSON.parse(body);
        diagnostics = safeRoutingDiagnostics(parsed.error);
        requestId ||= typeof parsed.id === 'string' ? parsed.id : null;
      } catch { /* summarizeProviderError keeps a bounded message for non-JSON bodies. */ }
      const error = new Error(`OpenRouter HTTP ${response.status}: ${summarizeProviderError(body)}${requestId ? ` [request_id=${requestId.slice(0, 160)}]` : ''}${diagnostics ? ` [${diagnostics}]` : ''}`);
      error.code = 'OPENROUTER_HTTP_ERROR';
      error.status = response.status;
      error.requestId = requestId || null;
      throw error;
    }
    const responseText = await readLimitedResponse(response, 1024 * 1024);
    let data;
    try { data = JSON.parse(responseText); }
    catch {
      const error = new Error('OpenRouter returned an invalid response envelope');
      error.code = 'VISUAL_INVALID_MODEL_OUTPUT';
      error.responseDiagnostics = {
        model: MODEL,
        request_id: response.headers.get('x-request-id') || response.headers.get('x-openrouter-generation-id') || null,
        response_chars: responseText.length, envelope_json: false
      };
      throw error;
    }
    const message = data.choices?.[0]?.message;
    const requestId = response.headers.get('x-request-id') || response.headers.get('x-openrouter-generation-id') || data.id || null;
    const diagnostics = responseDiagnostics(data, message, requestId);
    if (message?.refusal) {
      const error = new Error(`OpenRouter refusal: ${String(message.refusal).slice(0, 300)}`);
      error.responseDiagnostics = diagnostics;
      throw error;
    }
    const outputText = typeof message?.content === 'string'
      ? message.content
      : Array.isArray(message?.content)
        ? message.content.filter(item => item.type === 'text').map(item => item.text).join('')
        : '';
    if (!outputText) {
      const error = new Error('OpenRouter returned no structured text');
      error.code = 'VISUAL_INVALID_MODEL_OUTPUT';
      error.responseDiagnostics = diagnostics;
      throw error;
    }
    let parsedOutput;
    try { parsedOutput = parseJsonObject(outputText); }
    catch {
      const error = new Error(`Invalid model response: JSON could not be recovered (finish_reason=${diagnostics.finish_reason || 'unknown'}, chars=${diagnostics.content_chars})`);
      error.code = 'VISUAL_INVALID_MODEL_OUTPUT';
      error.responseDiagnostics = diagnostics;
      throw error;
    }
    try {
      return { result: normalizeResult(parsedOutput, frames), usage: data.usage || null, requestId, diagnostics };
    } catch (error) {
      error.code = 'VISUAL_INVALID_MODEL_OUTPUT';
      error.responseDiagnostics = { ...diagnostics, json_shape: summarizeJsonShape(parsedOutput) };
      throw error;
    }
  };

  try {
    return await request(false);
  } catch (firstError) {
    if (firstError.code !== 'VISUAL_INVALID_MODEL_OUTPUT') throw firstError;
    try {
      const recovered = await request(true);
      recovered.usage = combineUsage(firstError.responseDiagnostics?.usage, recovered.usage);
      recovered.diagnostics = { retry: 'compact_reanalysis', first_response: firstError.responseDiagnostics, final_response: recovered.diagnostics };
      return recovered;
    } catch (retryError) {
      if (retryError.code === 'VISUAL_INVALID_MODEL_OUTPUT') {
        retryError.responseDiagnostics = {
          retry: 'compact_reanalysis_failed', first_response: firstError.responseDiagnostics,
          final_response: retryError.responseDiagnostics
        };
      }
      throw retryError;
    }
  }
}

async function analyzeVideo(row, apiKey) {
  const claim = db.prepare(`UPDATE videos SET visual_status = 'running', visual_error = NULL,
      visual_attempts = visual_attempts + 1, visual_next_attempt_at = NULL, visual_error_class = NULL
    WHERE id = ? AND fingerprint = ? AND status = 'done' RETURNING visual_attempts`).get(row.id, row.fingerprint);
  if (!claim) return true;
  const attemptNumber = claim.visual_attempts;
  setWorkerActivity('visual-analyzer', { videoId: row.id, path: row.relative_path, phase: 'extrayendo fotogramas' });
  try {
    const { fullPath, stat } = await safeVideoPath(row.relative_path);
    if (`${stat.size}:${Math.round(stat.mtimeMs)}` !== row.fingerprint) throw new Error('Video changed since inventory; scan it again');
    const frames = [];
    const selectedTimes = sampleTimes(row.duration_ms);
    const sampling = { method: 'duration', sampled_at_seconds: selectedTimes };
    for (const atSeconds of selectedTimes) {
      try {
        frames.push({ at_seconds: atSeconds, image: await extractFrame(fullPath, atSeconds) });
      } catch (error) {
        console.error(`Frame at ${atSeconds}s failed for video ${row.id}: ${error.message}`);
      }
    }
    if (!frames.length) throw new Error('No frames could be extracted');
    if (getAutomationControl().paused) {
      db.prepare(`UPDATE videos SET visual_status = 'pending', visual_attempts = MAX(visual_attempts - 1, 0),
          visual_error = NULL, visual_error_class = NULL, visual_next_attempt_at = NULL
        WHERE id = ? AND fingerprint = ? AND visual_status = 'running'`).run(row.id, row.fingerprint);
      setWorkerActivity('visual-analyzer', {
        phase: 'pausado', videoId: row.id, path: row.relative_path,
        result: 'No se envió el video al proveedor; quedó pendiente para reanudar'
      });
      return true;
    }
    setWorkerActivity('visual-analyzer', { videoId: row.id, path: row.relative_path, phase: 'analizando con el proveedor' });
    const { result, usage, requestId, diagnostics } = await describeFrames(frames, apiKey);
    const finalStat = await fs.promises.stat(fullPath);
    if (`${finalStat.size}:${Math.round(finalStat.mtimeMs)}` !== row.fingerprint) throw new Error('Video changed during analysis');
    const faceAssignedNames = db.prepare(`SELECT DISTINCT people.name FROM face_observations
      JOIN people ON people.id = face_observations.person_id
      WHERE video_id = ? AND fingerprint = ? AND review_status = 'confirmed'`)
      .all(row.id, row.fingerprint).map(item => item.name);
    const searchText = buildVisualSearchText({
      events: result.events, people: result.people, places: result.places,
      keywords: result.keywords, dateClues: result.date_clues,
      confirmedPeople: [...JSON.parse(row.confirmed_people_json), ...faceAssignedNames],
      location: nativeMetadataSearchText(row)
    });
    const revision = crypto.randomUUID();
    let evidence = [];
    try {
      evidence = await persistEvidence(row.id, revision, frames, result);
    } catch (error) {
      console.error(`Evidence storage failed for video ${row.id}: ${error.message}`);
    }
    const persistResult = db.transaction(() => {
      const updated = db.prepare(`UPDATE videos SET visual_status = 'done', visual_title = @title,
      visual_summary = @summary, visual_uncertainty = @uncertainty,
      visual_people_json = @people, visual_events_json = @events,
      visual_places_json = @places, visual_keywords_json = @keywords,
      visual_date_clues_json = @date_clues, visual_search_text = @search_text,
      visual_evidence_json = @evidence, visual_sampling_json = @sampling,
      visual_model = @model, visual_prompt_version = @prompt_version,
      visual_usage_json = @usage, visual_fingerprint = @fingerprint, visual_revision = @revision,
      visual_error = NULL, visual_error_class = NULL, visual_next_attempt_at = NULL,
      visual_analyzed_at = CURRENT_TIMESTAMP
      WHERE id = @id AND fingerprint = @fingerprint`).run({
      id: row.id, fingerprint: row.fingerprint, title: result.title, summary: result.summary,
      uncertainty: result.uncertainty,
      people: JSON.stringify(result.people), events: JSON.stringify(result.events),
      places: JSON.stringify(result.places), keywords: JSON.stringify(result.keywords),
      date_clues: JSON.stringify(result.date_clues), search_text: searchText, model: MODEL,
      sampling: JSON.stringify(sampling),
      evidence: JSON.stringify(evidence), prompt_version: PROMPT_VERSION,
      usage: JSON.stringify(usage || {}), revision
      });
      if (!updated.changes) throw new Error('Video changed in the index during analysis');
    });
    persistResult();
    const pendingRevisions = db.prepare(`SELECT DISTINCT analysis_revision FROM video_person_observations
      WHERE video_id = ? AND reviewed_at IS NULL`).all(row.id).map(item => item.analysis_revision);
    await removeOldEvidence(row.id, new Set([revision, ...pendingRevisions]));
    setWorkerActivity('visual-analyzer', { phase: null, result: `Ficha visual guardada para ${row.relative_path}` });
    console.log(JSON.stringify({ video_id: row.id, frames: frames.length, model: MODEL, usage, request_id: requestId,
      response_diagnostics: diagnostics }));
  } catch (error) {
    if (error.code === 'VISUAL_DAILY_BUDGET_EXHAUSTED') {
      db.prepare(`UPDATE videos SET visual_status = 'pending', visual_attempts = MAX(visual_attempts - 1, 0),
          visual_error = NULL, visual_error_class = NULL, visual_next_attempt_at = NULL
        WHERE id = ? AND fingerprint = ? AND visual_status = 'running'`).run(row.id, row.fingerprint);
      setWorkerActivity('visual-analyzer', {
        phase: 'presupuesto diario agotado', videoId: row.id, path: row.relative_path,
        result: 'Ficha pendiente para el próximo lote, después de las 00:00 UTC'
      });
      return false;
    }
    if (error.code === 'VISUAL_MONTHLY_BUDGET_EXHAUSTED') {
      db.prepare(`UPDATE videos SET visual_status = 'pending', visual_attempts = MAX(visual_attempts - 1, 0),
          visual_error = NULL, visual_error_class = NULL, visual_next_attempt_at = NULL
        WHERE id = ? AND fingerprint = ? AND visual_status = 'running'`).run(row.id, row.fingerprint);
      const spend = getVisualMonthlySpend();
      setWorkerActivity('visual-analyzer', {
        phase: 'reserva de presupuesto mensual agotada', videoId: row.id, path: row.relative_path,
        result: `Costo reportado: USD ${spend.toFixed(4)}; reserva estimada por solicitud: USD ${visualRequestReserveUsd().toFixed(4)}; límite: USD ${MAX_VISUAL_COST_PER_MONTH_USD.toFixed(4)}`
      });
      return false;
    }
    const message = String(error.message).slice(0, 1000);
    const authenticationFailure = /^OpenRouter HTTP (401|403)\b/.test(message);
    const providerRateLimit = /^OpenRouter HTTP 429\b/.test(message);
    const providerServerFailure = /^OpenRouter HTTP 5\d\d\b/.test(message);
    const freeRouterNoCompatibleEndpoint = MODEL === 'openrouter/free' &&
      /^OpenRouter HTTP 404\b/.test(message) && /no endpoints found that can handle the requested parameters/i.test(message);
    const providerConfigurationFailure = /^OpenRouter HTTP 4\d\d\b/.test(message) && !providerRateLimit && !freeRouterNoCompatibleEndpoint;
    const providerRouteUnavailable = providerServerFailure || freeRouterNoCompatibleEndpoint;
    const providerNetworkFailure = error.code === 'VISUAL_PROVIDER_NETWORK';
    const permanentFailure = (/^OpenRouter HTTP 4\d\d\b/.test(message) && !providerRateLimit && !freeRouterNoCompatibleEndpoint) ||
      message.startsWith('OpenRouter refusal:') ||
      message.includes('Video changed');
    const retryable = !permanentFailure;
    const providerTransientFailure = providerRateLimit || providerRouteUnavailable || providerNetworkFailure;
    const exhausted = retryable && !providerTransientFailure && attemptNumber >= MAX_VISUAL_ATTEMPTS;
    const baseDelaySeconds = providerRouteUnavailable ? 3600 : providerRateLimit ? 300 : 60;
    const delaySeconds = retryable && !exhausted
      ? Math.min(baseDelaySeconds * (2 ** Math.min(attemptNumber - 1, 10)), 86400)
      : null;
    const retryAt = delaySeconds == null ? null : new Date(Date.now() + delaySeconds * 1000)
      .toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
    const errorClass = authenticationFailure ? 'provider_auth'
      : providerRateLimit ? 'provider_rate_limit'
        : providerRouteUnavailable ? 'provider_unavailable'
          : exhausted ? 'attempt_limit' : permanentFailure ? 'permanent' : 'transient';
    db.prepare(`UPDATE videos SET visual_status = 'failed',
        visual_attempts = CASE WHEN ? = 1 THEN MAX(visual_attempts - 1, 0) ELSE visual_attempts END,
        visual_error = ?, visual_error_class = ?, visual_next_attempt_at = ?
      WHERE id = ? AND fingerprint = ? AND visual_status = 'running'`)
      .run(providerTransientFailure ? 1 : 0, message, errorClass, retryAt, row.id, row.fingerprint);
    if (authenticationFailure || providerConfigurationFailure || providerRateLimit || providerRouteUnavailable || providerNetworkFailure) {
      const status = message.match(/^OpenRouter HTTP (\d{3})\b/)?.[1];
      const reason = authenticationFailure ? `OpenRouter HTTP ${status}: revisar clave/permisos`
        : providerConfigurationFailure ? `OpenRouter HTTP ${status}: revisar endpoint/modelo/parámetros`
          : providerRateLimit ? 'OpenRouter HTTP 429: cuota o límite de velocidad'
            : providerRouteUnavailable ? freeRouterNoCompatibleEndpoint
              ? 'OpenRouter no tiene endpoints gratuitos compatibles con esta solicitud; se reintentará con espera creciente'
              : `OpenRouter HTTP ${status}: proveedor no disponible`
              : 'Fallo de red al llamar al proveedor';
      const cooldownAt = providerRateLimit || providerRouteUnavailable || providerNetworkFailure
        ? retryAt || new Date(Date.now() + baseDelaySeconds * 1000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')
        : null;
      setVisualProviderControl({
        configurationFingerprint: providerConfigurationFingerprint(apiKey),
        errorClass, reason, pausedUntil: cooldownAt
      });
    }
    setWorkerActivity('visual-analyzer', {
      phase: retryAt ? 'esperando reintento' : 'fallo sin reintento automático',
      videoId: row.id, path: row.relative_path, error: message
    });
    console.error(JSON.stringify({
      event: 'visual_analysis_failed', video_id: row.id, model: MODEL,
      status: error.status || null, request_id: error.requestId || null,
      response_diagnostics: error.responseDiagnostics || null,
      error: String(error.message).slice(0, 1000)
    }));
    if (authenticationFailure || providerConfigurationFailure || providerRateLimit || providerRouteUnavailable || providerNetworkFailure) throw error;
  }
  return true;
}

async function runLocked() {
  if (getAutomationControl().paused) {
    setWorkerActivity('visual-analyzer', { phase: 'pausado', result: 'La automatización está pausada; no se inició un análisis visual' });
    return;
  }
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is required for visual analysis');
  // The exclusive lock proves no visual worker still owns these rows.
  db.prepare(`UPDATE videos SET visual_status = 'failed', visual_error = 'El trabajador se interrumpió durante el análisis',
      visual_error_class = CASE WHEN visual_attempts >= ? THEN 'attempt_limit' ELSE 'worker_interrupted' END,
      visual_next_attempt_at = CASE WHEN visual_attempts >= ? THEN NULL ELSE datetime(CURRENT_TIMESTAMP, '+1 minute') END
    WHERE visual_status = 'running'`).run(MAX_VISUAL_ATTEMPTS, MAX_VISUAL_ATTEMPTS);
  const configFingerprint = providerConfigurationFingerprint(apiKey);
  const providerControl = getVisualProviderControl();
  if (providerControl) {
    if (providerControl.configuration_fingerprint !== configFingerprint) {
      clearVisualProviderControl();
      setWorkerActivity('visual-analyzer', { phase: 'proveedor reactivado', result: 'Cambió clave, modelo o endpoint; se retoma la cola' });
    } else if (MODEL === 'openrouter/free' &&
        ['permanent', 'provider_unavailable'].includes(providerControl.error_class) &&
        /^OpenRouter HTTP 404/.test(providerControl.reason || '') &&
        (!providerControl.paused_until || new Date(`${providerControl.paused_until.replace(' ', 'T')}Z`).getTime() <= Date.now())) {
      db.prepare(`UPDATE videos SET visual_status = 'pending', visual_attempts = MAX(visual_attempts - 1, 0),
          visual_error = NULL, visual_error_class = NULL, visual_next_attempt_at = NULL
        WHERE visual_status = 'failed' AND visual_error_class IN ('permanent', 'provider_unavailable')
          AND visual_error LIKE 'OpenRouter HTTP 404:%No endpoints found that can handle the requested parameters%'`).run();
      clearVisualProviderControl();
      setWorkerActivity('visual-analyzer', { phase: 'reintentando router gratuito', result: 'Se reencolaron las fichas afectadas por el 404 y habrá espera automática si no hay rutas disponibles' });
    } else {
      const pauseUntil = providerControl.paused_until
        ? new Date(`${providerControl.paused_until.replace(' ', 'T')}Z`) : null;
      if (!pauseUntil || pauseUntil.getTime() > Date.now()) {
        const formattedUntil = pauseUntil ? pauseUntil.toISOString() : '';
        setWorkerActivity('visual-analyzer', {
          phase: providerControl.paused_until ? 'proveedor en espera' : 'proveedor pausado',
          result: `${providerControl.reason}${formattedUntil ? ` · hasta ${formattedUntil}` : ' · cambiar clave, modelo o endpoint para reactivar'}`
        });
        console.log(`Visual provider paused: ${providerControl.reason}`);
        return;
      }
      clearVisualProviderControl();
    }
  }
  if (MODEL === 'openrouter/free' && !getVisualProviderControl()) {
    db.prepare(`UPDATE videos SET visual_status = 'pending', visual_attempts = MAX(visual_attempts - 1, 0),
        visual_error = NULL, visual_error_class = NULL, visual_next_attempt_at = NULL
      WHERE visual_status = 'failed' AND visual_error_class IN ('permanent', 'provider_unavailable')
        AND visual_error LIKE 'OpenRouter HTTP 404:%No endpoints found that can handle the requested parameters%'`).run();
  }
  const utcDay = new Date().toISOString().slice(0, 10);
  const monthlySpend = getVisualMonthlySpend();
  const requestReserve = visualRequestReserveUsd();
  if (MAX_VISUAL_COST_PER_MONTH_USD > 0 &&
      (monthlySpend >= MAX_VISUAL_COST_PER_MONTH_USD ||
       monthlySpend + requestReserve > MAX_VISUAL_COST_PER_MONTH_USD)) {
    setWorkerActivity('visual-analyzer', {
      phase: 'presupuesto mensual agotado',
      result: `Costo reportado por el proveedor: USD ${monthlySpend.toFixed(4)} / ${MAX_VISUAL_COST_PER_MONTH_USD.toFixed(4)} este mes`
    });
    console.log(`Visual monthly cost budget exhausted: ${monthlySpend}/${MAX_VISUAL_COST_PER_MONTH_USD} USD`);
    return;
  }
  const usedToday = db.prepare('SELECT request_count FROM visual_daily_requests WHERE utc_day = ?').get(utcDay)?.request_count || 0;
  const dailyRemaining = MAX_VISUAL_REQUESTS_PER_DAY
    ? Math.max(0, MAX_VISUAL_REQUESTS_PER_DAY - usedToday)
    : MAX_VISUAL;
  if (dailyRemaining === 0) {
    setWorkerActivity('visual-analyzer', { phase: 'presupuesto diario agotado', result: `Límite de ${MAX_VISUAL_REQUESTS_PER_DAY} solicitudes alcanzado para ${utcDay} UTC` });
    console.log(`Visual daily request budget exhausted: ${usedToday}/${MAX_VISUAL_REQUESTS_PER_DAY} UTC`);
    return;
  }
  const batchLimit = Math.min(MAX_VISUAL, dailyRemaining);
  let candidates;
  if (Number.isInteger(TARGET_ID) && TARGET_ID > 0) {
    candidates = db.prepare("SELECT id, relative_path, fingerprint, duration_ms, confirmed_people_json FROM videos WHERE id = ? AND status = 'done'").all(TARGET_ID);
  } else {
    const fresh = db.prepare(`SELECT id, relative_path, fingerprint, duration_ms, confirmed_people_json FROM videos
      WHERE status = 'done' AND (visual_status IS NULL OR visual_status = 'pending')
      ORDER BY id LIMIT ?`).all(batchLimit);
    const retries = RETRY_FAILED ? db.prepare(`SELECT id, relative_path, fingerprint, duration_ms, confirmed_people_json FROM videos
      WHERE status = 'done' AND visual_status = 'failed' AND visual_next_attempt_at IS NOT NULL
        AND visual_next_attempt_at <= CURRENT_TIMESTAMP AND visual_attempts < ?
      ORDER BY visual_next_attempt_at, id LIMIT ?`).all(MAX_VISUAL_ATTEMPTS, batchLimit) : [];
    const retryQuota = fresh.length ? Math.min(1, batchLimit) : batchLimit;
    candidates = [...fresh.slice(0, batchLimit - retryQuota), ...retries.slice(0, retryQuota)];
    if (candidates.length < batchLimit) {
      candidates.push(...fresh.slice(batchLimit - retryQuota, batchLimit - retryQuota + batchLimit - candidates.length));
    }
    if (candidates.length < batchLimit) candidates.push(...retries.slice(retryQuota, retryQuota + batchLimit - candidates.length));
  }
  let attempted = 0;
  let completed = 0;
  let failed = 0;
  let stoppedEarly = false;
  for (const row of candidates) {
    if (getAutomationControl().paused) {
      setWorkerActivity('visual-analyzer', { phase: 'pausado', result: 'El lote actual terminó antes de tomar el siguiente video' });
      break;
    }
    const currentSpend = getVisualMonthlySpend();
    const currentReserve = visualRequestReserveUsd();
    if (MAX_VISUAL_COST_PER_MONTH_USD > 0 &&
        (currentSpend >= MAX_VISUAL_COST_PER_MONTH_USD ||
         currentSpend + currentReserve > MAX_VISUAL_COST_PER_MONTH_USD)) {
      setWorkerActivity('visual-analyzer', {
        phase: 'presupuesto mensual agotado',
        result: `Costo reportado por el proveedor: USD ${currentSpend.toFixed(4)} / ${MAX_VISUAL_COST_PER_MONTH_USD.toFixed(4)} este mes`
      });
      break;
    }
    attempted++;
    const shouldContinue = await analyzeVideo(row, apiKey);
    const outcome = db.prepare('SELECT visual_status FROM videos WHERE id = ?').get(row.id)?.visual_status;
    if (outcome === 'done') completed++;
    else if (outcome === 'failed') failed++;
    if (!shouldContinue) {
      stoppedEarly = true;
      break;
    }
  }
  const summary = `Lote visual: ${completed} fichas guardadas, ${failed} errores, ${attempted} videos intentados`;
  if (attempted && !stoppedEarly) setWorkerActivity('visual-analyzer', { phase: null, result: summary });
  console.log(summary);
}

function run() {
  return withJobLock('visual-analyzer', () => {
    setWorkerConfiguration('visual', {
      model: MODEL, max_visual: MAX_VISUAL, max_visual_attempts: MAX_VISUAL_ATTEMPTS,
      max_visual_frames: MAX_VISUAL_FRAMES,
      visual_request_timeout_ms: CONFIG.visual_request_timeout_ms,
      max_visual_requests_per_day: MAX_VISUAL_REQUESTS_PER_DAY,
      max_visual_cost_per_month_usd: MAX_VISUAL_COST_PER_MONTH_USD,
      max_visual_cost_reserve_per_request_usd: MAX_VISUAL_COST_RESERVE_PER_REQUEST_USD,
      effective_visual_cost_reserve_per_request_usd: visualRequestReserveUsd(),
      retry_failed: RETRY_FAILED,
      video_id: Number.isInteger(TARGET_ID) ? TARGET_ID : null
    });
    return runLocked();
  });
}

if (require.main === module) {
  run().catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { run };
