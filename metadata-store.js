const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'videos.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

db.exec('BEGIN IMMEDIATE');
try {
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

db.exec(`CREATE TABLE IF NOT EXISTS process_locks (
  name TEXT PRIMARY KEY,
  owner_token TEXT NOT NULL,
  owner_pid INTEGER NOT NULL,
  owner_host TEXT NOT NULL,
  acquired_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);
db.exec(`CREATE TABLE IF NOT EXISTS worker_configuration (
  worker TEXT PRIMARY KEY,
  configuration_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);
db.exec(`CREATE TABLE IF NOT EXISTS automation_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  changed_by TEXT NOT NULL DEFAULT 'initialization'
);
CREATE TABLE IF NOT EXISTS automation_control_history (
  id INTEGER PRIMARY KEY,
  paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
  changed_by TEXT NOT NULL,
  changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS automation_control_history_idx ON automation_control_history(id DESC);
INSERT INTO automation_control (singleton, paused) VALUES (1, 0) ON CONFLICT(singleton) DO NOTHING`);
db.exec(`CREATE TABLE IF NOT EXISTS worker_runs (
  worker TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  owner_pid INTEGER NOT NULL,
  owner_host TEXT NOT NULL,
  started_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  current_video_id INTEGER,
  current_path TEXT,
  phase TEXT,
  last_result TEXT,
  last_error TEXT,
  finished_at TEXT
)`);
db.exec(`CREATE TABLE IF NOT EXISTS visual_daily_requests (
  utc_day TEXT PRIMARY KEY,
  request_count INTEGER NOT NULL DEFAULT 0
)`);
db.exec(`CREATE TABLE IF NOT EXISTS visual_provider_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  configuration_fingerprint TEXT NOT NULL,
  error_class TEXT NOT NULL,
  reason TEXT NOT NULL,
  paused_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paused_until TEXT
)`);
db.exec(`CREATE TABLE IF NOT EXISTS worker_run_history (
  id INTEGER PRIMARY KEY,
  worker TEXT NOT NULL,
  owner_pid INTEGER NOT NULL,
  owner_host TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  heartbeat_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT,
  last_result TEXT,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS worker_run_history_worker_idx ON worker_run_history(worker, id DESC)`);

function startWorkerRun(worker) {
  const start = db.transaction(() => {
    db.prepare(`INSERT INTO worker_runs
      (worker, status, owner_pid, owner_host, started_at, heartbeat_at, current_video_id, current_path, phase, last_error, finished_at)
    VALUES (?, 'running', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, NULL, 'starting', NULL, NULL)
    ON CONFLICT(worker) DO UPDATE SET status = 'running', owner_pid = excluded.owner_pid,
      owner_host = excluded.owner_host, started_at = CURRENT_TIMESTAMP, heartbeat_at = CURRENT_TIMESTAMP,
      current_video_id = NULL, current_path = NULL, phase = 'starting', last_error = NULL, finished_at = NULL`)
      .run(worker, process.pid, os.hostname());
    db.prepare(`INSERT INTO worker_run_history (worker, owner_pid, owner_host, status)
      VALUES (?, ?, ?, 'running')`).run(worker, process.pid, os.hostname());
    db.prepare(`DELETE FROM worker_run_history WHERE worker = ? AND id NOT IN
      (SELECT id FROM worker_run_history WHERE worker = ? ORDER BY id DESC LIMIT 200)`).run(worker, worker);
  });
  start.immediate();
}

function touchWorkerRun(worker) {
  db.prepare("UPDATE worker_runs SET heartbeat_at = CURRENT_TIMESTAMP WHERE worker = ? AND status = 'running'").run(worker);
  db.prepare(`UPDATE worker_run_history SET heartbeat_at = CURRENT_TIMESTAMP WHERE id =
    (SELECT MAX(id) FROM worker_run_history WHERE worker = ? AND status = 'running')`).run(worker);
}

function setWorkerActivity(worker, { phase = null, videoId = null, path = null, result = null, error = null } = {}) {
  db.prepare(`UPDATE worker_runs SET heartbeat_at = CURRENT_TIMESTAMP, phase = ?, current_video_id = ?,
      current_path = ?, last_result = COALESCE(?, last_result), last_error = ?
    WHERE worker = ? AND status = 'running'`).run(phase, videoId, path, result, error, worker);
  db.prepare(`UPDATE worker_run_history SET heartbeat_at = CURRENT_TIMESTAMP,
      last_result = COALESCE(?, last_result), last_error = ? WHERE id =
      (SELECT MAX(id) FROM worker_run_history WHERE worker = ? AND status = 'running')`)
    .run(result, error, worker);
}

function finishWorkerRun(worker, status, error = null) {
  db.prepare(`UPDATE worker_runs SET status = ?, heartbeat_at = CURRENT_TIMESTAMP,
      phase = NULL, current_video_id = NULL, current_path = NULL, last_error = ?, finished_at = CURRENT_TIMESTAMP
    WHERE worker = ?`).run(status, error, worker);
  db.prepare(`UPDATE worker_run_history SET status = ?, heartbeat_at = CURRENT_TIMESTAMP,
      finished_at = CURRENT_TIMESTAMP, last_error = COALESCE(?, last_error) WHERE id =
      (SELECT MAX(id) FROM worker_run_history WHERE worker = ? AND status = 'running')`)
    .run(status, error, worker);
}

function withJobLock(name, operation) {
  const token = crypto.randomUUID();
  const host = os.hostname();
  const lockNames = [...new Set([name, 'video-library-pipeline'])];
  const acquire = db.transaction(() => {
    const staleLocks = [];
    for (const lockName of lockNames) {
      const current = db.prepare('SELECT owner_token, owner_pid, owner_host FROM process_locks WHERE name = ?').get(lockName);
      if (!current) continue;
      let stale = false;
      if (current.owner_host === host) {
        try { process.kill(current.owner_pid, 0); }
        catch (error) { stale = error.code === 'ESRCH'; }
      }
      if (!stale) throw new Error(`${lockName} is already running on ${current.owner_host} (pid ${current.owner_pid})`);
      staleLocks.push({ name: lockName, token: current.owner_token });
    }
    for (const stale of staleLocks) {
      db.prepare('DELETE FROM process_locks WHERE name = ? AND owner_token = ?').run(stale.name, stale.token);
    }
    const insert = db.prepare('INSERT INTO process_locks (name, owner_token, owner_pid, owner_host) VALUES (?, ?, ?, ?)');
    for (const lockName of lockNames) insert.run(lockName, token, process.pid, host);
  });
  acquire.immediate();
  return (async () => {
    let heartbeat;
    try {
      startWorkerRun(name);
      heartbeat = setInterval(() => {
        try {
          touchWorkerRun(name);
        } catch (error) {
          console.error(`Worker heartbeat failed for ${name}:`, error.message);
        }
      }, 15000);
      heartbeat.unref();
      const result = await operation();
      finishWorkerRun(name, 'done');
      return result;
    } catch (error) {
      finishWorkerRun(name, 'failed', String(error.message).slice(0, 1000));
      throw error;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      db.prepare('DELETE FROM process_locks WHERE owner_token = ?').run(token);
    }
  })();
}

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
  visual_evidence_json: "TEXT NOT NULL DEFAULT '[]'",
  visual_search_text: "TEXT NOT NULL DEFAULT ''",
  visual_model: 'TEXT',
  visual_prompt_version: 'TEXT',
  visual_usage_json: "TEXT NOT NULL DEFAULT '{}'",
  visual_fingerprint: 'TEXT',
  visual_error: 'TEXT',
  visual_attempts: 'INTEGER NOT NULL DEFAULT 0',
  visual_next_attempt_at: 'TEXT',
  visual_error_class: 'TEXT',
  visual_analyzed_at: 'TEXT',
  visual_revision: 'TEXT',
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
`);
const personColumns = new Set(db.prepare('PRAGMA table_info(people)').all().map(column => column.name));
if (!personColumns.has('merged_into')) {
  db.exec('ALTER TABLE people ADD COLUMN merged_into INTEGER REFERENCES people(id)');
}
db.exec(`
  CREATE TABLE IF NOT EXISTS person_merge_history (
    id INTEGER PRIMARY KEY,
    source_person_id INTEGER NOT NULL REFERENCES people(id),
    target_person_id INTEGER NOT NULL REFERENCES people(id),
    source_name TEXT NOT NULL,
    target_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'undone')),
    merged_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    undone_at TEXT
  );
  CREATE TABLE IF NOT EXISTS video_person_identity_history (
    id INTEGER PRIMARY KEY,
    video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    analysis_revision TEXT NOT NULL,
    observation_index INTEGER NOT NULL,
    previous_person_id INTEGER,
    previous_name TEXT,
    person_id INTEGER,
    person_name TEXT,
    stale_person_name TEXT,
    action TEXT NOT NULL,
    stale_revision TEXT,
    stale_observation_index INTEGER,
    changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS video_person_identity_history_video_idx
    ON video_person_identity_history(video_id, id DESC);
  CREATE TABLE IF NOT EXISTS person_merge_observations (
    merge_id INTEGER NOT NULL REFERENCES person_merge_history(id) ON DELETE CASCADE,
    video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    analysis_revision TEXT NOT NULL,
    observation_index INTEGER NOT NULL,
    PRIMARY KEY (merge_id, video_id, analysis_revision, observation_index)
  );
`);

const identityHistorySchema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'video_person_identity_history'").get()?.sql || '';
if (identityHistorySchema.includes('CHECK (action IN')) {
  const migrateIdentityHistory = db.transaction(() => {
    db.exec(`DROP INDEX IF EXISTS video_person_identity_history_video_idx;
      ALTER TABLE video_person_identity_history RENAME TO video_person_identity_history_legacy;
      CREATE TABLE video_person_identity_history (
        id INTEGER PRIMARY KEY,
        video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
        analysis_revision TEXT NOT NULL,
        observation_index INTEGER NOT NULL,
        previous_person_id INTEGER,
        previous_name TEXT,
        person_id INTEGER,
        person_name TEXT,
        stale_person_name TEXT,
        action TEXT NOT NULL,
        stale_revision TEXT,
        stale_observation_index INTEGER,
        changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO video_person_identity_history
        (id, video_id, analysis_revision, observation_index, previous_person_id, previous_name,
         person_id, person_name, action, stale_revision, stale_observation_index, changed_at)
      SELECT id, video_id, analysis_revision, observation_index, previous_person_id, previous_name,
        person_id, person_name, action, stale_revision, stale_observation_index, changed_at
      FROM video_person_identity_history_legacy;
      DROP TABLE video_person_identity_history_legacy;
      CREATE INDEX video_person_identity_history_video_idx
        ON video_person_identity_history(video_id, id DESC);`);
  });
  migrateIdentityHistory.immediate();
}
const identityHistoryColumns = new Set(db.prepare('PRAGMA table_info(video_person_identity_history)').all().map(column => column.name));
if (!identityHistoryColumns.has('stale_person_name')) {
  db.exec('ALTER TABLE video_person_identity_history ADD COLUMN stale_person_name TEXT');
}

db.prepare(`UPDATE videos SET visual_revision = 'legacy:' || id || ':' || fingerprint
  WHERE visual_status = 'done' AND visual_revision IS NULL`).run();
const observationColumns = new Set(db.prepare('PRAGMA table_info(video_person_observations)').all().map(column => column.name));
const migrateObservations = db.transaction(() => {
  const legacy = observationColumns.size && !observationColumns.has('analysis_revision');
  if (legacy) db.exec('ALTER TABLE video_person_observations RENAME TO video_person_observations_legacy');
  db.exec(`CREATE TABLE IF NOT EXISTS video_person_observations (
    video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    analysis_revision TEXT NOT NULL,
    observation_index INTEGER NOT NULL,
    observation_description TEXT NOT NULL DEFAULT '',
    at_seconds REAL NOT NULL DEFAULT 0,
    person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    confirmed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reviewed_at TEXT,
    PRIMARY KEY (video_id, analysis_revision, observation_index)
  )`);
  if (legacy) {
    db.exec(`INSERT INTO video_person_observations
      (video_id, analysis_revision, observation_index, observation_description, at_seconds, person_id, confirmed_at)
    SELECT old.video_id, COALESCE(videos.visual_revision, 'legacy:' || videos.id || ':' || videos.fingerprint),
      old.observation_index,
      COALESCE(json_extract(videos.visual_people_json, '$[' || old.observation_index || '].description'), ''),
      COALESCE(json_extract(videos.visual_people_json, '$[' || old.observation_index || '].at_seconds'), 0),
      old.person_id, old.confirmed_at
      FROM video_person_observations_legacy old JOIN videos ON videos.id = old.video_id`);
    db.exec('DROP TABLE video_person_observations_legacy');
  }
  const currentColumns = new Set(db.prepare('PRAGMA table_info(video_person_observations)').all().map(column => column.name));
  if (!currentColumns.has('reviewed_at')) {
    db.exec('ALTER TABLE video_person_observations ADD COLUMN reviewed_at TEXT');
  }
  db.exec(`CREATE INDEX IF NOT EXISTS video_person_person_idx ON video_person_observations(person_id);
    CREATE INDEX IF NOT EXISTS video_person_video_revision_idx ON video_person_observations(video_id, analysis_revision)`);
});
migrateObservations.immediate();
db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  description TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);
const migrationRows = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
if (!migrationRows.length) {
  db.prepare('INSERT INTO schema_migrations (version, description) VALUES (1, ?)')
    .run('Baseline of the existing atomic schema bootstrap');
}
const currentMigration = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version || 0;
if (currentMigration < 2) {
  db.exec('CREATE INDEX IF NOT EXISTS videos_visual_analyzed_at_idx ON videos(visual_analyzed_at)');
  db.prepare('INSERT INTO schema_migrations (version, description) VALUES (2, ?)')
    .run('Index visual analysis timestamps for monthly provider cost reports');
}
if (currentMigration < 3) {
  db.exec("ALTER TABLE videos ADD COLUMN visual_sampling_json TEXT NOT NULL DEFAULT '{}'");
  db.prepare('INSERT INTO schema_migrations (version, description) VALUES (3, ?)')
    .run('Persist the per-video visual sampling plan for coverage review');
}
const finalSchemaVersion = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version;
db.pragma(`user_version = ${finalSchemaVersion}`);
db.exec('COMMIT');
} catch (error) {
  if (db.inTransaction) db.exec('ROLLBACK');
  throw error;
}

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
    visual_revision = CASE WHEN videos.fingerprint != excluded.fingerprint THEN NULL ELSE videos.visual_revision END,
    visual_title = CASE WHEN videos.fingerprint != excluded.fingerprint THEN NULL ELSE videos.visual_title END,
    visual_summary = CASE WHEN videos.fingerprint != excluded.fingerprint THEN NULL ELSE videos.visual_summary END,
    visual_uncertainty = CASE WHEN videos.fingerprint != excluded.fingerprint THEN NULL ELSE videos.visual_uncertainty END,
    visual_people_json = CASE WHEN videos.fingerprint != excluded.fingerprint THEN '[]' ELSE videos.visual_people_json END,
    visual_events_json = CASE WHEN videos.fingerprint != excluded.fingerprint THEN '[]' ELSE videos.visual_events_json END,
    visual_places_json = CASE WHEN videos.fingerprint != excluded.fingerprint THEN '[]' ELSE videos.visual_places_json END,
    visual_keywords_json = CASE WHEN videos.fingerprint != excluded.fingerprint THEN '[]' ELSE videos.visual_keywords_json END,
    visual_date_clues_json = CASE WHEN videos.fingerprint != excluded.fingerprint THEN '[]' ELSE videos.visual_date_clues_json END,
    visual_evidence_json = CASE WHEN videos.fingerprint != excluded.fingerprint THEN '[]' ELSE videos.visual_evidence_json END,
    visual_sampling_json = CASE WHEN videos.fingerprint != excluded.fingerprint THEN '{}' ELSE videos.visual_sampling_json END,
    visual_search_text = CASE WHEN videos.fingerprint != excluded.fingerprint THEN '' ELSE videos.visual_search_text END,
    visual_model = CASE WHEN videos.fingerprint != excluded.fingerprint THEN NULL ELSE videos.visual_model END,
    visual_prompt_version = CASE WHEN videos.fingerprint != excluded.fingerprint THEN NULL ELSE videos.visual_prompt_version END,
    visual_fingerprint = CASE WHEN videos.fingerprint != excluded.fingerprint THEN NULL ELSE videos.visual_fingerprint END,
    visual_error = CASE WHEN videos.fingerprint != excluded.fingerprint THEN NULL ELSE videos.visual_error END,
    visual_attempts = CASE WHEN videos.fingerprint != excluded.fingerprint THEN 0 ELSE videos.visual_attempts END,
    visual_next_attempt_at = CASE WHEN videos.fingerprint != excluded.fingerprint THEN NULL ELSE videos.visual_next_attempt_at END,
    visual_error_class = CASE WHEN videos.fingerprint != excluded.fingerprint THEN NULL ELSE videos.visual_error_class END,
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
    visual_evidence: JSON.parse(row.visual_evidence_json || '[]'),
    visual_sampling: JSON.parse(row.visual_sampling_json || '{}'),
    confirmed_people: JSON.parse(row.confirmed_people_json)
  };
}

function status() {
  const counts = db.prepare('SELECT status, COUNT(*) AS count FROM videos GROUP BY status').all();
  const scan = db.prepare('SELECT * FROM scans ORDER BY id DESC LIMIT 1').get();
  const visualCounts = db.prepare("SELECT COALESCE(visual_status, 'pending') AS status, COUNT(*) AS count FROM videos WHERE status != 'missing' GROUP BY COALESCE(visual_status, 'pending')").all();
  const visualReadyCounts = db.prepare("SELECT COALESCE(visual_status, 'pending') AS status, COUNT(*) AS count FROM videos WHERE status = 'done' GROUP BY COALESCE(visual_status, 'pending')").all();
  const visualRetryWait = db.prepare(`SELECT COUNT(*) AS count,
      SUM(CASE WHEN visual_next_attempt_at <= CURRENT_TIMESTAMP THEN 1 ELSE 0 END) AS ready_count,
      MIN(CASE WHEN visual_next_attempt_at > CURRENT_TIMESTAMP THEN visual_next_attempt_at END) AS next_at
    FROM videos WHERE visual_status = 'failed' AND visual_next_attempt_at IS NOT NULL`).get();
  const workerConfiguration = Object.fromEntries(db.prepare('SELECT worker, configuration_json, updated_at FROM worker_configuration')
    .all().map(row => [row.worker, { ...JSON.parse(row.configuration_json), updated_at: row.updated_at }]));
  const utcDay = new Date().toISOString().slice(0, 10);
  const dailyRequests = db.prepare('SELECT request_count FROM visual_daily_requests WHERE utc_day = ?').get(utcDay)?.request_count || 0;
  const dailyLimit = workerConfiguration.visual?.max_visual_requests_per_day || 0;
  const monthlyLimit = workerConfiguration.visual?.max_visual_cost_per_month_usd || 0;
  const utcMonth = `${utcDay.slice(0, 7)}-01`;
  const monthlyCost = getVisualMonthlySpend();
  const providerControl = getVisualProviderControl();
  const automationControl = getAutomationControl();
  const workerHistory = Object.fromEntries(['indexer', 'visual-analyzer'].map(worker => [worker,
    db.prepare(`SELECT id, status, started_at, heartbeat_at, finished_at, last_result, last_error
      FROM worker_run_history WHERE worker = ? ORDER BY id DESC LIMIT 10`).all(worker)
  ]));
  const workerActivity = Object.fromEntries(db.prepare('SELECT * FROM worker_runs').all().map(row => {
    let alive = null;
    if (row.owner_host === os.hostname()) {
      alive = true;
      try { process.kill(row.owner_pid, 0); }
      catch (error) { alive = error.code === 'ESRCH' ? false : true; }
    }
    return [row.worker, {
      status: row.status, active: row.status === 'running' && alive === true,
      stale: row.status === 'running' && alive === false, started_at: row.started_at,
      heartbeat_at: row.heartbeat_at, current_video_id: row.current_video_id,
      current_path: row.current_path, phase: row.phase, last_result: row.last_result,
      last_error: row.last_error, finished_at: row.finished_at
    }];
  }));
  return {
    schema_version: db.pragma('user_version', { simple: true }),
    applied_migrations: db.prepare('SELECT version, description, applied_at FROM schema_migrations ORDER BY version').all(),
    counts: Object.fromEntries(counts.map(row => [row.status, row.count])),
    visual_counts: Object.fromEntries(visualCounts.map(row => [row.status, row.count])),
    visual_ready_counts: Object.fromEntries(visualReadyCounts.map(row => [row.status, row.count])),
    visual_retry_wait: visualRetryWait,
    visual_daily_budget: {
      utc_day: utcDay, requests: dailyRequests, limit: dailyLimit,
      remaining: dailyLimit ? Math.max(0, dailyLimit - dailyRequests) : null
    },
    visual_monthly_budget: {
      utc_month: utcMonth.slice(0, 7), spent_usd: Number(monthlyCost.toFixed(6)),
      limit_usd: monthlyLimit, remaining_usd: monthlyLimit ? Number(Math.max(0, monthlyLimit - monthlyCost).toFixed(6)) : null
    },
    automation_control: automationControl,
    visual_provider_control: providerControl ? {
      paused: true, error_class: providerControl.error_class, reason: providerControl.reason,
      paused_at: providerControl.paused_at, paused_until: providerControl.paused_until
    } : { paused: false },
    last_scan: scan || null,
    worker_configuration: workerConfiguration,
    worker_history: workerHistory,
    worker_activity: workerActivity
  };
}

function reserveVisualDailyRequest(limit) {
  const utcDay = new Date().toISOString().slice(0, 10);
  const reserve = db.transaction(() => {
    const count = db.prepare('SELECT request_count FROM visual_daily_requests WHERE utc_day = ?').get(utcDay)?.request_count || 0;
    if (limit && count >= limit) return false;
    db.prepare(`INSERT INTO visual_daily_requests (utc_day, request_count) VALUES (?, 1)
      ON CONFLICT(utc_day) DO UPDATE SET request_count = request_count + 1`).run(utcDay);
    return true;
  });
  return reserve.immediate();
}

function getVisualMonthlySpend() {
  const utcMonth = `${new Date().toISOString().slice(0, 7)}-01`;
  return db.prepare(`SELECT visual_usage_json FROM videos
    WHERE visual_analyzed_at >= ? AND visual_usage_json IS NOT NULL`).all(utcMonth)
    .reduce((sum, row) => {
      try {
        const cost = Number(JSON.parse(row.visual_usage_json)?.cost);
        return Number.isFinite(cost) && cost >= 0 ? sum + cost : sum;
      } catch { return sum; }
    }, 0);
}

function getAutomationControl() {
  const row = db.prepare('SELECT paused, changed_at, changed_by FROM automation_control WHERE singleton = 1').get();
  const history = db.prepare(`SELECT paused, changed_by, changed_at FROM automation_control_history
    ORDER BY id DESC LIMIT 20`).all().map(item => ({ ...item, paused: Boolean(item.paused) }));
  return { paused: Boolean(row?.paused), changed_at: row?.changed_at || null,
    changed_by: row?.changed_by || null, history };
}

function setAutomationPaused(paused, changedBy = 'web') {
  const value = paused ? 1 : 0;
  const change = db.transaction(() => {
    db.prepare(`INSERT INTO automation_control (singleton, paused, changed_by)
      VALUES (1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET paused = excluded.paused,
      changed_at = CURRENT_TIMESTAMP, changed_by = excluded.changed_by`).run(value, changedBy);
    db.prepare('INSERT INTO automation_control_history (paused, changed_by) VALUES (?, ?)').run(value, changedBy);
    db.prepare('DELETE FROM automation_control_history WHERE id NOT IN
      (SELECT id FROM automation_control_history ORDER BY id DESC LIMIT 200)').run();
  });
  change.immediate();
  return getAutomationControl();
}

function getVisualProviderControl() {
  return db.prepare('SELECT error_class, reason, paused_at, paused_until, configuration_fingerprint FROM visual_provider_control WHERE singleton = 1').get() || null;
}

function setVisualProviderControl({ configurationFingerprint, errorClass, reason, pausedUntil = null }) {
  db.prepare(`INSERT INTO visual_provider_control
      (singleton, configuration_fingerprint, error_class, reason, paused_until)
    VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(singleton) DO UPDATE SET configuration_fingerprint = excluded.configuration_fingerprint,
      error_class = excluded.error_class, reason = excluded.reason,
      paused_at = CURRENT_TIMESTAMP, paused_until = excluded.paused_until`)
    .run(configurationFingerprint, errorClass, String(reason).slice(0, 500), pausedUntil);
}

function clearVisualProviderControl() {
  db.prepare('DELETE FROM visual_provider_control WHERE singleton = 1').run();
}

function setWorkerConfiguration(worker, configuration) {
  db.prepare(`INSERT INTO worker_configuration (worker, configuration_json) VALUES (?, ?)
    ON CONFLICT(worker) DO UPDATE SET configuration_json = excluded.configuration_json, updated_at = CURRENT_TIMESTAMP`)
    .run(worker, JSON.stringify(configuration));
}

function search({ query, from, to, personId, folder, limit, offset }) {
  const words = query.match(/[\p{L}\p{N}]+/gu)?.slice(0, 8) || [];
  const match = words.map(word => `"${word.replace(/"/g, '')}"*`).join(' AND ');
  const source = match ? 'video_fts JOIN videos ON videos.id = video_fts.rowid' : 'videos';
  const matching = match ? 'video_fts MATCH ? AND ' : '';
  const snippet = match ? "snippet(video_fts, 3, '⟦', '⟧', '…', 18) AS snippet" : 'NULL AS snippet';
  const ordering = match
    ? 'bm25(video_fts, 1.0, 5.0, 2.0, 1.0), videos.recorded_at IS NULL, videos.recorded_at DESC, videos.relative_path'
    : 'videos.recorded_at IS NULL, videos.recorded_at DESC, videos.relative_path';
  const args = match ? [match] : [];
  const rows = db.prepare(`SELECT videos.id, videos.relative_path, videos.recorded_at, videos.date_source,
      videos.status, videos.visual_title, videos.visual_summary, videos.visual_events_json, ${snippet}
    FROM ${source}
    WHERE ${matching}(? IS NULL OR videos.recorded_at >= ?)
      AND (? IS NULL OR videos.recorded_at <= ?)
      AND (? IS NULL OR EXISTS (
        SELECT 1 FROM video_person_observations vpo
        WHERE vpo.video_id = videos.id AND vpo.analysis_revision = videos.visual_revision AND vpo.person_id = ?
      ))
      AND (? IS NULL OR videos.relative_path = ? OR substr(videos.relative_path, 1, length(?) + 1) = ? || '/')
      AND videos.status != 'missing'
    ORDER BY ${ordering}
    LIMIT ? OFFSET ?`).all(...args, from, from, to, to, personId ?? null, personId ?? null,
      folder ?? null, folder ?? null, folder ?? null, folder ?? null, limit, offset);
  const normalizedWords = words.map(word => word.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase());
  return rows.map(row => {
    let matchAtSeconds = null;
    if (normalizedWords.length) {
      try {
        const events = JSON.parse(row.visual_events_json);
        const scored = events.map(event => {
          const description = String(event.description || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase();
          const score = normalizedWords.filter(word => description.includes(word)).length;
          return { score, at_seconds: event.at_seconds };
        }).filter(event => event.score > 0 && Number.isFinite(event.at_seconds));
        scored.sort((a, b) => b.score - a.score || a.at_seconds - b.at_seconds);
        if (scored.length) matchAtSeconds = scored[0].at_seconds;
      } catch {}
    }
    delete row.visual_events_json;
    row.match_at_seconds = matchAtSeconds;
    return row;
  });
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

function setConfirmedPeople(relativePath, expectedRevision, names) {
  if (typeof expectedRevision !== 'string' || !expectedRevision || expectedRevision.length > 200) return false;
  const update = db.transaction(() => {
    const row = getByPath.get(relativePath);
    if (!row) return false;
    if (row.visual_revision !== expectedRevision) {
      const error = new Error('La ficha cambió desde que la abriste. Recargá y volvé a intentar.');
      error.code = 'STALE_VISUAL_REVISION';
      throw error;
    }
    const assignedNames = db.prepare(`SELECT people.name FROM video_person_observations
      JOIN people ON people.id = video_person_observations.person_id
      WHERE video_id = ? AND analysis_revision = ?`).all(row.id, row.visual_revision).map(item => item.name);
    const searchText = buildVisualSearchText({
      events: JSON.parse(row.visual_events_json),
      people: JSON.parse(row.visual_people_json),
      places: JSON.parse(row.visual_places_json),
      keywords: JSON.parse(row.visual_keywords_json),
      dateClues: JSON.parse(row.visual_date_clues_json),
      confirmedPeople: [...names, ...assignedNames]
    });
    db.prepare(`UPDATE videos SET confirmed_people_json = ?, visual_search_text = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND visual_revision = ?`).run(JSON.stringify(names), searchText, row.id, expectedRevision);
    return true;
  });
  return update.immediate();
}

function listPeople() {
  return db.prepare(`SELECT people.id, people.name,
      COUNT(video_person_observations.video_id) AS appearances,
      COUNT(DISTINCT video_person_observations.video_id) AS videos
    FROM people LEFT JOIN video_person_observations ON people.id = video_person_observations.person_id
      AND video_person_observations.analysis_revision = (SELECT visual_revision FROM videos WHERE id = video_person_observations.video_id)
      AND (SELECT status FROM videos WHERE id = video_person_observations.video_id) != 'missing'
    WHERE people.merged_into IS NULL
    GROUP BY people.id ORDER BY people.name COLLATE NOCASE`).all();
}

function renamePerson(personId, newName) {
  if (!Number.isSafeInteger(personId) || personId < 1 || typeof newName !== 'string') {
    throw new Error('ID o nombre inválido');
  }
  const name = newName.trim().replace(/\s+/g, ' ');
  if (!name || name.length > 80) throw new Error('El nombre debe tener entre 1 y 80 caracteres');
  const rename = db.transaction(() => {
    const existing = db.prepare('SELECT id, name, merged_into FROM people WHERE id = ?').get(personId);
    if (!existing || existing.merged_into != null) return null;
    const duplicate = db.prepare('SELECT id FROM people WHERE name = ? COLLATE NOCASE AND id != ?').get(name, personId);
    if (duplicate) throw new Error('Ya existe una persona con ese nombre');
    db.prepare('UPDATE people SET name = ? WHERE id = ?').run(name, personId);
    const affectedVideos = db.prepare(`SELECT videos.* FROM videos
      WHERE videos.id IN (SELECT video_id FROM video_person_observations
        WHERE person_id = ? AND analysis_revision = videos.visual_revision)
      AND videos.visual_status = 'done'`).all(personId);
    for (const row of affectedVideos) {
      const assignedNames = db.prepare(`SELECT people.name FROM video_person_observations
        JOIN people ON people.id = video_person_observations.person_id
        WHERE video_id = ? AND analysis_revision = ?`).all(row.id, row.visual_revision).map(item => item.name);
      const searchText = buildVisualSearchText({
        events: JSON.parse(row.visual_events_json), people: JSON.parse(row.visual_people_json),
        places: JSON.parse(row.visual_places_json), keywords: JSON.parse(row.visual_keywords_json),
        dateClues: JSON.parse(row.visual_date_clues_json),
        confirmedPeople: [...JSON.parse(row.confirmed_people_json), ...assignedNames]
      });
      db.prepare('UPDATE videos SET visual_search_text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(searchText, row.id);
    }
    return db.prepare('SELECT id, name FROM people WHERE id = ?').get(personId);
  });
  return rename.immediate();
}

function refreshSearchTextForVideos(videoIds) {
  const uniqueIds = [...new Set(videoIds)];
  for (const videoId of uniqueIds) {
    const row = getById.get(videoId);
    if (!row || row.status === 'missing' || row.visual_status !== 'done') continue;
    const assignedNames = db.prepare(`SELECT people.name FROM video_person_observations
      JOIN people ON people.id = video_person_observations.person_id
      WHERE video_id = ? AND analysis_revision = ?`).all(row.id, row.visual_revision).map(item => item.name);
    const searchText = buildVisualSearchText({
      events: JSON.parse(row.visual_events_json), people: JSON.parse(row.visual_people_json),
      places: JSON.parse(row.visual_places_json), keywords: JSON.parse(row.visual_keywords_json),
      dateClues: JSON.parse(row.visual_date_clues_json),
      confirmedPeople: [...JSON.parse(row.confirmed_people_json), ...assignedNames]
    });
    db.prepare('UPDATE videos SET visual_search_text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(searchText, row.id);
  }
}

function mergePeople(sourcePersonId, targetPersonId) {
  if (!Number.isSafeInteger(sourcePersonId) || sourcePersonId < 1 ||
      !Number.isSafeInteger(targetPersonId) || targetPersonId < 1 || sourcePersonId === targetPersonId) {
    throw new Error('IDs de personas inválidos');
  }
  const merge = db.transaction(() => {
    const source = db.prepare('SELECT id, name, merged_into FROM people WHERE id = ?').get(sourcePersonId);
    const target = db.prepare('SELECT id, name, merged_into FROM people WHERE id = ?').get(targetPersonId);
    if (!source || !target || source.merged_into != null || target.merged_into != null) return null;
    const activeMerge = db.prepare(`SELECT id FROM person_merge_history WHERE status = 'active'
      AND (source_person_id IN (?, ?) OR target_person_id IN (?, ?)) LIMIT 1`)
      .get(sourcePersonId, targetPersonId, sourcePersonId, targetPersonId);
    if (activeMerge) throw new Error('Deshacé primero la fusión activa antes de volver a combinar estas personas');
    const insertMerge = db.prepare(`INSERT INTO person_merge_history
      (source_person_id, target_person_id, source_name, target_name) VALUES (?, ?, ?, ?)`)
      .run(sourcePersonId, targetPersonId, source.name, target.name);
    const mergeId = Number(insertMerge.lastInsertRowid);
    const observations = db.prepare(`SELECT video_id, analysis_revision, observation_index
      FROM video_person_observations WHERE person_id = ?`).all(sourcePersonId);
    const saveObservation = db.prepare(`INSERT INTO person_merge_observations
      (merge_id, video_id, analysis_revision, observation_index) VALUES (?, ?, ?, ?)`);
    for (const observation of observations) {
      saveObservation.run(mergeId, observation.video_id, observation.analysis_revision, observation.observation_index);
    }
    db.prepare('UPDATE video_person_observations SET person_id = ? WHERE person_id = ?')
      .run(targetPersonId, sourcePersonId);
    db.prepare('UPDATE people SET merged_into = ? WHERE id = ?').run(targetPersonId, sourcePersonId);
    refreshSearchTextForVideos(observations.map(item => item.video_id));
    return { id: mergeId, source_person_id: sourcePersonId, target_person_id: targetPersonId,
      source_name: source.name, target_name: target.name, status: 'active',
      moved_observations: observations.length };
  });
  return merge.immediate();
}

function undoPeopleMerge(mergeId) {
  if (!Number.isSafeInteger(mergeId) || mergeId < 1) throw new Error('ID de fusión inválido');
  const undo = db.transaction(() => {
    const merge = db.prepare(`SELECT * FROM person_merge_history WHERE id = ? AND status = 'active'`).get(mergeId);
    if (!merge) return null;
    const source = db.prepare('SELECT merged_into FROM people WHERE id = ?').get(merge.source_person_id);
    const target = db.prepare('SELECT merged_into FROM people WHERE id = ?').get(merge.target_person_id);
    if (!source || source.merged_into !== merge.target_person_id || !target || target.merged_into != null) {
      throw new Error('No se puede deshacer: cambió el estado de alguna persona');
    }
    const observations = db.prepare(`SELECT video_id, analysis_revision, observation_index
      FROM person_merge_observations WHERE merge_id = ?`).all(mergeId);
    const restore = db.prepare(`UPDATE video_person_observations SET person_id = ?
      WHERE video_id = ? AND analysis_revision = ? AND observation_index = ? AND person_id = ?`);
    const affectedVideos = [];
    let restored = 0;
    for (const observation of observations) {
      const result = restore.run(merge.source_person_id, observation.video_id,
        observation.analysis_revision, observation.observation_index, merge.target_person_id);
      if (result.changes) {
        restored += result.changes;
        affectedVideos.push(observation.video_id);
      }
    }
    db.prepare('UPDATE people SET merged_into = NULL WHERE id = ?').run(merge.source_person_id);
    db.prepare("UPDATE person_merge_history SET status = 'undone', undone_at = CURRENT_TIMESTAMP WHERE id = ?").run(mergeId);
    refreshSearchTextForVideos(affectedVideos);
    return { id: mergeId, source_person_id: merge.source_person_id,
      target_person_id: merge.target_person_id, status: 'undone', restored_observations: restored };
  });
  return undo.immediate();
}

function listPersonMerges() {
  return db.prepare(`SELECT id, source_person_id, target_person_id, source_name, target_name,
      status, merged_at, undone_at FROM person_merge_history ORDER BY id DESC LIMIT 50`).all();
}

function identifiedPeopleForVideo(videoId) {
  return Object.fromEntries(db.prepare(`SELECT observation_index, people.id AS person_id, people.name
    FROM video_person_observations JOIN people ON people.id = video_person_observations.person_id
    JOIN videos ON videos.id = video_person_observations.video_id
    WHERE video_id = ? AND video_person_observations.analysis_revision = videos.visual_revision`)
    .all(videoId).map(row => [row.observation_index, { id: row.person_id, name: row.name }]));
}

function identityTokens(value) {
  const ignored = new Set(['con', 'del', 'una', 'uno', 'los', 'las', 'que', 'por', 'para', 'persona', 'grupo', 'alguien']);
  return new Set(String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase()
    .match(/[\p{L}\p{N}]+/gu)?.filter(token => token.length > 2 && !ignored.has(token)) || []);
}

function suggestObservationMatches(previous, currentObservations) {
  const previousTokens = identityTokens(previous.description);
  if (!previousTokens.size) return [];
  return currentObservations.map((observation, observationIndex) => {
    const currentTokens = identityTokens(observation.description);
    const intersection = [...previousTokens].filter(token => currentTokens.has(token)).length;
    const union = new Set([...previousTokens, ...currentTokens]).size;
    const textSimilarity = union ? intersection / union : 0;
    const timeSimilarity = Math.max(0, 1 - Math.abs(Number(previous.at_seconds) - Number(observation.at_seconds)) / 30);
    const score = Math.round((textSimilarity * 0.75 + timeSimilarity * 0.25) * 100);
    return { observation_index: observationIndex, description: observation.description,
      at_seconds: observation.at_seconds, score, text_similarity: Number(textSimilarity.toFixed(3)) };
  }).filter(item => item.text_similarity >= 0.2)
    .sort((a, b) => b.score - a.score || a.observation_index - b.observation_index).slice(0, 3);
}

function staleIdentificationsForVideo(videoId) {
  const video = getById.get(videoId);
  if (!video) return [];
  let currentObservations = [];
  try { currentObservations = JSON.parse(video.visual_people_json || '[]'); } catch {}
  return db.prepare(`SELECT video_person_observations.observation_description AS description,
      video_person_observations.at_seconds, people.id AS person_id, people.name, video_person_observations.confirmed_at,
      video_person_observations.analysis_revision, video_person_observations.observation_index
    FROM video_person_observations JOIN people ON people.id = video_person_observations.person_id
      JOIN videos ON videos.id = video_person_observations.video_id
    WHERE video_id = ? AND video_person_observations.analysis_revision != COALESCE(videos.visual_revision, '')
      AND video_person_observations.reviewed_at IS NULL
    ORDER BY video_person_observations.confirmed_at DESC, video_person_observations.observation_index`).all(videoId)
    .map(previous => ({ ...previous, suggested_matches: suggestObservationMatches(previous, currentObservations) }));
}

function identityHistoryForVideo(videoId) {
  return db.prepare(`SELECT id, analysis_revision, observation_index, previous_name, person_name,
      stale_person_name, action, stale_revision, stale_observation_index, changed_at
    FROM video_person_identity_history WHERE video_id = ? ORDER BY id DESC LIMIT 100`).all(videoId);
}

function dismissStaleIdentification({ relativePath, analysisRevision, observationIndex }) {
  const row = getByPath.get(relativePath);
  if (!row || typeof analysisRevision !== 'string' || !analysisRevision ||
      !Number.isInteger(observationIndex) || observationIndex < 0) return false;
  const dismiss = db.transaction(() => {
    const video = db.prepare('SELECT visual_revision FROM videos WHERE id = ?').get(row.id);
    if (!video) return false;
    const stale = db.prepare(`SELECT video_person_observations.person_id, people.name
      FROM video_person_observations JOIN people ON people.id = video_person_observations.person_id
      WHERE video_id = ? AND analysis_revision = ? AND observation_index = ?
        AND analysis_revision != COALESCE(?, '') AND reviewed_at IS NULL`)
      .get(row.id, analysisRevision, observationIndex, video.visual_revision);
    if (!stale) return false;
    const result = db.prepare(`UPDATE video_person_observations SET reviewed_at = CURRENT_TIMESTAMP
      WHERE video_id = ? AND analysis_revision = ? AND observation_index = ? AND reviewed_at IS NULL`)
      .run(row.id, analysisRevision, observationIndex);
    if (result.changes !== 1) return false;
    db.prepare(`INSERT INTO video_person_identity_history
      (video_id, analysis_revision, observation_index, previous_person_id, previous_name,
       person_id, person_name, action)
      VALUES (?, ?, ?, ?, ?, NULL, NULL, 'dismissed')`)
      .run(row.id, analysisRevision, observationIndex, stale.person_id, stale.name);
    return true;
  });
  return dismiss.immediate();
}

function setVideoPerson({ relativePath, expectedRevision, observationIndex, personId, personName, staleObservation }) {
  if (typeof expectedRevision !== 'string' || !expectedRevision || expectedRevision.length > 200 ||
      !Number.isInteger(observationIndex) || observationIndex < 0) return false;
  const assign = db.transaction(() => {
    const row = getByPath.get(relativePath);
    if (!row || !Number.isInteger(observationIndex) || observationIndex < 0) return false;
    if (row.visual_revision !== expectedRevision) {
      const error = new Error('La ficha cambió desde que la abriste. Recargá y volvé a intentar.');
      error.code = 'STALE_VISUAL_REVISION';
      throw error;
    }
    const observations = JSON.parse(row.visual_people_json);
    if (row.visual_status !== 'done' || !row.visual_revision || observationIndex >= observations.length) return false;
    const previous = db.prepare(`SELECT video_person_observations.person_id, people.name
      FROM video_person_observations JOIN people ON people.id = video_person_observations.person_id
      WHERE video_id = ? AND analysis_revision = ? AND observation_index = ?`)
      .get(row.id, row.visual_revision, observationIndex);
    let stalePersonName = null;
    if (personName) {
      const name = personName.trim().replace(/\s+/g, ' ');
      if (!name || name.length > 80) throw new Error('El nombre debe tener entre 1 y 80 caracteres');
      db.prepare('INSERT INTO people (name) VALUES (?) ON CONFLICT(name) DO NOTHING').run(name);
      personId = db.prepare('SELECT id FROM people WHERE name = ? COLLATE NOCASE').get(name)?.id;
    }
    if (personId == null) {
      db.prepare('DELETE FROM video_person_observations WHERE video_id = ? AND analysis_revision = ? AND observation_index = ?')
        .run(row.id, row.visual_revision, observationIndex);
    } else {
      const person = db.prepare('SELECT id, merged_into FROM people WHERE id = ?').get(personId);
      if (!person || person.merged_into != null) throw new Error('Persona desconocida');
      db.prepare(`INSERT INTO video_person_observations
        (video_id, analysis_revision, observation_index, observation_description, at_seconds, person_id)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(video_id, analysis_revision, observation_index) DO UPDATE SET
          observation_description = excluded.observation_description, at_seconds = excluded.at_seconds,
          person_id = excluded.person_id, confirmed_at = CURRENT_TIMESTAMP`)
        .run(row.id, row.visual_revision, observationIndex, observations[observationIndex].description,
          observations[observationIndex].at_seconds, personId);
    }

    if (staleObservation) {
      if (personId == null) throw new Error('Reconciliar una observación anterior requiere una persona asignada');
      const staleIdentity = db.prepare(`SELECT people.name FROM video_person_observations
        JOIN people ON people.id = video_person_observations.person_id
        WHERE video_id = ? AND analysis_revision = ? AND observation_index = ?
          AND analysis_revision != ? AND reviewed_at IS NULL`)
        .get(row.id, staleObservation.analysisRevision, staleObservation.observationIndex, row.visual_revision);
      if (!staleIdentity) throw new Error('La asignación anterior ya no está pendiente de revisión');
      stalePersonName = staleIdentity.name;
      const reviewed = db.prepare(`UPDATE video_person_observations SET reviewed_at = CURRENT_TIMESTAMP
        WHERE video_id = ? AND analysis_revision = ? AND observation_index = ?
          AND analysis_revision != ? AND reviewed_at IS NULL`)
        .run(row.id, staleObservation.analysisRevision, staleObservation.observationIndex, row.visual_revision);
      if (reviewed.changes !== 1) throw new Error('La asignación anterior ya no está pendiente de revisión');
    }

    const nextPerson = personId == null ? null : db.prepare('SELECT id, name FROM people WHERE id = ?').get(personId);
    if (staleObservation || (previous?.person_id ?? null) !== (personId ?? null)) {
      const action = staleObservation ? 'reconciled'
        : personId == null ? 'removed' : previous ? 'changed' : 'assigned';
      db.prepare(`INSERT INTO video_person_identity_history
        (video_id, analysis_revision, observation_index, previous_person_id, previous_name,
         person_id, person_name, action, stale_revision, stale_observation_index, stale_person_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(row.id, row.visual_revision, observationIndex, previous?.person_id ?? null, previous?.name ?? null,
          nextPerson?.id ?? null, nextPerson?.name ?? null, action,
          staleObservation?.analysisRevision ?? null, staleObservation?.observationIndex ?? null, stalePersonName);
    }

    const assignedNames = db.prepare(`SELECT people.name FROM video_person_observations
      JOIN people ON people.id = video_person_observations.person_id
      WHERE video_id = ? AND analysis_revision = ?`).all(row.id, row.visual_revision).map(item => item.name);
    const searchText = buildVisualSearchText({
      events: JSON.parse(row.visual_events_json), people: observations,
      places: JSON.parse(row.visual_places_json), keywords: JSON.parse(row.visual_keywords_json),
      dateClues: JSON.parse(row.visual_date_clues_json),
      confirmedPeople: [...JSON.parse(row.confirmed_people_json), ...assignedNames]
    });
    db.prepare('UPDATE videos SET visual_search_text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(searchText, row.id);
    return personId == null ? null : db.prepare('SELECT id, name FROM people WHERE id = ?').get(personId);
  });
  return assign();
}

module.exports = {
  db, getByPath, getById, upsert, parseVideo, status, search, buildVisualSearchText,
  setConfirmedPeople, listPeople, identifiedPeopleForVideo, staleIdentificationsForVideo, identityHistoryForVideo,
  dismissStaleIdentification,
  setVideoPerson, renamePerson, mergePeople, undoPeopleMerge, listPersonMerges,
  withJobLock, setWorkerConfiguration, setWorkerActivity, reserveVisualDailyRequest,
  getVisualProviderControl, setVisualProviderControl, clearVisualProviderControl, getVisualMonthlySpend,
  getAutomationControl, setAutomationPaused
};
