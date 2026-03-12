const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'logs.db');

// Ensure the data directory exists
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS log_entries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    import_id   INTEGER,
    ip          TEXT,
    timestamp   DATETIME,
    method      TEXT,
    path        TEXT,
    protocol    TEXT,
    status      INTEGER,
    bytes       INTEGER,
    referer     TEXT,
    user_agent  TEXT
  );

  CREATE TABLE IF NOT EXISTS imports (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    filename     TEXT,
    total_lines  INTEGER,
    parsed_lines INTEGER,
    imported_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_timestamp ON log_entries(timestamp);
  CREATE INDEX IF NOT EXISTS idx_status    ON log_entries(status);
  CREATE INDEX IF NOT EXISTS idx_ip        ON log_entries(ip);
  CREATE INDEX IF NOT EXISTS idx_import    ON log_entries(import_id);
`);

// Migrations — each is a no-op if the column/index already exists
try { db.exec('ALTER TABLE imports ADD COLUMN client TEXT'); } catch (_) {} // legacy name
try { db.exec('ALTER TABLE imports RENAME COLUMN client TO instance'); } catch (_) {}
try { db.exec('ALTER TABLE imports ADD COLUMN inserted_lines INTEGER'); } catch (_) {}
try { db.exec('ALTER TABLE log_entries ADD COLUMN line_hash TEXT'); } catch (_) {}
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_line_hash ON log_entries(line_hash)'); } catch (_) {}

// Job queue schema
db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    status         TEXT DEFAULT 'pending',
    filename       TEXT,
    file_path      TEXT,
    instance       TEXT,
    parsed_lines   INTEGER DEFAULT 0,
    import_id      INTEGER,
    error          TEXT,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    started_at     DATETIME,
    completed_at   DATETIME
  );
`);

// On startup, reset any jobs that were interrupted mid-processing back to pending
db.prepare("UPDATE jobs SET status = 'pending', started_at = NULL, parsed_lines = 0 WHERE status = 'processing'").run();

// Create a placeholder import record and return its id.
// Line counts are written later via finalizeImport().
function insertImport(filename, instance) {
  const result = db.prepare(
    'INSERT INTO imports (filename, instance) VALUES (?, ?)'
  ).run(filename, instance || null);
  return result.lastInsertRowid;
}

// Write final line counts to an import record after streaming is complete.
function finalizeImport(importId, totalLines, parsedLines, insertedLines) {
  db.prepare(
    'UPDATE imports SET total_lines = ?, parsed_lines = ?, inserted_lines = ? WHERE id = ?'
  ).run(totalLines, parsedLines, insertedLines, importId);
}

// Insert a batch of log entries in a single transaction.
// Uses INSERT OR IGNORE so duplicate line_hash values are silently skipped.
// Returns the number of rows actually inserted.
const insertEntryStmt = db.prepare(`
  INSERT OR IGNORE INTO log_entries (import_id, ip, timestamp, method, path, protocol, status, bytes, referer, user_agent, line_hash)
  VALUES (@importId, @ip, @timestamp, @method, @path, @protocol, @status, @bytes, @referer, @userAgent, @lineHash)
`);

function insertEntries(importId, entries) {
  let inserted = 0;
  const insertBatch = db.transaction((rows) => {
    for (const row of rows) {
      const result = insertEntryStmt.run({ importId, ...row, lineHash: row.lineHash || null });
      inserted += result.changes;
    }
  });
  insertBatch(entries);
  return inserted;
}

// Remove an import record (used to roll back a zero-insert upload)
function deleteImport(importId) {
  db.prepare('DELETE FROM imports WHERE id = ?').run(importId);
}

// Return all imports ordered by most recent first
function getImports() {
  return db.prepare('SELECT * FROM imports ORDER BY imported_at DESC').all();
}

// Build a WHERE clause from any combination of filter params.
// Uses SQLite string escaping for text values (single-user local tool).
function buildFilter({ import_id, instance, path_filter, date_from, date_to } = {}) {
  const esc = (s) => String(s).replace(/'/g, "''");
  const conditions = [];
  if (import_id)   conditions.push(`import_id = ${Number(import_id)}`);
  if (instance)    conditions.push(`import_id IN (SELECT id FROM imports WHERE instance = '${esc(instance)}')`);
  if (path_filter) conditions.push(`path LIKE '%${esc(path_filter)}%'`);
  if (date_from)   conditions.push(`date(timestamp) >= '${esc(date_from)}'`);
  if (date_to)     conditions.push(`date(timestamp) <= '${esc(date_to)}'`);
  return conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
}

// ── Job queue helpers ────────────────────────────────────────────────────────

function createJob(filename, filePath, instance) {
  const result = db.prepare(
    'INSERT INTO jobs (filename, file_path, instance) VALUES (?, ?, ?)'
  ).run(filename, filePath, instance || null);
  return result.lastInsertRowid;
}

function startJob(jobId) {
  db.prepare(
    "UPDATE jobs SET status = 'processing', started_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(jobId);
}

function updateJobProgress(jobId, parsedLines) {
  db.prepare('UPDATE jobs SET parsed_lines = ? WHERE id = ?').run(parsedLines, jobId);
}

function completeJob(jobId, importId) {
  db.prepare(
    "UPDATE jobs SET status = 'done', import_id = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(importId, jobId);
}

function failJob(jobId, error) {
  db.prepare(
    "UPDATE jobs SET status = 'error', error = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(error, jobId);
}

function getJob(jobId) {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
}

function getPendingJob() {
  return db.prepare("SELECT * FROM jobs WHERE status = 'pending' ORDER BY id ASC LIMIT 1").get();
}

function getJobs() {
  return db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all();
}

module.exports = {
  db,
  insertImport, finalizeImport, insertEntries, deleteImport, getImports, buildFilter,
  createJob, startJob, updateJobProgress, completeJob, failJob, getJob, getPendingJob, getJobs,
};
