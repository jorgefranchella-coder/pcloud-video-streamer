const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'videos.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

const searchSchemaVersion = db.pragma('user_version', { simple: true });
db.exec(`
  CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY,
    relative_path TEXT NOT NULL UNIQUE,
    size_bytes INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL,
    fingerprint TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    duration_ms INTEGER,
    width INTEGER,
    height INTEGER,
    codec TEXT,
    recorded_at TEXT,
    date_precision TEXT,
    date_source TEXT,
    date_candidates_json TEXT NOT NULL DEFAULT '[]',
    technical_json TEXT NOT NULL DEFAULT '{}',
    error TEXT,
    last_seen_scan INTEGER,
    analyzed_at TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS videos_status_idx ON videos(status);
  CREATE INDEX IF NOT EXISTS videos_seen_idx ON videos(last_seen_scan);
  CREATE TABLE IF NOT EXISTS scans (
    id INTEGER PRIMARY KEY,
    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    seen_count INTEGER NOT NULL DEFAULT 0,
    error TEXT
  );
`);

const visualColumns = {
  visual_status: 'TEXT',
  visual_title: 'TEXT',
  visual_summary: 'TEXT',
  visual_uncertainty: 'TEXT',
  visual_people_json: "TEXT NOT NULL DEFAULT '[]'",
  visual_events_json: "TEXT NOT NULL DEFAULT '[]'",
  visual_places_json: "TEXT NOT NULL DEFAULT '[]'",
  visual_keywords_json: "TEXT NOT NULL DEFAULT '[]'",
  visual_date_clues_json: "TEXT NOT NULL DEFAULT '[]'",
  visual_search_text: "TEXT NOT NULL DEFAULT ''",
  visual_model: 'TEXT',
  visual_prompt_version: 'TEXT',
  visual_usage_json: "TEXT NOT NULL DEFAULT '{}'",
  visual_fingerprint: 'TEXT',
  visual_error: 'TEXT',
  visual_analyzed_at: 'TEXT',
  confirmed_people_json: "TEXT NOT NULL DEFAULT '[]'"
};
const existingColumns = new Set(db.prepare('PRAGMA table_info(videos)').all().map(column => column.name));
for (const [name, definition] of Object.entries(visualColumns)) {
  if (!existingColumns.has(name)) db.exec(`ALTER TABLE videos ADD COLUMN ${name} ${definition}`);
}

db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS video_fts USING fts5(
    relative_path, visual_title, visual_summary, visual_search_text,
    content='videos', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER IF NOT EXISTS videos_fts_insert AFTER INSERT ON videos BEGIN
    INSERT INTO video_fts(rowid, relative_path, visual_title, visual_summary, visual_search_text)
    VALUES (new.id, new.relative_path, new.visual_title, new.visual_summary, new.visual_search_text);
  END;
  CREATE TRIGGER IF NOT EXISTS videos_fts_delete AFTER DELETE ON videos BEGIN
    INSERT INTO video_fts(video_fts, rowid, relative_path, visual_title, visual_summary, visual_search_text)
    VALUES ('delete', old.id, old.relative_path, old.visual_title, old.visual_summary, old.visual_search_text);
  END;
  CREATE TRIGGER IF NOT EXISTS videos_fts_update AFTER UPDATE ON videos BEGIN
    INSERT INTO video_fts(video_fts, rowid, relative_path, visual_title, visual_summary, visual_search_text)
    VALUES ('delete', old.id, old.relative_path, old.visual_title, old.visual_summary, old.visual_search_text);
    INSERT INTO video_fts(rowid, relative_path, visual_title, visual_summary, visual_search_text)
    VALUES (new.id, new.relative_path, new.visual_title, new.visual_summary, new.visual_search_text);
  END;
`);
if (searchSchemaVersion < 1) {
  db.exec("INSERT INTO video_fts(video_fts) VALUES ('rebuild')");
  db.pragma('user_version = 1');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS people (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS video_person_observations (
    video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    observation_index INTEGER NOT NULL,
    person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    confirmed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (video_id, observation_index)
  );
  CREATE INDEX IF NOT EXISTS video_person_person_idx ON video_person_observations(person_id);
`);

const getByPath = db.prepare('SELECT * FROM videos WHERE relative_path = ?');
const getById = db.prepare('SELECT * FROM videos WHERE id = ?');
const upsert = db.prepare(`
  INSERT INTO videos (relative_path, size_bytes, mtime_ms, fingerprint, status, last_seen_scan)
  VALUES (@relative_path, @size_bytes, @mtime_ms, @fingerprint, 'pending', @scan_id)
  ON CONFLICT(relative_path) DO UPDATE SET
    size_bytes = excluded.size_bytes,
    mtime_ms = excluded.mtime_ms,
    fingerprint = excluded.fingerprint,
    status = CASE WHEN videos.fingerprint != excluded.fingerprint OR videos.status = 'missing'
      THEN 'pending' ELSE videos.status END,
    duration_ms = CASE WHEN videos.fingerprint != excluded.fingerprint THEN NULL ELSE videos.duration_ms END,
    width = CASE WHEN videos.fingerprint != excluded.fingerprint THEN NULL ELSE videos.width END,
    height = CASE WHEN videos.fingerprint != excluded.fingerprint THEN NULL ELSE videos.height END,
    codec = CASE WHEN videos.fingerprint != excluded.fingerprint THEN NULL ELSE videos.codec END,
    recorded_at = CASE WHEN videos.fingerprint != excluded.fingerprint THEN NULL ELSE videos.recorded_at END,
    date_precision = CASE WHEN videos.fingerprint != excluded.fingerprint THEN NULL ELSE videos.date_precision END,
    date_source = CASE WHEN videos.fingerprint != excluded.fingerprint THEN NULL ELSE videos.date_source END,
    date_candidates_json = CASE WHEN videos.fingerprint != excluded.fingerprint THEN '[]' ELSE videos.date_candidates_json END,
    technical_json = CASE WHEN videos.fingerprint != excluded.fingerprint THEN '{}' ELSE videos.technical_json END,
    error = CASE WHEN videos.fingerprint != excluded.fingerprint THEN NULL ELSE videos.error END,
    visual_status = CASE WHEN videos.fingerprint != excluded.fingerprint THEN 'pending' ELSE videos.visual_status END,
    visual_title = CASE WHEN videos.fingerprint != excluded.fingerprint THEN NULL ELSE videos.visual_title END,
    visual_summary = CASE WHEN videos.fingerprint != excluded.fingerprint THEN NULL ELSE videos.visual_summary END,
    visual_uncertainty = CASE WHEN videos.fingerprint != excluded.fingerprint THEN NULL ELSE videos.visual_uncertainty END,
    visual_people_json = CASE WHEN videos.fingerprint != excluded.fingerprint THEN '[]' ELSE videos.visual_people_json END,
    visual_events_json = CASE WHEN videos.fingerprint != excluded.fingerprint THEN '[]' ELSE videos.visual_events_json END,
    visual_places_json = CASE WHEN videos.fingerprint != excluded.fingerprint THEN '[]' ELSE videos.visual_places_json END,
    visual_keywords_json = CASE WHEN videos.fingerprint != excluded.fingerprint THEN '[]' ELSE videos.visual_keywords_json END,
    visual_date_clues_json = CASE WHEN videos.fingerprint != excluded.fingerprint THEN '[]' ELSE videos.visual_date_clues_json END,
    visual_search_text = CASE WHEN videos.fingerprint != excluded.fingerprint THEN '' ELSE videos.visual_search_text END,
    visual_model = CASE WHEN videos.fingerprint != excluded.fingerprint THEN NULL ELSE videos.visual_model END,
    visual_prompt_version = CASE WHEN videos.fingerprint != excluded.fingerprint THEN NULL ELSE videos.visual_prompt_version END,
    visual_fingerprint = CASE WHEN videos.fingerprint != excluded.fingerprint THEN NULL ELSE videos.visual_fingerprint END,
    visual_error = CASE WHEN videos.fingerprint != excluded.fingerprint THEN NULL ELSE videos.visual_error END,
    visual_usage_json = CASE WHEN videos.fingerprint != excluded.fingerprint THEN '{}' ELSE videos.visual_usage_json END,
    visual_analyzed_at = CASE WHEN videos.fingerprint != excluded.fingerprint THEN NULL ELSE videos.visual_analyzed_at END,
    confirmed_people_json = CASE WHEN videos.fingerprint != excluded.fingerprint THEN '[]' ELSE videos.confirmed_people_json END,
    last_seen_scan = excluded.last_seen_scan,
    updated_at = CURRENT_TIMESTAMP
`);

function parseVideo(row) {
  if (!row) return null;
  return {
    ...row,
    date_candidates: JSON.parse(row.date_candidates_json),
    technical: JSON.parse(row.technical_json),
    visual_people: JSON.parse(row.visual_people_json),
    visual_events: JSON.parse(row.visual_events_json),
    visual_places: JSON.parse(row.visual_places_json),
    visual_keywords: JSON.parse(row.visual_keywords_json),
    visual_date_clues: JSON.parse(row.visual_date_clues_json),
    confirmed_people: JSON.parse(row.confirmed_people_json)
  };
}

function status() {
  const counts = db.prepare('SELECT status, COUNT(*) AS count FROM videos GROUP BY status').all();
  const scan = db.prepare('SELECT * FROM scans ORDER BY id DESC LIMIT 1').get();
  const visualCounts = db.prepare("SELECT COALESCE(visual_status, 'pending') AS status, COUNT(*) AS count FROM videos WHERE status != 'missing' GROUP BY COALESCE(visual_status, 'pending')").all();
  const visualReadyCounts = db.prepare("SELECT COALESCE(visual_status, 'pending') AS status, COUNT(*) AS count FROM videos WHERE status = 'done' GROUP BY COALESCE(visual_status, 'pending')").all();
  return {
    counts: Object.fromEntries(counts.map(row => [row.status, row.count])),
    visual_counts: Object.fromEntries(visualCounts.map(row => [row.status, row.count])),
    visual_ready_counts: Object.fromEntries(visualReadyCounts.map(row => [row.status, row.count])),
    last_scan: scan || null
  };
}

function search({ query, from, to, limit, offset }) {
  const words = query.match(/[\p{L}\p{N}]+/gu)?.slice(0, 8) || [];
  const match = words.map(word => `"${word.replace(/"/g, '')}"*`).join(' AND ');
  const source = match ? 'video_fts JOIN videos ON videos.id = video_fts.rowid' : 'videos';
  const matching = match ? 'video_fts MATCH ? AND ' : '';
  const args = match ? [match] : [];
  return db.prepare(`SELECT videos.id, videos.relative_path, videos.recorded_at, videos.date_source,
      videos.status, videos.visual_title, videos.visual_summary
    FROM ${source}
    WHERE ${matching}(? IS NULL OR videos.recorded_at >= ?)
      AND (? IS NULL OR videos.recorded_at <= ?)
      AND videos.status != 'missing'
    ORDER BY videos.recorded_at IS NULL, videos.recorded_at DESC, videos.relative_path
    LIMIT ? OFFSET ?`).all(...args, from, from, to, to, limit, offset);
}

function buildVisualSearchText({ events, people, places, keywords, dateClues, confirmedPeople }) {
  return [
    ...events.map(item => item.description),
    ...people.map(item => item.description),
    ...places, ...keywords,
    ...dateClues.map(item => item.description),
    ...confirmedPeople
  ].join(' ');
}

function setConfirmedPeople(relativePath, names) {
  const row = getByPath.get(relativePath);
  if (!row) return false;
  const searchText = buildVisualSearchText({
    events: JSON.parse(row.visual_events_json),
    people: JSON.parse(row.visual_people_json),
    places: JSON.parse(row.visual_places_json),
    keywords: JSON.parse(row.visual_keywords_json),
    dateClues: JSON.parse(row.visual_date_clues_json),
    confirmedPeople: names
  });
  db.prepare('UPDATE videos SET confirmed_people_json = ?, visual_search_text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(JSON.stringify(names), searchText, row.id);
  return true;
}

function listPeople() {
  return db.prepare(`SELECT people.id, people.name,
      COUNT(video_person_observations.video_id) AS appearances,
      COUNT(DISTINCT video_person_observations.video_id) AS videos
    FROM people LEFT JOIN video_person_observations ON people.id = video_person_observations.person_id
    GROUP BY people.id ORDER BY people.name COLLATE NOCASE`).all();
}

function identifiedPeopleForVideo(videoId) {
  return Object.fromEntries(db.prepare(`SELECT observation_index, people.id AS person_id, people.name
    FROM video_person_observations JOIN people ON people.id = video_person_observations.person_id
    WHERE video_id = ?`).all(videoId).map(row => [row.observation_index, { id: row.person_id, name: row.name }]));
}

function setVideoPerson({ relativePath, observationIndex, personId, personName }) {
  const row = getByPath.get(relativePath);
  if (!row || !Number.isInteger(observationIndex) || observationIndex < 0) return false;
  const observations = JSON.parse(row.visual_people_json);
  if (row.visual_status !== 'done' || observationIndex >= observations.length) return false;

  const assign = db.transaction(() => {
    if (personName) {
      const name = personName.trim().replace(/\s+/g, ' ');
      if (!name || name.length > 80) throw new Error('El nombre debe tener entre 1 y 80 caracteres');
      db.prepare('INSERT INTO people (name) VALUES (?) ON CONFLICT(name) DO NOTHING').run(name);
      personId = db.prepare('SELECT id FROM people WHERE name = ? COLLATE NOCASE').get(name)?.id;
    }
    if (personId == null) {
      db.prepare('DELETE FROM video_person_observations WHERE video_id = ? AND observation_index = ?')
        .run(row.id, observationIndex);
    } else {
      const person = db.prepare('SELECT id FROM people WHERE id = ?').get(personId);
      if (!person) throw new Error('Persona desconocida');
      db.prepare(`INSERT INTO video_person_observations (video_id, observation_index, person_id)
        VALUES (?, ?, ?) ON CONFLICT(video_id, observation_index) DO UPDATE SET
          person_id = excluded.person_id, confirmed_at = CURRENT_TIMESTAMP`)
        .run(row.id, observationIndex, personId);
    }

    const names = db.prepare(`SELECT people.name FROM video_person_observations
      JOIN people ON people.id = video_person_observations.person_id WHERE video_id = ?`).all(row.id).map(item => item.name);
    const searchText = buildVisualSearchText({
      events: JSON.parse(row.visual_events_json), people: observations,
      places: JSON.parse(row.visual_places_json), keywords: JSON.parse(row.visual_keywords_json),
      dateClues: JSON.parse(row.visual_date_clues_json),
      confirmedPeople: [...JSON.parse(row.confirmed_people_json), ...names]
    });
    db.prepare('UPDATE videos SET visual_search_text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(searchText, row.id);
    return personId == null ? null : db.prepare('SELECT id, name FROM people WHERE id = ?').get(personId);
  });
  return assign();
}

module.exports = {
  db, getByPath, getById, upsert, parseVideo, status, search, buildVisualSearchText,
  setConfirmedPeople, listPeople, identifiedPeopleForVideo, setVideoPerson
};
