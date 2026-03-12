(() => {
  // ── Chart instance registry (for destroy on re-render) ────────────────────

  const charts = {};

  const CANVAS_IDS = ['chart-timeline', 'chart-status', 'chart-methods', 'chart-paths', 'chart-ips', 'chart-agents'];

  function destroyCharts() {
    for (const key of Object.keys(charts)) {
      if (charts[key]) { charts[key].destroy(); charts[key] = null; }
    }
    // Replace each canvas with a fresh element — prevents Chart.js "already in use" errors on re-render
    for (const id of CANVAS_IDS) {
      const old = document.getElementById(id);
      if (old) {
        const fresh = document.createElement('canvas');
        fresh.id = id;
        old.parentNode.replaceChild(fresh, old);
      }
    }
    document.getElementById('heatmap').innerHTML = '';
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function formatBytes(b) {
    b = Number(b) || 0;
    if (b < 1024)        return b + ' B';
    if (b < 1024 ** 2)   return (b / 1024).toFixed(1) + ' KB';
    if (b < 1024 ** 3)   return (b / 1024 ** 2).toFixed(1) + ' MB';
    return (b / 1024 ** 3).toFixed(2) + ' GB';
  }

  function fmt(n) { return Number(n).toLocaleString(); }

  // Build a ?key=val&… query string from a filter object (skips empty values)
  function buildQS(filters) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) {
      if (v) p.set(k, v);
    }
    return p.toString() ? '?' + p.toString() : '';
  }

  // ── Filter state ──────────────────────────────────────────────────────────

  // Read current filters from the URL on page load
  function readFiltersFromURL() {
    const p = new URLSearchParams(window.location.search);
    return {
      import_id:   p.get('import_id')   || '',
      instance:    p.get('instance')    || '',
      path_filter: p.get('path_filter') || '',
      date_from:   p.get('date_from')   || '',
      date_to:     p.get('date_to')     || '',
    };
  }

  // Read the current values from the filter bar UI
  function readFiltersFromUI() {
    return {
      instance:    document.getElementById('f-instance').value,
      path_filter: document.getElementById('f-path').value.trim(),
      date_from:   document.getElementById('f-date-from').value,
      date_to:     document.getElementById('f-date-to').value,
    };
  }

  // Populate the filter bar UI from a filter object
  function setFilterUI(filters) {
    document.getElementById('f-instance').value  = filters.instance    || '';
    document.getElementById('f-path').value      = filters.path_filter || '';
    document.getElementById('f-date-from').value = filters.date_from   || '';
    document.getElementById('f-date-to').value   = filters.date_to     || '';
  }

  // ── Chart.js global defaults ──────────────────────────────────────────────

  Chart.defaults.color = '#94a3b8';
  Chart.defaults.borderColor = '#2d3348';
  Chart.defaults.plugins.legend.labels.color = '#94a3b8';
  Chart.defaults.plugins.tooltip.backgroundColor = '#1e2330';
  Chart.defaults.plugins.tooltip.borderColor = '#3b4a6b';
  Chart.defaults.plugins.tooltip.borderWidth = 1;
  Chart.defaults.plugins.tooltip.titleColor = '#f8fafc';
  Chart.defaults.plugins.tooltip.bodyColor = '#cbd5e1';

  const PALETTE = [
    '#6366f1','#22d3ee','#4ade80','#f59e0b','#f87171',
    '#a78bfa','#34d399','#fb923c','#38bdf8','#e879f9',
  ];

  function statusColor(code) {
    if (code < 300) return '#4ade80';
    if (code < 400) return '#38bdf8';
    if (code < 500) return '#f59e0b';
    return '#f87171';
  }

  // ── Data fetching ─────────────────────────────────────────────────────────

  async function fetchAll(filters) {
    const qs = buildQS(filters);
    const urls = [
      `/api/overview${qs}`,
      `/api/requests-over-time${qs}`,
      `/api/status-codes${qs}`,
      `/api/top-ips${qs}`,
      `/api/top-paths${qs}`,
      `/api/top-user-agents${qs}`,
      `/api/methods${qs}`,
      `/api/hourly-heatmap${qs}`,
      `/api/imports`,
      `/api/instances`,
    ];
    const results = await Promise.all(urls.map(u => fetch(u).then(r => r.json())));
    return {
      overview:    results[0],
      timeline:    results[1],
      statusCodes: results[2],
      topIps:      results[3],
      topPaths:    results[4],
      topAgents:   results[5],
      methods:     results[6],
      heatmap:     results[7],
      imports:     results[8],
      instances:   results[9],
    };
  }

  // ── Instance dropdown population ──────────────────────────────────────────

  function populateInstanceDropdown(instances, selectedInstance) {
    const sel = document.getElementById('f-instance');
    sel.innerHTML = '<option value="">All instances</option>';
    for (const c of instances) {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c;
      if (c === selectedInstance) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  // ── Import info header ────────────────────────────────────────────────────

  function renderImportInfo(filters, imports) {
    const el = document.getElementById('import-info');
    if (filters.import_id) {
      const imp = imports.find(i => String(i.id) === filters.import_id);
      if (imp) {
        const date = new Date(imp.imported_at).toLocaleString();
        const clientPart = imp.instance ? `${imp.instance} · ` : '';
        const inserted = imp.inserted_lines != null ? imp.inserted_lines : imp.parsed_lines;
        const dupCount = imp.parsed_lines - inserted;
        const dupPart = dupCount > 0 ? ` (${fmt(dupCount)} duplicates skipped)` : '';
        el.textContent = `${clientPart}${imp.filename} — ${fmt(inserted)} entries${dupPart} — ${date}`;
      } else {
        el.textContent = `Import #${filters.import_id}`;
      }
      return;
    }
    const parts = [];
    if (filters.instance)    parts.push(`Instance: ${filters.instance}`);
    if (filters.path_filter) parts.push(`Path: *${filters.path_filter}*`);
    if (filters.date_from)   parts.push(`From: ${filters.date_from}`);
    if (filters.date_to)     parts.push(`To: ${filters.date_to}`);
    el.textContent = parts.length ? parts.join(' · ') : 'Showing all data';
  }

  // ── KPI cards ─────────────────────────────────────────────────────────────

  function renderKPIs(ov) {
    document.getElementById('kpi-total').textContent     = fmt(ov.total_requests);
    document.getElementById('kpi-ips').textContent       = fmt(ov.unique_ips);
    document.getElementById('kpi-bandwidth').textContent = formatBytes(ov.total_bytes);
    document.getElementById('kpi-errors').textContent    = (ov.error_rate ?? 0) + '%';
  }

  // ── Timeline (line chart) ─────────────────────────────────────────────────

  function renderTimeline(rows) {
    charts.timeline = new Chart(document.getElementById('chart-timeline'), {
      type: 'line',
      data: {
        labels: rows.map(r => r.hour),
        datasets: [{
          label: 'Requests',
          data: rows.map(r => r.count),
          borderColor: '#6366f1',
          backgroundColor: 'rgba(99,102,241,0.12)',
          fill: true,
          tension: 0.3,
          pointRadius: rows.length > 200 ? 0 : 2,
          borderWidth: 2,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { ticks: { maxTicksLimit: 12, maxRotation: 30 } },
          y: { beginAtZero: true },
        },
        plugins: { legend: { display: false } },
      },
    });
  }

  // ── Status codes (doughnut) ───────────────────────────────────────────────

  function renderStatusCodes(rows) {
    charts.status = new Chart(document.getElementById('chart-status'), {
      type: 'doughnut',
      data: {
        labels: rows.map(r => String(r.status)),
        datasets: [{
          data: rows.map(r => r.count),
          backgroundColor: rows.map(r => statusColor(r.status)),
          borderWidth: 0,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'right' },
          tooltip: {
            callbacks: { label: ctx => ` ${fmt(ctx.parsed)} requests` },
          },
        },
      },
    });
  }

  // ── HTTP methods (pie) ────────────────────────────────────────────────────

  function renderMethods(rows) {
    charts.methods = new Chart(document.getElementById('chart-methods'), {
      type: 'pie',
      data: {
        labels: rows.map(r => r.method),
        datasets: [{
          data: rows.map(r => r.count),
          backgroundColor: PALETTE,
          borderWidth: 0,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'right' } },
      },
    });
  }

  // ── Horizontal bar (shared for paths & IPs) ───────────────────────────────

  function renderHBar(key, canvasId, rows, labelKey, color) {
    const reversed = [...rows].reverse();
    charts[key] = new Chart(document.getElementById(canvasId), {
      type: 'bar',
      data: {
        labels: reversed.map(r => {
          const s = String(r[labelKey]);
          return s.length > 40 ? s.slice(0, 37) + '…' : s;
        }),
        datasets: [{
          data: reversed.map(r => r.count),
          backgroundColor: color,
          borderRadius: 4,
          borderWidth: 0,
        }],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { beginAtZero: true },
          y: { ticks: { font: { size: 11 } } },
        },
        plugins: { legend: { display: false } },
      },
    });
  }

  // ── User agents (bar) ─────────────────────────────────────────────────────

  function renderAgents(rows) {
    charts.agents = new Chart(document.getElementById('chart-agents'), {
      type: 'bar',
      data: {
        labels: rows.map(r => {
          const s = String(r.user_agent);
          return s.length > 60 ? s.slice(0, 57) + '…' : s;
        }),
        datasets: [{
          data: rows.map(r => r.count),
          backgroundColor: '#22d3ee',
          borderRadius: 4,
          borderWidth: 0,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { ticks: { maxRotation: 30, font: { size: 10 } } },
          y: { beginAtZero: true },
        },
        plugins: { legend: { display: false } },
      },
    });
  }

  // ── Heatmap (CSS grid) ────────────────────────────────────────────────────

  function renderHeatmap(rows) {
    const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const container = document.getElementById('heatmap');

    const data = Array.from({ length: 7 }, () => new Array(24).fill(0));
    let maxVal = 0;
    for (const r of rows) {
      data[r.weekday][r.hour] = r.count;
      if (r.count > maxVal) maxVal = r.count;
    }

    const headerFiller = document.createElement('div');
    container.appendChild(headerFiller);
    for (let h = 0; h < 24; h++) {
      const el = document.createElement('div');
      el.className = 'hm-hour-label';
      el.textContent = String(h).padStart(2, '0');
      container.appendChild(el);
    }

    for (let d = 0; d < 7; d++) {
      const label = document.createElement('div');
      label.className = 'hm-label';
      label.textContent = DAYS[d];
      container.appendChild(label);

      for (let h = 0; h < 24; h++) {
        const count = data[d][h];
        const intensity = maxVal > 0 ? count / maxVal : 0;
        const cell = document.createElement('div');
        cell.className = 'hm-cell';
        cell.style.background = `rgba(99,102,241,${0.08 + intensity * 0.9})`;
        cell.setAttribute('data-tip', `${DAYS[d]} ${String(h).padStart(2,'0')}:00 — ${fmt(count)} req`);
        container.appendChild(cell);
      }
    }
  }

  // ── Render everything ─────────────────────────────────────────────────────

  function renderAll(data, filters) {
    destroyCharts();
    renderKPIs(data.overview);
    renderImportInfo(filters, data.imports);
    renderTimeline(data.timeline);
    renderStatusCodes(data.statusCodes);
    renderMethods(data.methods);
    renderHBar('paths', 'chart-paths', data.topPaths, 'path', '#6366f1');
    renderHBar('ips',   'chart-ips',   data.topIps,   'ip',   '#22d3ee');
    renderAgents(data.topAgents);
    renderHeatmap(data.heatmap);
  }

  // ── Filter bar wiring ─────────────────────────────────────────────────────

  function applyFilters() {
    // Filters from the UI replace any import_id from the URL
    const filters = readFiltersFromUI();
    const qs = buildQS(filters);
    history.pushState(null, '', '/dashboard.html' + qs);
    load(filters);
  }

  function clearFilters() {
    setFilterUI({});
    history.pushState(null, '', '/dashboard.html');
    load({});
  }

  document.getElementById('apply-btn').addEventListener('click', applyFilters);
  document.getElementById('clear-btn').addEventListener('click', clearFilters);

  // Also apply on Enter key in the path input
  document.getElementById('f-path').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyFilters();
  });

  // ── Load & render cycle ───────────────────────────────────────────────────

  async function load(filters) {
    document.getElementById('loading').classList.remove('hidden');
    try {
      const data = await fetchAll(filters);

      // When arriving via ?import_id=N (upload redirect), auto-detect the
      // import's instance so the dropdown pre-selects it for the user.
      let selectedInstance = filters.instance || '';
      if (!selectedInstance && filters.import_id) {
        const imp = data.imports.find(i => String(i.id) === filters.import_id);
        if (imp && imp.instance) {
          selectedInstance = imp.instance;
          // Reflect in the filter bar so the user sees which instance this belongs to
          document.getElementById('f-instance').value = selectedInstance;
        }
      }

      populateInstanceDropdown(data.instances, selectedInstance);
      renderAll(data, filters);
    } catch (err) {
      console.error('Dashboard error:', err);
    } finally {
      document.getElementById('loading').classList.add('hidden');
    }
  }

  // ── Boot ──────────────────────────────────────────────────────────────────

  const initialFilters = readFiltersFromURL();
  setFilterUI(initialFilters);
  load(initialFilters);
})();
