const crypto = require('node:crypto');
const metadata = require('./metadata-store');
const { faceConfiguration } = require('./config');

const PROMPT_VERSION = 'family-archive-v2';
const db = metadata.db;

function modelName() {
  return (process.env.REFINEMENT_MODEL || 'openrouter/free').trim();
}

function contextForVideo(row) {
  if (!row || row.status !== 'done' || row.visual_status !== 'done' ||
      row.visual_fingerprint !== row.fingerprint || !row.visual_revision) return null;
  const parsed = metadata.parseVideo(row);
  const narrative = metadata.identifiedPeopleForVideo(row.id).all;
  const faces = metadata.identifiedFacesForVideo(row.id, faceConfiguration().index_version);
  const peopleIds = [...new Set([
    ...Object.values(narrative).flat().map(person => person.id),
    ...faces.map(person => person.person_id)
  ])].sort((a, b) => a - b);
  const profiles = peopleIds.map(id => db.prepare('SELECT id, name, description FROM people WHERE id = ? AND merged_into IS NULL').get(id))
    .filter(Boolean);
  const input = {
    visual_revision: row.visual_revision,
    fingerprint: row.fingerprint,
    original: {
      title: row.visual_title || '', summary: row.visual_summary || '',
      events: parsed.visual_events.slice(0, 12), people: parsed.visual_people.slice(0, 12),
      places: parsed.visual_places.slice(0, 12), uncertainty: row.visual_uncertainty || ''
    },
    date: row.recorded_at ? { value: row.recorded_at, precision: row.date_precision, source: row.date_source } : null,
    location: parsed.technical?.location?.raw || null,
    narrative_identifications: Object.entries(narrative).sort((a, b) => Number(a[0]) - Number(b[0])).slice(0, 20)
      .map(([index, people]) => ({
        observation: parsed.visual_people[Number(index)] || null,
        people: people.map(person => person.name).sort()
      })),
    face_identifications: faces.slice(0, 30).map(person => ({ name: person.name, appearances: person.appearances })),
    person_context: profiles.slice(0, 30).map(person => ({ name: person.name, description: person.description }))
  };
  const hash = crypto.createHash('sha256').update(JSON.stringify({ model: modelName(), prompt: PROMPT_VERSION, input })).digest('hex');
  return { hash, input };
}

function stateForVideo(row) {
  const context = contextForVideo(row);
  if (!context) return { status: 'unavailable', proposal: null, approved: null };
  const current = db.prepare('SELECT * FROM video_refinements WHERE video_id = ? AND input_hash = ? ORDER BY id DESC LIMIT 1')
    .get(row.id, context.hash);
  const attempt = db.prepare('SELECT attempts, next_attempt_at, last_error FROM video_refinement_attempts WHERE video_id = ? AND input_hash = ?')
    .get(row.id, context.hash);
  const previousApproval = db.prepare("SELECT 1 FROM video_refinements WHERE video_id = ? AND status = 'approved' AND input_hash != ? LIMIT 1")
    .get(row.id, context.hash);
  return {
    status: current?.status || (attempt?.attempts >= 3 ? 'failed' : attempt?.next_attempt_at > new Date().toISOString() ? 'retry_wait' : 'pending'),
    input_hash: context.hash,
    stale_approved: Boolean(previousApproval) && current?.status !== 'approved',
    proposal: current || null,
    approved: current?.status === 'approved' ? { title: current.title, summary: current.summary } : null,
    sync_token: crypto.createHash('sha256').update(JSON.stringify({
      input_hash: context.hash, status: current?.status || 'pending',
      title: current?.status === 'approved' ? current.title : null,
      summary: current?.status === 'approved' ? current.summary : null
    })).digest('hex'),
    retry: attempt || null
  };
}

function eligibleVideos(limit = 5, targetId = null) {
  const result = [];
  const rows = db.prepare(`SELECT * FROM videos WHERE status = 'done' AND visual_status = 'done'
    AND visual_fingerprint = fingerprint AND (? IS NULL OR id = ?) ORDER BY visual_analyzed_at, id`).iterate(targetId, targetId);
  for (const row of rows) {
    const context = contextForVideo(row);
    if (!context) continue;
    if (db.prepare('SELECT 1 FROM video_refinements WHERE video_id = ? AND input_hash = ?').get(row.id, context.hash)) continue;
    const attempt = db.prepare('SELECT attempts, next_attempt_at FROM video_refinement_attempts WHERE video_id = ? AND input_hash = ?')
      .get(row.id, context.hash);
    if (attempt && (attempt.attempts >= 3 || (attempt.next_attempt_at && attempt.next_attempt_at > new Date().toISOString()))) continue;
    result.push({ row, context });
    if (result.length >= limit) break;
  }
  return result;
}

function saveProposal(videoId, inputHash, title, summary, model) {
  const save = db.transaction(() => {
    const row = metadata.getById.get(videoId);
    if (contextForVideo(row)?.hash !== inputHash) return false;
    db.prepare(`INSERT INTO video_refinements
      (video_id, input_hash, title, summary, generated_title, generated_summary, model, prompt_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(video_id, input_hash) DO NOTHING`)
      .run(videoId, inputHash, title, summary, title, summary, model, PROMPT_VERSION);
    db.prepare('DELETE FROM video_refinement_attempts WHERE video_id = ?').run(videoId);
    return true;
  });
  return save.immediate();
}

function recordFailure(videoId, inputHash, message, retrySeconds) {
  const next = new Date(Date.now() + retrySeconds * 1000).toISOString();
  db.prepare(`INSERT INTO video_refinement_attempts (video_id, input_hash, attempts, next_attempt_at, last_error)
    VALUES (?, ?, 1, ?, ?) ON CONFLICT(video_id) DO UPDATE SET
      attempts = CASE WHEN input_hash = excluded.input_hash THEN attempts + 1 ELSE 1 END,
      input_hash = excluded.input_hash, next_attempt_at = excluded.next_attempt_at, last_error = excluded.last_error`)
    .run(videoId, inputHash, next, String(message).slice(0, 500));
}

function reserveDailyRequest(limit) {
  const day = new Date().toISOString().slice(0, 10);
  const reserve = db.transaction(() => {
    const count = db.prepare('SELECT request_count FROM refinement_daily_requests WHERE utc_day = ?').get(day)?.request_count || 0;
    if (limit && count >= limit) return false;
    db.prepare(`INSERT INTO refinement_daily_requests (utc_day, request_count) VALUES (?, 1)
      ON CONFLICT(utc_day) DO UPDATE SET request_count = request_count + 1`).run(day);
    return true;
  });
  return reserve.immediate();
}

function review(videoId, inputHash, action, title, summary) {
  const update = db.transaction(() => {
    const row = metadata.getById.get(videoId);
    if (!row || contextForVideo(row)?.hash !== inputHash) return { error: 'stale' };
    const proposal = db.prepare(`SELECT * FROM video_refinements
      WHERE video_id = ? AND input_hash = ? AND status = 'proposed'`).get(videoId, inputHash);
    if (!proposal) return { error: 'missing' };
    if (!['approved', 'rejected'].includes(action)) return { error: 'invalid' };
    if (action === 'approved' &&
        (typeof title !== 'string' || !title.trim() || title.length > 120 ||
         typeof summary !== 'string' || !summary.trim() || summary.length > 1600)) return { error: 'invalid' };
    db.prepare(`UPDATE video_refinements SET status = ?, title = ?, summary = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(action, action === 'approved' ? title.trim() : proposal.title,
        action === 'approved' ? summary.trim() : proposal.summary, proposal.id);
    return { status: action };
  });
  return update.immediate();
}

function retry(videoId, inputHash) {
  const row = metadata.getById.get(videoId);
  if (!row || contextForVideo(row)?.hash !== inputHash) return false;
  db.prepare('DELETE FROM video_refinement_attempts WHERE video_id = ? AND input_hash = ?')
    .run(videoId, inputHash);
  return true;
}

function progress() {
  const result = { total: 0, pending: 0, proposed: 0, approved: 0, rejected: 0, retry_wait: 0, failed: 0 };
  for (const row of db.prepare(`SELECT * FROM videos WHERE status = 'done' AND visual_status = 'done'
    AND visual_fingerprint = fingerprint`).iterate()) {
    const state = stateForVideo(row);
    if (state.status === 'unavailable') continue;
    result.total += 1;
    result[state.status] += 1;
  }
  const day = new Date().toISOString().slice(0, 10);
  result.daily_requests = db.prepare('SELECT request_count FROM refinement_daily_requests WHERE utc_day = ?').get(day)?.request_count || 0;
  return result;
}

function reviewQueue(limit = 200) {
  const items = [];
  const rows = db.prepare(`SELECT r.video_id, r.input_hash, r.title, r.summary, r.generated_title,
      r.generated_summary, v.relative_path, v.visual_title, v.visual_summary
    FROM video_refinements r JOIN videos v ON v.id = r.video_id
    WHERE r.status = 'proposed' AND v.status = 'done' AND v.visual_status = 'done'
      AND v.visual_fingerprint = v.fingerprint
    ORDER BY r.generated_at, r.id LIMIT ?`).all(limit);
  for (const item of rows) {
    const row = metadata.getById.get(item.video_id);
    const state = stateForVideo(row);
    if (state.status !== 'proposed' || state.input_hash !== item.input_hash || !state.proposal) continue;
    items.push({
      video_id: item.video_id, relative_path: item.relative_path,
      input_hash: state.input_hash, title: state.proposal.title, summary: state.proposal.summary,
      generated_title: state.proposal.generated_title, generated_summary: state.proposal.generated_summary,
      visual_title: item.visual_title, visual_summary: item.visual_summary
    });
  }
  return { items, total: items.length, limit };
}

let lastFullSearchRefreshAt = 0;
function refreshApprovedSearch(videoId = null, force = false) {
  if (videoId === null && !force && Date.now() - lastFullSearchRefreshAt < 15000) return;
  const rows = db.prepare(`SELECT DISTINCT v.* FROM videos v JOIN video_refinements r ON r.video_id = v.id
    WHERE r.status = 'approved' AND v.status = 'done' AND v.visual_status = 'done'
      AND v.visual_fingerprint = v.fingerprint AND (? IS NULL OR v.id = ?)`).all(videoId, videoId);
  for (const row of rows) {
    const parsed = metadata.parseVideo(row);
    const narrative = metadata.identifiedPeopleForVideo(row.id).all;
    const faces = metadata.identifiedFacesForVideo(row.id, faceConfiguration().index_version);
    const names = [
      ...parsed.confirmed_people,
      ...Object.values(narrative).flat().map(person => person.name),
      ...faces.map(person => person.name)
    ];
    const base = metadata.buildVisualSearchText({
      events: parsed.visual_events, people: parsed.visual_people, places: parsed.visual_places,
      keywords: parsed.visual_keywords, dateClues: parsed.visual_date_clues,
      confirmedPeople: [...new Set(names)], location: metadata.nativeMetadataSearchText(row)
    });
    const approved = stateForVideo(row).approved;
    const next = approved ? `${base} ${approved.title} ${approved.summary}` : base;
    if (row.visual_search_text !== next) {
      db.prepare('UPDATE videos SET visual_search_text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(next, row.id);
    }
  }
  if (videoId === null) lastFullSearchRefreshAt = Date.now();
}

module.exports = { PROMPT_VERSION, modelName, contextForVideo, stateForVideo, eligibleVideos,
  saveProposal, recordFailure, reserveDailyRequest, review, retry, progress, reviewQueue, refreshApprovedSearch };
