const express = require('express');
const { db, getImports, buildFilter, getJob, getJobs } = require('../db');

const router = express.Router();

// GET /api/imports — upload history
router.get('/imports', (_req, res) => {
  res.json(getImports());
});

// GET /api/instances — distinct instance names for the filter dropdown
router.get('/instances', (_req, res) => {
  const rows = db.prepare(
    `SELECT DISTINCT instance FROM imports WHERE instance IS NOT NULL ORDER BY instance ASC`
  ).all();
  res.json(rows.map(r => r.instance));
});

// GET /api/overview — KPI totals
router.get('/overview', (req, res) => {
  const w = buildFilter(req.query);
  const row = db.prepare(`
    SELECT
      COUNT(*)                                          AS total_requests,
      COUNT(DISTINCT ip)                                AS unique_ips,
      COALESCE(SUM(bytes), 0)                           AS total_bytes,
      COALESCE(ROUND(
        100.0 * SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END)
        / NULLIF(COUNT(*), 0)
      , 2), 0)                                          AS error_rate
    FROM log_entries ${w}
  `).get();
  res.json(row);
});

// GET /api/requests-over-time — hourly request counts
router.get('/requests-over-time', (req, res) => {
  const w = buildFilter(req.query);
  const rows = db.prepare(`
    SELECT
      strftime('%Y-%m-%d %H:00', timestamp) AS hour,
      COUNT(*)                              AS count
    FROM log_entries ${w}
    GROUP BY hour
    ORDER BY hour ASC
  `).all();
  res.json(rows);
});

// GET /api/status-codes — count per HTTP status code
router.get('/status-codes', (req, res) => {
  const w = buildFilter(req.query);
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM log_entries ${w}
    GROUP BY status
    ORDER BY count DESC
  `).all();
  res.json(rows);
});

// GET /api/top-ips — top 10 client IPs
router.get('/top-ips', (req, res) => {
  const w = buildFilter(req.query);
  const rows = db.prepare(`
    SELECT ip, COUNT(*) AS count
    FROM log_entries ${w}
    GROUP BY ip
    ORDER BY count DESC
    LIMIT 10
  `).all();
  res.json(rows);
});

// GET /api/top-paths — top 10 requested URL paths
router.get('/top-paths', (req, res) => {
  const w = buildFilter(req.query);
  const rows = db.prepare(`
    SELECT path, COUNT(*) AS count
    FROM log_entries ${w}
    GROUP BY path
    ORDER BY count DESC
    LIMIT 10
  `).all();
  res.json(rows);
});

// GET /api/top-user-agents — top 10 user agents (nulls excluded)
router.get('/top-user-agents', (req, res) => {
  const w = buildFilter(req.query);
  const extra = w ? `${w} AND user_agent IS NOT NULL` : 'WHERE user_agent IS NOT NULL';
  const rows = db.prepare(`
    SELECT user_agent, COUNT(*) AS count
    FROM log_entries ${extra}
    GROUP BY user_agent
    ORDER BY count DESC
    LIMIT 10
  `).all();
  res.json(rows);
});

// GET /api/methods — HTTP method distribution
router.get('/methods', (req, res) => {
  const w = buildFilter(req.query);
  const rows = db.prepare(`
    SELECT method, COUNT(*) AS count
    FROM log_entries ${w}
    GROUP BY method
    ORDER BY count DESC
  `).all();
  res.json(rows);
});

// GET /api/hourly-heatmap — count by hour-of-day (0-23) × weekday (0=Sun…6=Sat)
router.get('/hourly-heatmap', (req, res) => {
  const w = buildFilter(req.query);
  const rows = db.prepare(`
    SELECT
      CAST(strftime('%H', timestamp) AS INTEGER) AS hour,
      CAST(strftime('%w', timestamp) AS INTEGER) AS weekday,
      COUNT(*) AS count
    FROM log_entries ${w}
    GROUP BY hour, weekday
    ORDER BY weekday, hour
  `).all();
  res.json(rows);
});

// GET /api/5xx-by-file — 5XX error count + last occurrence per (path, status code)
router.get('/5xx-by-file', (req, res) => {
  const { import_id, instance, path_filter, date_from, date_to } = req.query;
  const esc = (s) => String(s).replace(/'/g, "''");
  const conditions = ['status >= 500'];
  if (import_id)   conditions.push(`import_id = ${Number(import_id)}`);
  if (instance)    conditions.push(`import_id IN (SELECT id FROM imports WHERE instance = '${esc(instance)}')`);
  if (path_filter) conditions.push(`path LIKE '%${esc(path_filter)}%'`);
  if (date_from)   conditions.push(`date(timestamp) >= '${esc(date_from)}'`);
  if (date_to)     conditions.push(`date(timestamp) <= '${esc(date_to)}'`);
  const rows = db.prepare(`
    SELECT
      path,
      status,
      COUNT(*)         AS count,
      MAX(timestamp)   AS last_occurrence
    FROM log_entries
    WHERE ${conditions.join(' AND ')}
    GROUP BY path, status
    ORDER BY count DESC
    LIMIT 50
  `).all();
  res.json(rows);
});

// GET /api/jobs — all jobs ordered by most recent first
router.get('/jobs', (_req, res) => {
  res.json(getJobs());
});

// GET /api/jobs/:id — single job status
router.get('/jobs/:id', (req, res) => {
  const job = getJob(Number(req.params.id));
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

module.exports = router;
