const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { db, buildVisualSearchText } = require('./metadata-store');

const execFileAsync = promisify(execFile);
const VIDEO_ROOT = path.resolve(process.env.VIDEO_ROOT || '/mnt/pcloud/My Videos');
const MODEL = process.env.OPENROUTER_MODEL || 'openrouter/free';
const API_URL = process.env.OPENROUTER_API_URL || 'https://openrouter.ai/api/v1/chat/completions';
const PROMPT_VERSION = 'visual-v2';
const MAX_VISUAL = Math.min(Math.max(Number.parseInt(process.env.MAX_VISUAL || '1', 10) || 1, 1), 100);
const RETRY_FAILED = process.env.RETRY_VISUAL_FAILED === '1';
const TARGET_ID = Number.parseInt(process.env.VISUAL_VIDEO_ID || '', 10);

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
  db.prepare("UPDATE videos SET visual_status = 'running', visual_error = NULL WHERE id = ?").run(row.id);
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
    const { result, usage } = await describeFrames(frames, apiKey);
    const finalStat = await fs.promises.stat(fullPath);
    if (`${finalStat.size}:${Math.round(finalStat.mtimeMs)}` !== row.fingerprint) throw new Error('Video changed during analysis');
    const searchText = buildVisualSearchText({
      events: result.events, people: result.people, places: result.places,
      keywords: result.keywords, dateClues: result.date_clues,
      confirmedPeople: JSON.parse(row.confirmed_people_json)
    });
    const persistResult = db.transaction(() => {
      db.prepare('DELETE FROM video_person_observations WHERE video_id = ?').run(row.id);
      return db.prepare(`UPDATE videos SET visual_status = 'done', visual_title = @title,
      visual_summary = @summary, visual_uncertainty = @uncertainty,
      visual_people_json = @people, visual_events_json = @events,
      visual_places_json = @places, visual_keywords_json = @keywords,
      visual_date_clues_json = @date_clues, visual_search_text = @search_text,
      visual_model = @model, visual_prompt_version = @prompt_version,
      visual_usage_json = @usage, visual_fingerprint = @fingerprint,
      visual_error = NULL, visual_analyzed_at = CURRENT_TIMESTAMP
      WHERE id = @id AND fingerprint = @fingerprint`).run({
      id: row.id, fingerprint: row.fingerprint, title: result.title, summary: result.summary,
      uncertainty: result.uncertainty,
      people: JSON.stringify(result.people), events: JSON.stringify(result.events),
      places: JSON.stringify(result.places), keywords: JSON.stringify(result.keywords),
      date_clues: JSON.stringify(result.date_clues), search_text: searchText, model: MODEL,
      prompt_version: PROMPT_VERSION, usage: JSON.stringify(usage || {})
      });
    });
    const updated = persistResult();
    if (!updated.changes) throw new Error('Video changed in the index during analysis');
    console.log(JSON.stringify({ video_id: row.id, frames: frames.length, model: MODEL, usage }));
  } catch (error) {
    db.prepare("UPDATE videos SET visual_status = 'failed', visual_error = ? WHERE id = ? AND fingerprint = ?")
      .run(String(error.message).slice(0, 1000), row.id, row.fingerprint);
    console.error(`Visual analysis failed for video ${row.id}: ${error.message}`);
    if (/^OpenRouter HTTP (401|403|429|5\d\d)/.test(error.message)) throw error;
  }
}

async function run() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is required for visual analysis');
  db.prepare("UPDATE videos SET visual_status = 'pending' WHERE visual_status = 'running'").run();
  const candidates = Number.isInteger(TARGET_ID) && TARGET_ID > 0
    ? db.prepare("SELECT id, relative_path, fingerprint, duration_ms, confirmed_people_json FROM videos WHERE id = ? AND status = 'done'").all(TARGET_ID)
    : db.prepare(`SELECT id, relative_path, fingerprint, duration_ms, confirmed_people_json FROM videos
        WHERE status = 'done' AND (visual_status IS NULL OR visual_status = 'pending'
          OR (visual_status = 'failed' AND ? = 1))
        ORDER BY id LIMIT ?`).all(RETRY_FAILED ? 1 : 0, MAX_VISUAL);
  for (const row of candidates) await analyzeVideo(row, apiKey);
  console.log(`Visual batch: ${candidates.length} video(s) attempted`);
}

if (require.main === module) {
  run().catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { run };
