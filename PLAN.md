# Apache Access Log Dashboard — Step-by-Step Plan

## Context

Build a Dockerized web application that accepts Apache2 `access.log` uploads, parses and stores
the data in SQLite, and renders interactive dashboards with key access metrics.

**Technology decisions:**
- **Database: SQLite** — single-user tool, zero admin overhead, entire app fits in one Docker container
- **Backend: Node.js + Express** — simple, cohesive JS stack, excellent file-upload middleware (Multer)
- **Charts: Chart.js** — only ~11KB gzipped, sufficient for all needed chart types, easy CDN embed
- **Frontend: Vanilla HTML/CSS/JS** — no build toolchain, zero extra Docker complexity
- **better-sqlite3** — synchronous SQLite driver, faster bulk inserts than async alternatives

---

## Project Structure (end state)

```
AccessDashboards/
├── PLAN.md                 <- this file
├── docker-compose.yml
├── Dockerfile
├── package.json
├── .gitignore
├── src/
│   ├── app.js              # Express entry point
│   ├── db.js               # SQLite connection, schema init, query helpers
│   ├── parser.js           # Apache Combined Log Format regex parser
│   ├── routes/
│   │   ├── upload.js       # POST /upload — Multer + parse + bulk insert
│   │   └── api.js          # GET /api/* — aggregation endpoints
│   └── public/
│       ├── index.html      # Upload page + import history
│       ├── dashboard.html  # Dashboard page
│       └── js/
│           └── dashboard.js  # Chart.js init + data fetching
├── uploads/                # Temp dir for Multer (gitignored)
└── data/                   # SQLite .db file (Docker volume)
```

---

## Database Schema

```sql
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
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  filename       TEXT,
  total_lines    INTEGER,
  parsed_lines   INTEGER,
  inserted_lines INTEGER,
  instance       TEXT,
  imported_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_timestamp ON log_entries(timestamp);
CREATE INDEX IF NOT EXISTS idx_status    ON log_entries(status);
CREATE INDEX IF NOT EXISTS idx_ip        ON log_entries(ip);
CREATE INDEX IF NOT EXISTS idx_import    ON log_entries(import_id);
```

---

## Dashboard Panels

| # | Panel | Chart Type | API endpoint |
|---|-------|-----------|-------------|
| 1 | Total Requests | KPI card | `/api/overview` |
| 2 | Unique IPs | KPI card | `/api/overview` |
| 3 | Total Bandwidth | KPI card (formatted bytes) | `/api/overview` |
| 4 | Error Rate (4xx+5xx) | KPI card (%) | `/api/overview` |
| 5 | Requests over time | Line chart | `/api/requests-over-time` |
| 6 | Status code distribution | Doughnut chart | `/api/status-codes` |
| 7 | Top 10 URLs | Horizontal bar | `/api/top-paths` |
| 8 | Top 10 IPs | Horizontal bar | `/api/top-ips` |
| 9 | HTTP Methods | Pie chart | `/api/methods` |
| 10 | Top User Agents | Bar chart | `/api/top-user-agents` |
| 11 | Traffic heatmap (hour × weekday) | CSS grid heatmap | `/api/hourly-heatmap` |

---

## Implementation Steps

Each step requires approval before proceeding.

### Step 1 — Project scaffold ✅
Files: `package.json`, `.gitignore`, `PLAN.md`
- `package.json` with name, version, main, scripts (start, dev), dependencies:
  `express`, `multer`, `better-sqlite3`
- `.gitignore`: `node_modules/`, `data/`, `uploads/`

### Step 2 — Docker configuration
Files: `Dockerfile`, `docker-compose.yml`
- `Dockerfile`: `node:20-alpine`, copy, `npm ci --omit=dev`, expose 3000, CMD
- `docker-compose.yml`: single service, port 3000, volumes `./data` and `./uploads`,
  env vars `DB_PATH`, `PORT`

### Step 3 — Database module
File: `src/db.js`
- Open/create SQLite database from `DB_PATH` env var
- Run schema creation SQL on startup (tables + indexes)
- Export helper functions: `insertImport`, `insertEntries` (batch), `getImports`

### Step 4 — Log parser
File: `src/parser.js`
- Regex for Apache2 Combined Log Format
- Month name → number lookup map for timestamp parsing
- `parseLine(line)` → `{ ip, timestamp, method, path, protocol, status, bytes, referer, userAgent }` or `null`
- `parseFile(filepath)` → `{ entries[], totalLines, parsedLines }`

### Step 5 — Upload route
File: `src/routes/upload.js`
- Multer: disk storage, `uploads/` dir, 2 GB limit, `.log` files only
- `POST /upload`: receive file → `parseFile` → `insertImport` → batch `insertEntries`
  (1000 rows per transaction) → redirect to `/dashboard.html?import_id=N`
- Delete temp file after processing

### Step 6 — API routes
File: `src/routes/api.js`
All endpoints accept optional filter params: `import_id`, `instance`, `path_filter`, `date_from`, `date_to`.
- `GET /api/overview` — total requests, unique IPs, sum(bytes), error rate
- `GET /api/requests-over-time` — hourly counts grouped by `strftime('%Y-%m-%d %H', timestamp)`
- `GET /api/status-codes` — COUNT grouped by status
- `GET /api/top-ips` — top 10 IPs by COUNT DESC
- `GET /api/top-paths` — top 10 paths by COUNT DESC
- `GET /api/top-user-agents` — top 10 user_agents by COUNT DESC
- `GET /api/methods` — COUNT grouped by method
- `GET /api/hourly-heatmap` — COUNT grouped by `strftime('%H', timestamp)` and `strftime('%w', timestamp)`
- `GET /api/imports` — all rows from imports table
- `GET /api/instances` — distinct non-null instance names

### Step 7 — Express app entry point
File: `src/app.js`
- Create Express app
- Serve `src/public/` as static files
- Mount upload and api routers
- Listen on `PORT` env var (default 3000)

### Step 8 — Upload page
File: `src/public/index.html`
- Clean HTML page: drag-and-drop file zone + file input button
- Upload progress indicator
- Import history table (fetches `/api/imports`, each row links to dashboard)

### Step 9 — Dashboard page
Files: `src/public/dashboard.html`, `src/public/js/dashboard.js`
- `dashboard.html`: Chart.js from CDN, 4 KPI cards, 7 chart canvases, heatmap div
- `dashboard.js`:
  - Read `import_id` from URL params
  - Fetch all API endpoints in parallel
  - Render 4 KPI cards
  - Initialize all Chart.js charts
  - Render CSS grid heatmap

### Step 10 — Local smoke test (no Docker) ✅
```bash
npm install
node src/app.js
# open http://localhost:3000, upload a sample log, verify dashboard
```
**Note:** Parser updated to also accept the Apache VirtualHost Combined Log Format
(`%v:%p %h %l %u %t "%r" %>s %b "%{Referer}i" "%{User-Agent}i"`), where a
`host:port` prefix precedes the client IP. Both formats are now supported.

### Step 12 — Deduplication ✅
Files: `src/parser.js`, `src/db.js`, `src/routes/upload.js`, `src/public/index.html`, `src/public/js/dashboard.js`
- Each parsed log line gets a SHA-256 `line_hash`; stored in `log_entries` with a `UNIQUE` index.
  - Hash input: `instance + ":" + rawLine` when an instance label is set; `rawLine` otherwise.
  - Same line for different instances produces different hashes → both rows kept.
  - Same line for the same instance → deduplicated to one row.
- `INSERT OR IGNORE` silently skips any line whose hash already exists.
- After bulk insert, if `insertedLines === 0`, the import record is deleted and a 422 is returned:
  *"No new lines — all entries in this file already exist in the database."*
- `inserted_lines` column added to `imports`; import history and dashboard header show new vs duplicate counts.
- Multi-instance consistency was already correct via the `buildFilter` subquery — no changes needed.
- `client` renamed to `instance` throughout (DB column, API endpoint, query param, UI labels).

### Step 13 — Async upload queue + background processing + progress tracking ✅
Files: `src/db.js`, `src/worker.js` (new), `src/routes/upload.js`, `src/routes/api.js`, `src/app.js`, `src/public/index.html`
- `jobs` table added to SQLite: id, status (pending/processing/done/error), filename, file_path, instance, parsed_lines, import_id, error, created_at, started_at, completed_at.
- On startup, any `processing` jobs are reset to `pending` (handles server-restart interruption).
- `POST /upload` now just saves the file and creates a job record; returns `{ jobId }` — no blocking parse.
- `src/worker.js` polls for pending jobs every 2 s (one at a time); moves all parse/insert logic from the upload route.
- Progress is updated in the `jobs` table every 1 000-line batch.
- New API endpoints: `GET /api/jobs` (all jobs), `GET /api/jobs/:id` (single job).
- Upload page polls `/api/jobs/:id` every 2 s and shows an animated indeterminate progress bar, live line count, and elapsed time. On completion shows a "View dashboard →" link; on error shows the error message.
- On page load, `/api/jobs` is checked for any active job (pending/processing); if found, polling resumes automatically — survives page reloads mid-processing.

### Step 11 — Docker build and test
```bash
docker compose up --build
# open http://localhost:3000
# upload sample log → verify all 11 panels render
# docker compose restart → verify data persists
```

---

## Verification Checklist

- [ ] Upload page loads at `http://localhost:3000`
- [ ] Can upload a `.log` file, progress shown
- [ ] Redirected to dashboard after upload
- [ ] All 4 KPI cards show correct values
- [ ] All 7 charts render with data
- [ ] Heatmap renders
- [ ] Import history on index page shows previous uploads with links
- [ ] `?import_id=N` filtering works (each upload shows its own data)
- [ ] Data persists after `docker compose restart`
- [ ] Second upload adds to history without overwriting first
