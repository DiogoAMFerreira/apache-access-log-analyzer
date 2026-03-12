# AccessDashboards — Application Specification

A Dockerized web app that accepts Apache `access.log` uploads, parses and
persists them in SQLite, and renders interactive dashboards with traffic metrics.

---

## Stack

| Layer     | Technology                          |
|-----------|-------------------------------------|
| Runtime   | Node.js 20 (Alpine in Docker)       |
| Framework | Express 4                           |
| Database  | SQLite via `better-sqlite3` (sync)  |
| Upload    | Multer (disk storage)               |
| Charts    | Chart.js 4 (CDN)                    |
| Frontend  | Vanilla HTML/CSS/JS — no build step |

---

## File Structure

```
AccessDashboards/
├── PLAN.md
├── SPECIFICATION.md          ← this file
├── Dockerfile
├── docker-compose.yml
├── package.json
├── .gitignore
├── examples/
│   └── access.log            # sample log for testing
├── src/
│   ├── app.js                # Express entry point
│   ├── db.js                 # SQLite connection, schema, helpers
│   ├── parser.js             # Apache log regex parser
│   ├── routes/
│   │   ├── upload.js         # POST /upload
│   │   └── api.js            # GET /api/*
│   └── public/
│       ├── index.html        # Upload page + import history
│       ├── dashboard.html    # Dashboard page
│       └── js/
│           └── dashboard.js  # Chart.js rendering + data fetching
├── uploads/                  # Multer temp dir (gitignored)
└── data/                     # SQLite .db file (Docker volume, gitignored)
```

---

## Database Schema (`src/db.js`)

```sql
CREATE TABLE log_entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id   INTEGER,       -- FK → imports.id
  ip          TEXT,
  timestamp   DATETIME,      -- ISO 8601, e.g. "2023-10-11T08:14:34+00:00"
  method      TEXT,
  path        TEXT,
  protocol    TEXT,
  status      INTEGER,
  bytes       INTEGER,       -- 0 when Apache logged "-"
  referer     TEXT,          -- NULL when "-"
  user_agent  TEXT,          -- NULL when "-"
  line_hash   TEXT           -- SHA-256 of raw log line; UNIQUE for deduplication
);

CREATE TABLE imports (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  filename       TEXT,
  total_lines    INTEGER,
  parsed_lines   INTEGER,
  inserted_lines INTEGER,    -- lines actually inserted (parsed_lines − duplicates)
  instance       TEXT,       -- optional instance label set at upload time
  imported_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

Indexes: `idx_timestamp`, `idx_status`, `idx_ip`, `idx_import`, `idx_line_hash` (UNIQUE).
WAL mode is enabled for better concurrent read performance.
New columns (`instance`, `inserted_lines`, `line_hash`) and the `idx_line_hash` unique index
are added via `ALTER TABLE` / `CREATE UNIQUE INDEX IF NOT EXISTS` on startup — no-ops on
existing databases that already have them. The legacy `client` column is renamed to `instance`
via `ALTER TABLE imports RENAME COLUMN client TO instance` on startup.

DB path defaults to `./data/logs.db`; overridden by the `DB_PATH` env var.

---

## Log Parser (`src/parser.js`)

Handles two Apache log formats with a single regex:

**Standard Combined Log Format** (`%h %l %u %t "%r" %>s %b "%{Referer}i" "%{User-Agent}i"`):
```
192.168.1.1 - frank [10/Oct/2000:13:55:36 -0700] "GET /file HTTP/1.0" 200 2326 "-" "Mozilla/4.08"
```

**VirtualHost Combined Format** (`%v:%p %h %l %u %t ...`):
```
172.18.0.2:80 172.18.0.1 - - [11/Oct/2023:08:14:34 +0000] "GET / HTTP/1.1" 302 209 "-" "Mozilla/5.0"
```

The optional `(?:\S+:\d+ )?` prefix in the regex skips the `host:port` field
when present. The client IP is always the first field after this optional prefix.

`parseLine(line)` → `{ ip, timestamp, method, path, protocol, status, bytes, referer, userAgent }` or `null`

`parseFile(filepath)` → `{ entries[], totalLines, parsedLines }` — streams the
file line-by-line via `readline` to avoid loading large files into memory.

Timestamps are converted from Apache format (`10/Oct/2000:13:55:36 -0700`) to
ISO 8601 (`2000-10-10T13:55:36-07:00`) before storage.

---

## Upload Flow

### `POST /upload` (`src/routes/upload.js`)

1. Receives a `.log` or `.txt` file (max 2 GB) and an optional `instance` text field via Multer.
2. File is saved to `uploads/` with a unique timestamped filename.
3. A `jobs` record is created with `status = 'pending'`.
4. Returns `{ jobId }` immediately — no blocking parse.

### Background Worker (`src/worker.js`)

Polls SQLite for pending jobs every 2 seconds (one at a time):

1. Sets `status = 'processing'`, records `started_at`.
2. Creates an import record (`insertImport`) to obtain an FK id.
3. Streams the file via `parseFile()`, inserting each 1 000-line batch with `INSERT OR IGNORE`. Updates `jobs.parsed_lines` after every batch.
4. If `parsedLines === 0` → deletes import record, sets `status = 'error'`.
5. If `totalInserted === 0` → deletes import record, sets `status = 'error'` (*"No new lines…"*).
6. Otherwise → calls `finalizeImport()`, deletes temp file, sets `status = 'done'` with `import_id`.
7. On any exception → deletes import record, deletes temp file, sets `status = 'error'`.

On server startup, any job still in `processing` state is reset to `pending` to handle interrupted runs.

### Job Queue Schema

```sql
CREATE TABLE jobs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  status         TEXT DEFAULT 'pending',  -- pending | processing | done | error
  filename       TEXT,
  file_path      TEXT,
  instance       TEXT,
  parsed_lines   INTEGER DEFAULT 0,       -- updated every 1 000-line batch
  import_id      INTEGER,                 -- set when done
  error          TEXT,                    -- set when error
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  started_at     DATETIME,
  completed_at   DATETIME
);
```

### Deduplication

- Every matched log line gets `line_hash`:
  - With an instance label: `SHA-256(instance + ":" + rawLine.trim())`
  - Without an instance label: `SHA-256(rawLine.trim())`
- A `UNIQUE` index on `log_entries.line_hash` enforces uniqueness within the same instance scope.
- `INSERT OR IGNORE` silently skips any line whose hash already exists.
- Effect: uploading the same file twice for the same instance → zero new rows → 422 rejection, no import record created.
- Effect: uploading two files that partially overlap for the same instance → overlapping lines counted once.
- Effect: uploading the same log line for two different instances → both rows are kept (different hashes).
- **Caveat**: two genuinely distinct requests that produce byte-for-byte identical log lines
  (same IP, path, status, bytes, and second-resolution timestamp) within the same instance will be deduplicated to one entry.
- **Existing data**: rows imported before deduplication was added have `line_hash = NULL`.
  SQLite treats each NULL as distinct in a UNIQUE index, so old rows are unaffected.
  Retroactive deduplication is not possible (temp files are deleted after upload).

---

## API Endpoints (`src/routes/api.js`)

All data endpoints accept the following optional query params (combinable, AND logic):

| Param         | Description                                      |
|---------------|--------------------------------------------------|
| `import_id`   | Scope to a single upload by ID                      |
| `instance`    | Scope to all uploads tagged with this instance name |
| `path_filter` | Filter paths by partial match (LIKE `%value%`)      |
| `date_from`   | Include entries from this date (`YYYY-MM-DD`)       |
| `date_to`     | Include entries up to this date (`YYYY-MM-DD`)      |

| Method | Path                      | Returns                                             |
|--------|---------------------------|-----------------------------------------------------|
| GET    | `/api/imports`            | All import records (id, filename, instance, lines, timestamp) |
| GET    | `/api/instances`          | `["InstanceA", "InstanceB", …]` distinct non-null instances |
| GET    | `/api/jobs`               | All job records ordered by `created_at DESC`        |
| GET    | `/api/jobs/:id`           | Single job: `{ id, status, filename, instance, parsed_lines, import_id, error, created_at, started_at, completed_at }` |
| GET    | `/api/overview`           | `{ total_requests, unique_ips, total_bytes, error_rate }` |
| GET    | `/api/requests-over-time` | `[{ hour, count }]` grouped by `YYYY-MM-DD HH:00`  |
| GET    | `/api/status-codes`       | `[{ status, count }]`                               |
| GET    | `/api/top-ips`            | Top 10 `[{ ip, count }]`                            |
| GET    | `/api/top-paths`          | Top 10 `[{ path, count }]`                          |
| GET    | `/api/top-user-agents`    | Top 10 `[{ user_agent, count }]` (nulls excluded)   |
| GET    | `/api/methods`            | `[{ method, count }]`                               |
| GET    | `/api/hourly-heatmap`     | `[{ hour (0–23), weekday (0=Sun–6=Sat), count }]`   |

---

## Frontend

### Upload Page (`src/public/index.html`)
- Drag-and-drop zone + file input button.
- **Instance name** text input (optional) — tags the upload for cross-import filtering.
- Upload transfer progress bar (XHR `progress` event).
- After upload, server returns `{ jobId }`. The page shows a **job tracker card**:
  - Animated indeterminate progress bar while `status = pending | processing`.
  - Live counter: "Processing: N lines parsed · Ns elapsed" — polled from `/api/jobs/:id` every 2 s.
  - On `status = done`: bar turns green, "View dashboard →" link appears, import history refreshes.
  - On `status = error`: bar turns red, error message shown.
- On page load, `/api/jobs` is queried for any `pending` or `processing` job. If found, the tracker card is shown and polling resumes automatically — survives page reloads mid-processing.
- Import history table fetched from `/api/imports`; Instance column links to
  `?instance=X` to view all imports for that instance; filename column links to
  `?import_id=N` for that specific upload.

### Dashboard Page (`src/public/dashboard.html` + `dashboard.js`)
- **Filter bar:** Instance (dropdown from `/api/instances`), Path contains (text),
  Date From, Date To. Apply button updates URL params and re-renders all charts
  in place. Clear button resets all filters.
- On page load, URL params (`import_id`, `instance`, `path_filter`, `date_from`,
  `date_to`) are read and pre-populate the filter bar.
- When Apply is clicked, `import_id` is dropped from the URL — the user moves
  from "view specific upload" to "filter mode". History pushState keeps the URL
  shareable without a page reload.
- Chart instances are tracked in a registry and `.destroy()`-ed before each
  re-render to prevent Canvas reuse errors.
- Fetches all 10 API endpoints in parallel via `Promise.all`.
- Renders an import info header showing active context (import name or filter summary).
- **4 KPI cards:** Total Requests, Unique IPs, Total Bandwidth, Error Rate.
- **7 charts** (all Chart.js, dark-themed):
  | # | Panel | Chart type |
  |---|-------|-----------|
  | 1 | Requests over time | Line (filled) |
  | 2 | Status code distribution | Doughnut (colour-coded by class) |
  | 3 | Top 10 URLs | Horizontal bar |
  | 4 | Top 10 IPs | Horizontal bar |
  | 5 | HTTP Methods | Pie |
  | 6 | Top User Agents | Vertical bar |
  | 7 | Traffic heatmap (hour × weekday) | CSS grid |
- Heatmap is built as a 7×24 CSS grid; cell intensity is `rgba(99,102,241, α)`
  where α scales linearly from 0.08 (0 requests) to 0.98 (max requests).

---

## Docker (`Dockerfile` + `docker-compose.yml`)

- Base image: `node:20-alpine`
- Port: `3000` (host) → `3000` (container)
- Volumes:
  - `./data` → `/app/data` — persists the SQLite database across restarts
  - `./uploads` → `/app/uploads` — temp upload staging area
- Env vars: `DB_PATH=/app/data/logs.db`, `PORT=3000`

---

## Environment Variables

| Variable | Default                     | Purpose                  |
|----------|-----------------------------|--------------------------|
| `PORT`   | `3000`                      | Express listen port      |
| `DB_PATH`| `./data/logs.db`            | SQLite database file path|

---

## Filter Behaviour

- Filters combine with AND logic (instance + date range = entries from that instance within those dates).
- `import_id` and `instance` can technically be combined, but in practice the dashboard drops `import_id` when Apply is clicked.
- `path_filter` uses `LIKE '%value%'` — partial match, case-sensitive (SQLite default).
- Date filters use `date(timestamp)` to strip time and timezone before comparing, so `date_from=2023-10-11` correctly includes all entries from that day regardless of the stored time offset.
- The instance dropdown is populated from `/api/instances` on every load/re-render; if no uploads have an instance set the dropdown shows only "All instances".

## Known Behaviours / Edge Cases

- Lines that fail the regex (comments, blank lines, malformed entries) are
  silently skipped; `parsedLines` vs `totalLines` in the import record shows
  how many were dropped.
- `bytes` is stored as `0` (not `NULL`) when Apache logs `-`.
- `referer` and `user_agent` are stored as `NULL` when Apache logs `-`.
- Multiple imports are fully independent; each has its own `import_id`.
  The dashboard shows all data when no `import_id` is in the URL.
- Multiple files uploaded for the same instance aggregate correctly via the `buildFilter`
  subquery (`WHERE import_id IN (SELECT id FROM imports WHERE instance = 'X')`).
- Duplicate lines across files are deduplicated at insert time (see Upload Flow above).
- There is no authentication — the app is intended for single-user local/internal use.
