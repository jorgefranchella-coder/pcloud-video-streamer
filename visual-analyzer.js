const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { db, buildVisualSearchText, withJobLock, setWorkerConfiguration, setWorkerActivity, reserveVisualDailyRequest } = require('./metadata-store');
const { visualConfiguration } = require('./config');

const execFileAsync = promisify(execFile);
const VIDEO_ROOT = path.resolve(process.env.VIDEO_ROOT || '/mnt/pcloud/My Videos');
const CONFIG = visualConfiguration();
const MODEL = CONFIG.visual_model;
const API_URL = process.env.OPENROUTER_API_URL || 'https://openrouter.ai/api/v1/chat/completions';
const PROMPT_VERSION = 'visual-v2';
const MAX_VISUAL = CONFIG.max_visual;
const MAX_VISUAL_ATTEMPTS = CONFIG.max_visual_attempts;
const MAX_VISUAL_REQUESTS_PER_DAY = CONFIG.max_visual_requests_per_day;
const RETRY_FAILED = CONFIG.retry_visual_failed;
const TARGET_ID = CONFIG.visual_video_id;

const evidenceItem = {
  type: 'object',
  properties: { description: { type: 'string' }, frame_index: { type: 'integer' } },
  required: ['description', 'frame_index'],
  additionalProperties: false
};
const responseSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    events: { type: 'array', items: evidenceItem },
    people: { type: 'array', items: evidenceItem },
    places: { type: 'array', items: { type: 'string' } },
    keywords: { type: 'array', items: { type: 'string' } },
    date_clues: { type: 'array', items: evidenceItem },
    uncertainty: { type: 'string' }
  },
  required: ['title', 'summary', 'events', 'people', 'places', 'keywords', 'date_clues', 'uncertainty'],
  additionalProperties: false
};

function sampleTimes(durationMs) {
  if (!durationMs || durationMs < 2000) return [0];
  const seconds = durationMs / 1000;
  return [...new Set([0.08, 0.35, 0.65, 0.92].map(fraction => Math.floor(seconds * fraction)))];
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

async function describeFrames(frames, apiKey) {
  const content = [{ type: 'text', text: 'Estas son imágenes puntuales del mismo video, en orden temporal. Usa el índice de cada fotograma para respaldar eventos, personas y pistas de fecha.' }];
  for (const [index, frame] of frames.entries()) {
    content.push({ type: 'text', text: `Fotograma ${index + 1}, segundo ${frame.at_seconds}:` });
    content.push({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${frame.image.toString('base64')}`, detail: 'high' }
    });
  }
  if (!reserveVisualDailyRequest(MAX_VISUAL_REQUESTS_PER_DAY)) {
    const error = new Error('Visual daily request budget exhausted');
    error.code = 'VISUAL_DAILY_BUDGET_EXHAUSTED';
    throw error;
  }
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      provider: { require_parameters: true },
      messages: [
        {
          role: 'system',
          content: 'Redacta una ficha en español natural basada SOLO en lo visible en los fotogramas. Todos los textos deben estar en español; no mezcles otros idiomas ni escrituras, salvo nombres propios o texto que se vea escrito en el fotograma. No inventes diálogos, acciones entre fotogramas, lugares ni fechas. En people, incluye a las personas o grupos claramente visibles, aunque no puedas reconocerlos; describe cantidad aproximada, ubicación en la escena y ropa solo cuando se distinga. Si aparecen personas pero sus rasgos no se distinguen, incluye una descripción breve que lo diga. Deja people vacío únicamente si no hay personas visibles en ningún fotograma. No asignes nombres ni identidades. Si una acción o lugar es incierto, dilo brevemente en uncertainty. Las pistas de fecha requieren texto legible visible. Usa frame_index entre 1 y el número de imágenes suministradas. Mantén título, resumen y descripciones concisos.'
        },
        { role: 'user', content }
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'video_visual_sheet', strict: true, schema: responseSchema }
      },
      max_tokens: 2000
    }),
    signal: AbortSignal.timeout(120000)
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenRouter HTTP ${response.status}: ${body.slice(0, 300)}`);
  }
  const data = await response.json();
  const message = data.choices?.[0]?.message;
  if (message?.refusal) throw new Error(`OpenRouter refusal: ${String(message.refusal).slice(0, 300)}`);
  const outputText = typeof message?.content === 'string'
    ? message.content
    : Array.isArray(message?.content)
      ? message.content.filter(item => item.type === 'text').map(item => item.text).join('')
      : '';
  if (!outputText) throw new Error('OpenRouter returned no structured text');
  return { result: normalizeResult(JSON.parse(outputText), frames), usage: data.usage || null };
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
    for (const atSeconds of sampleTimes(row.duration_ms)) {
      try {
        frames.push({ at_seconds: atSeconds, image: await extractFrame(fullPath, atSeconds) });
      } catch (error) {
        console.error(`Frame at ${atSeconds}s failed for video ${row.id}: ${error.message}`);
      }
    }
    if (!frames.length) throw new Error('No frames could be extracted');
    setWorkerActivity('visual-analyzer', { videoId: row.id, path: row.relative_path, phase: 'analizando con el proveedor' });
    const { result, usage } = await describeFrames(frames, apiKey);
    const finalStat = await fs.promises.stat(fullPath);
    if (`${finalStat.size}:${Math.round(finalStat.mtimeMs)}` !== row.fingerprint) throw new Error('Video changed during analysis');
    const searchText = buildVisualSearchText({
      events: result.events, people: result.people, places: result.places,
      keywords: result.keywords, dateClues: result.date_clues,
      confirmedPeople: JSON.parse(row.confirmed_people_json)
    });
    const revision = crypto.randomUUID();
    const persistResult = db.transaction(() => {
      const updated = db.prepare(`UPDATE videos SET visual_status = 'done', visual_title = @title,
      visual_summary = @summary, visual_uncertainty = @uncertainty,
      visual_people_json = @people, visual_events_json = @events,
      visual_places_json = @places, visual_keywords_json = @keywords,
      visual_date_clues_json = @date_clues, visual_search_text = @search_text,
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
      prompt_version: PROMPT_VERSION, usage: JSON.stringify(usage || {}), revision
      });
      if (!updated.changes) throw new Error('Video changed in the index during analysis');
    });
    persistResult();
    setWorkerActivity('visual-analyzer', { phase: null, result: `Ficha visual guardada para ${row.relative_path}` });
    console.log(JSON.stringify({ video_id: row.id, frames: frames.length, model: MODEL, usage }));
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
    const message = String(error.message).slice(0, 1000);
    const authenticationFailure = /^OpenRouter HTTP (401|403)\b/.test(message);
    const providerRateLimit = /^OpenRouter HTTP 429\b/.test(message);
    const providerServerFailure = /^OpenRouter HTTP 5\d\d\b/.test(message);
    const permanentFailure = (/^OpenRouter HTTP 4\d\d\b/.test(message) && !providerRateLimit) ||
      message.startsWith('OpenRouter refusal:') || message.startsWith('Invalid model response:') ||
      message.includes('Video changed');
    const retryable = !permanentFailure;
    const exhausted = retryable && attemptNumber >= MAX_VISUAL_ATTEMPTS;
    const baseDelaySeconds = providerRateLimit ? 300 : 60;
    const delaySeconds = retryable && !exhausted
      ? Math.min(baseDelaySeconds * (2 ** Math.min(attemptNumber - 1, 10)), 86400)
      : null;
    const retryAt = delaySeconds == null ? null : new Date(Date.now() + delaySeconds * 1000)
      .toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
    const errorClass = authenticationFailure ? 'provider_auth'
      : providerRateLimit ? 'provider_rate_limit'
        : providerServerFailure ? 'provider_unavailable'
          : exhausted ? 'attempt_limit' : permanentFailure ? 'permanent' : 'transient';
    db.prepare(`UPDATE videos SET visual_status = 'failed', visual_error = ?, visual_error_class = ?,
        visual_next_attempt_at = ? WHERE id = ? AND fingerprint = ? AND visual_status = 'running'`)
      .run(message, errorClass, retryAt, row.id, row.fingerprint);
    setWorkerActivity('visual-analyzer', {
      phase: retryAt ? 'esperando reintento' : 'fallo sin reintento automático',
      videoId: row.id, path: row.relative_path, error: message
    });
    console.error(`Visual analysis failed for video ${row.id}: ${error.message}`);
    if (authenticationFailure || providerRateLimit || providerServerFailure) throw error;
  }
  return true;
}

async function runLocked() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is required for visual analysis');
  // The exclusive lock proves no visual worker still owns these rows.
  db.prepare(`UPDATE videos SET visual_status = 'failed', visual_error = 'El trabajador se interrumpió durante el análisis',
      visual_error_class = CASE WHEN visual_attempts >= ? THEN 'attempt_limit' ELSE 'worker_interrupted' END,
      visual_next_attempt_at = CASE WHEN visual_attempts >= ? THEN NULL ELSE datetime(CURRENT_TIMESTAMP, '+1 minute') END
    WHERE visual_status = 'running'`).run(MAX_VISUAL_ATTEMPTS, MAX_VISUAL_ATTEMPTS);
  const utcDay = new Date().toISOString().slice(0, 10);
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
  const candidates = Number.isInteger(TARGET_ID) && TARGET_ID > 0
    ? db.prepare("SELECT id, relative_path, fingerprint, duration_ms, confirmed_people_json FROM videos WHERE id = ? AND status = 'done'").all(TARGET_ID)
    : db.prepare(`SELECT id, relative_path, fingerprint, duration_ms, confirmed_people_json FROM videos
        WHERE status = 'done' AND (visual_status IS NULL OR visual_status = 'pending'
          OR (visual_status = 'failed' AND ? = 1 AND visual_next_attempt_at IS NOT NULL
            AND visual_next_attempt_at <= CURRENT_TIMESTAMP AND visual_attempts < ?))
        ORDER BY CASE WHEN visual_status = 'pending' OR visual_status IS NULL THEN 0 ELSE 1 END, id LIMIT ?`)
      .all(RETRY_FAILED ? 1 : 0, MAX_VISUAL_ATTEMPTS, batchLimit);
  for (const row of candidates) {
    if (!await analyzeVideo(row, apiKey)) break;
  }
  console.log(`Visual batch: ${candidates.length} video(s) attempted`);
}

function run() {
  return withJobLock('visual-analyzer', () => {
    setWorkerConfiguration('visual', {
      model: MODEL, max_visual: MAX_VISUAL, max_visual_attempts: MAX_VISUAL_ATTEMPTS,
      max_visual_requests_per_day: MAX_VISUAL_REQUESTS_PER_DAY,
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
