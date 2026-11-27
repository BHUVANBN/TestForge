/* TestForge dashboard. No inline handlers, no innerHTML with data (XSS-safe, CSP-friendly). */
(function () {
  'use strict';

  const KEY_STORAGE = 'testforge.apiKey';
  const POLL_MS = 10000;
  const TERMINAL = new Set(['completed', 'failed', 'timeout', 'cancelled']);
  const MAX_CONSOLE_LINES = 5000;

  const state = {
    socket: null,
    currentJobId: null,
    page: 1,
    pageSize: 20,
    refreshTimer: null,
    pendingRefresh: null,
    lastStatus: null,
    currentBatchId: null,
    historyPage: 1,
  };

  const $ = (id) => document.getElementById(id);
  const apiKey = () => localStorage.getItem(KEY_STORAGE) || '';

  // ---------------------------------------------------------------- helpers
  function el(tag, opts, children) {
    const node = document.createElement(tag);
    if (opts) {
      if (opts.className) node.className = opts.className;
      if (opts.text !== undefined) node.textContent = String(opts.text);
      if (opts.title) node.title = opts.title;
      if (opts.colSpan) node.colSpan = opts.colSpan;
      if (opts.dataset) Object.assign(node.dataset, opts.dataset);
    }
    (children || []).forEach((c) => c && node.appendChild(c));
    return node;
  }

  function badge(status) {
    return el('span', { className: `status-badge status-${String(status).replace(/[^a-z]/g, '')}`, text: status });
  }

  function emptyRow(cols, text) {
    return el('tr', null, [el('td', { colSpan: cols, className: 'empty-row', text })]);
  }

  function testsCell(tests) {
    if (!tests) return el('td', { className: 'muted', text: '-' });
    return el('td', {
      className: `mono ${tests.failed ? 'tests-fail' : 'tests-pass'}`,
      text: `${tests.passed}/${tests.total}${tests.failed ? ` (${tests.failed} failed)` : ''}`,
    });
  }

  const fmtDuration = (ms) => (ms === null || ms === undefined ? '-' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
  const fmtTime = (iso, full) => (iso ? (full ? new Date(iso).toLocaleString() : new Date(iso).toLocaleTimeString()) : '-');

  async function api(path, options) {
    const opts = options || {};
    const headers = Object.assign({ Accept: 'application/json' }, opts.headers || {});
    if (apiKey()) headers['X-API-Key'] = apiKey();
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    const resp = await fetch(`/api/v1${path}`, {
      method: opts.method || 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    let data = null;
    try {
      data = await resp.json();
    } catch (_) {
      /* non-JSON */
    }
    if (resp.status === 401 || resp.status === 403) $('auth-banner').classList.add('visible');
    else if (resp.ok) $('auth-banner').classList.remove('visible');
    if (!resp.ok) {
      const err = new Error((data && (data.message || data.error)) || `HTTP ${resp.status}`);
      err.status = resp.status;
      err.details = data && data.details;
      throw err;
    }
    return data;
  }

  // ---------------------------------------------------------------- theme
  function currentTheme() {
    return (
      document.documentElement.getAttribute('data-theme') ||
      (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    );
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    $('theme-icon').setAttribute('data-lucide', theme === 'dark' ? 'sun' : 'moon');
    $('theme-text').textContent = theme === 'dark' ? 'Light Mode' : 'Dark Mode';
    icons();
  }

  function icons() {
    if (window.lucide) window.lucide.createIcons();
  }

  // ---------------------------------------------------------------- navigation
  function showPage(pageId) {
    document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
    document.querySelectorAll('.nav-item[data-page]').forEach((b) => b.classList.remove('active'));
    $(`page-${pageId}`).classList.add('active');
    $(`btn-${pageId}`).classList.add('active');
    if (pageId === 'jobs') loadJobs();
    if (pageId === 'health') loadHealth();
    if (pageId === 'batches') loadBatches();
    if (pageId === 'history') loadHistory();
  }

  // ---------------------------------------------------------------- data
  function animateValue(id, target) {
    const node = $(id);
    const start = parseInt(node.textContent, 10) || 0;
    if (start === target) return;
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min((now - t0) / 500, 1);
      node.textContent = String(Math.round(start + (target - start) * (1 - Math.pow(1 - p, 3))));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  async function loadStats() {
    const { data } = await api('/queue/stats');
    const { queue, workers } = data;
    animateValue('val-active', queue.active);
    animateValue('val-waiting', queue.waiting + queue.delayed);
    animateValue('val-completed', workers.completed);
    animateValue('val-failed', workers.failed);
    $('val-waiting-note').textContent = queue.paused ? 'Queue is PAUSED' : 'Queued jobs';
    const util = workers.total ? Math.round((workers.active / workers.total) * 100) : 0;
    $('txt-utilization').textContent = `${util}%`;
    $('bar-utilization').style.width = `${util}%`;
    $('txt-instances').textContent = String(workers.instances);
    $('txt-workers').textContent = `${workers.active} / ${workers.total}`;
    $('txt-avg-runtime').textContent = fmtDuration(workers.averageExecutionTime);
  }

  async function loadRecent() {
    const { data } = await api('/jobs?limit=6');
    const tbody = $('recent-jobs-tbody');
    tbody.replaceChildren();
    if (!data.jobs.length) return tbody.appendChild(emptyRow(5, 'No recent activity'));
    data.jobs.forEach((job) => {
      const idCell = el('td', { className: 'mono', text: `${job.jobId.slice(0, 8)}…`, title: job.jobId });
      idCell.style.cursor = 'pointer';
      idCell.dataset.attach = job.jobId;
      tbody.appendChild(
        el('tr', null, [
          idCell,
          el('td', null, [badge(job.status)]),
          el('td', { className: 'mono', text: job.language || job.command || '-' }),
          el('td', { className: 'muted', text: fmtTime(job.submittedAt) }),
          el('td', { className: 'mono', text: fmtDuration(job.duration) }),
        ])
      );
    });
  }

  async function loadJobs() {
    const status = $('filter-status').value;
    const qs = new URLSearchParams({ page: String(state.page), limit: String(state.pageSize) });
    if (status) qs.set('status', status);
    let data;
    try {
      ({ data } = await api(`/jobs?${qs}`));
    } catch (e) {
      $('full-jobs-tbody').replaceChildren(emptyRow(8, `Could not load jobs: ${e.message}`));
      return;
    }
    const tbody = $('full-jobs-tbody');
    tbody.replaceChildren();
    if (!data.jobs.length) tbody.appendChild(emptyRow(8, 'No execution history found'));
    data.jobs.forEach((job) => {
      const actions = el('div', { className: 'row-actions' }, [
        el('button', { className: 'button button-secondary button-small', text: 'Logs', dataset: { attach: job.jobId } }),
        TERMINAL.has(job.status)
          ? job.status !== 'completed'
            ? el('button', { className: 'button button-secondary button-small', text: 'Retry', dataset: { retry: job.jobId } })
            : null
          : el('button', { className: 'button button-secondary button-small', text: 'Cancel', dataset: { cancel: job.jobId } }),
      ]);
      tbody.appendChild(
        el('tr', null, [
          el('td', { className: 'mono', text: job.jobId }),
          el('td', { title: job.error || '' }, [badge(job.status)]),
          el('td', { className: 'mono', text: job.language || job.command || '-' }),
          testsCell(job.tests),
          el('td', { className: 'mono', text: job.exitCode === null ? '-' : job.exitCode }),
          el('td', { className: 'mono', text: fmtDuration(job.duration) }),
          el('td', { className: 'muted', text: fmtTime(job.submittedAt, true) }),
          el('td', null, [actions]),
        ])
      );
    });
    const { page, pages, hasNext, hasPrev, total } = data.pagination;
    $('page-label').textContent = `Page ${page} of ${Math.max(1, pages)} (${total} jobs)`;
    $('page-prev').disabled = !hasPrev;
    $('page-next').disabled = !hasNext;
  }

  async function loadBatches() {
    const tbody = $('batches-tbody');
    let data;
    try {
      ({ data } = await api('/batches?limit=50'));
    } catch (e) {
      tbody.replaceChildren(emptyRow(7, `Could not load batches: ${e.message}`));
      return;
    }
    tbody.replaceChildren();
    if (!data.batches.length) tbody.appendChild(emptyRow(7, 'No batches yet'));
    data.batches.forEach((b) => {
      const bar = el('div', { className: 'progress' }, [el('span')]);
      bar.firstChild.style.width = `${b.total ? Math.round((b.finished / b.total) * 100) : 0}%`;
      const progress = el('td', { className: 'mono' }, [bar, document.createTextNode(`${b.finished}/${b.total}`)]);
      tbody.appendChild(
        el('tr', null, [
          el('td', { className: 'mono', text: `${b.id.slice(0, 8)}…`, title: b.id }),
          el('td', { text: b.name || '-' }),
          el('td', null, [badge(b.status)]),
          progress,
          testsCell(b.tests),
          el('td', { className: 'muted', text: fmtTime(b.createdAt, true) }),
          el('td', null, [el('button', { className: 'button button-secondary button-small', text: 'Open', dataset: { batch: b.id } })]),
        ])
      );
    });
    if (state.currentBatchId) loadBatchDetail(state.currentBatchId);
  }

  async function loadBatchDetail(id) {
    state.currentBatchId = id;
    let b;
    try {
      ({ data: b } = await api(`/batches/${id}`));
    } catch (e) {
      return;
    }
    $('batch-detail').style.display = 'block';
    $('batch-detail-title').textContent = `${b.name || 'Batch'}: ${b.status} (${b.finished}/${b.total})`;
    const tbody = $('batch-jobs-tbody');
    tbody.replaceChildren();
    b.jobs.forEach((j) => {
      const label = j.matrix ? Object.entries(j.matrix).map(([k, v]) => `${k}=${v}`).join(' ') : j.language || j.command || '-';
      const idCell = el('td', { className: 'mono', text: j.jobId, dataset: { attach: j.jobId } });
      idCell.style.cursor = 'pointer';
      tbody.appendChild(
        el('tr', null, [
          idCell,
          el('td', null, [badge(j.status)]),
          el('td', { className: 'mono', text: label }),
          testsCell(j.tests),
          el('td', { className: 'mono', text: j.exitCode === null ? '-' : j.exitCode }),
          el('td', { className: 'mono', text: fmtDuration(j.duration) }),
        ])
      );
    });
  }

  function historyDisabled(e) {
    const off = e && e.status === 404;
    $('history-disabled').classList.toggle('visible', off);
    $('history-content').style.display = off ? 'none' : 'block';
    return off;
  }

  async function loadHistoryStats() {
    let s;
    try {
      ({ data: s } = await api(`/history/stats?days=${$('h-days').value}`));
    } catch (e) {
      historyDisabled(e);
      return false;
    }
    historyDisabled(null);
    const t = s.totals;
    $('h-total').textContent = String(t.total);
    $('h-window').textContent = `last ${s.days} days`;
    $('h-rate').textContent = t.successRate === null ? '-' : `${t.successRate}%`;
    $('h-breakdown').textContent = `${t.failed} failed · ${t.timeout} timeout · ${t.cancelled} cancelled`;
    $('h-avg').textContent = fmtDuration(t.avgDurationMs);
    $('h-p95').textContent = t.p95DurationMs === null ? '' : `p95 ${fmtDuration(t.p95DurationMs)}`;
    $('h-tests').textContent = t.testsTotal ? `${t.testsTotal - t.testsFailed}/${t.testsTotal}` : '-';
    $('h-tests-note').textContent = t.testsTotal ? `${t.testsFailed} failed` : 'from JUnit/TAP reports';

    const max = Math.max(1, ...s.daily.map((d) => d.total));
    $('h-chart').replaceChildren(
      ...s.daily.map((d) => {
        const bar = el('div', { className: 'trend-bar', title: `${d.day}: ${d.completed} completed, ${d.unsuccessful} other` });
        const ok = el('span', { className: 'ok' });
        ok.style.height = `${(d.completed / max) * 100}%`;
        const bad = el('span', { className: 'bad' });
        bad.style.height = `${(d.unsuccessful / max) * 100}%`;
        bar.append(ok, bad);
        return bar;
      })
    );

    const failing = $('h-failing');
    failing.replaceChildren();
    if (!s.topFailingTests.length) failing.textContent = 'No test failures recorded.';
    s.topFailingTests.forEach((f) =>
      failing.appendChild(
        el('div', { className: 'failure-item' }, [
          el('span', { className: 'mono', text: `${f.failures}× ` }),
          document.createTextNode(`${f.classname ? `${f.classname} › ` : ''}${f.name}`),
        ])
      )
    );
    return true;
  }

  async function loadHistoryJobs() {
    const qs = new URLSearchParams({ page: String(state.historyPage), limit: '20' });
    if ($('h-q').value.trim()) qs.set('q', $('h-q').value.trim());
    if ($('h-status').value) qs.set('status', $('h-status').value);
    if ($('h-since').value) qs.set('from', new Date(Date.now() - Number($('h-since').value) * 86400000).toISOString());
    const tbody = $('h-tbody');
    let data;
    try {
      ({ data } = await api(`/history/jobs?${qs}`));
    } catch (e) {
      if (!historyDisabled(e)) tbody.replaceChildren(emptyRow(7, `Search failed: ${e.message}`));
      return;
    }
    tbody.replaceChildren();
    if (!data.jobs.length) tbody.appendChild(emptyRow(7, 'No matching jobs'));
    data.jobs.forEach((job) => {
      const idCell = el('td', { className: 'mono', text: `${job.jobId.slice(0, 8)}…`, title: job.jobId, dataset: { attach: job.jobId } });
      idCell.style.cursor = 'pointer';
      tbody.appendChild(
        el('tr', null, [
          idCell,
          el('td', { title: job.error || '' }, [badge(job.status)]),
          el('td', { className: 'mono', text: job.language || job.command || '-' }),
          testsCell(job.tests),
          el('td', { className: 'mono', text: job.exitCode === null ? '-' : job.exitCode }),
          el('td', { className: 'mono', text: fmtDuration(job.duration) }),
          el('td', { className: 'muted', text: fmtTime(job.submittedAt, true) }),
        ])
      );
    });
    const p = data.pagination;
    $('h-page-label').textContent = `Page ${p.page} of ${Math.max(1, p.pages)} (${p.total} jobs)`;
    $('h-prev').disabled = p.page <= 1;
    $('h-next').disabled = p.page >= p.pages;
  }

  async function loadHistory() {
    if (await loadHistoryStats()) await loadHistoryJobs();
  }

  async function loadHealth() {
    const grid = $('health-grid');
    let data;
    try {
      const resp = await fetch('/api/v1/health');
      data = (await resp.json()).data;
    } catch (_) {
      grid.replaceChildren(el('div', { className: 'card card-span-4', text: 'API unreachable' }));
      return;
    }
    grid.replaceChildren(
      ...Object.entries(data.checks).map(([name, check]) => {
        const head = el('div', null, [
          el('span', { text: name }),
          el('span', {
            className: `status-badge status-${check.healthy ? 'completed' : 'failed'}`,
            text: check.healthy ? 'Healthy' : 'Degraded',
          }),
        ]);
        head.style.cssText = 'display:flex; justify-content:space-between; align-items:center; font-weight:600; text-transform:capitalize;';
        const msg = el('div', { className: 'hint', text: check.message || (check.healthy ? 'Operational' : 'Unavailable') });
        const card = el('div', { className: 'card card-span-4' }, [head, msg]);
        card.style.padding = '20px';
        return card;
      })
    );
  }

  async function refresh() {
    try {
      await Promise.all([loadStats(), loadRecent()]);
      if ($('page-jobs').classList.contains('active')) await loadJobs();
      if ($('page-health').classList.contains('active')) await loadHealth();
      if ($('page-batches').classList.contains('active')) await loadBatches();
    } catch (e) {
      /* surfaced via banner / status */
    }
  }

  function scheduleRefresh() {
    if (state.pendingRefresh) return;
    state.pendingRefresh = setTimeout(() => {
      state.pendingRefresh = null;
      refresh();
    }, 400);
  }

  // ---------------------------------------------------------------- console
  function logLine(type, text) {
    const terminal = $('terminal-output');
    const line = el('div', { className: `console-line console-${type}` }, [
      el('span', { className: 'console-time', text: `[${new Date().toLocaleTimeString()}] ` }),
      document.createTextNode(String(text)),
    ]);
    terminal.appendChild(line);
    while (terminal.childNodes.length > MAX_CONSOLE_LINES) terminal.removeChild(terminal.firstChild);
    terminal.scrollTop = terminal.scrollHeight;
  }

  function writeOutput(stream, data) {
    const terminal = $('terminal-output');
    const span = el('span', { className: stream === 'stderr' ? 'console-stderr' : 'console-stdout', text: data });
    terminal.appendChild(span);
    terminal.scrollTop = terminal.scrollHeight;
  }

  async function downloadArtifact(jobId, name) {
    const resp = await fetch(`/api/v1/jobs/${jobId}/artifacts/${name.split('/').map(encodeURIComponent).join('/')}`, {
      headers: apiKey() ? { 'X-API-Key': apiKey() } : {},
    });
    if (!resp.ok) return alert(`Download failed (HTTP ${resp.status})`);
    const url = URL.createObjectURL(await resp.blob());
    const a = el('a');
    a.href = url;
    a.download = name.split('/').pop();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function showExtras(jobId) {
    const box = $('job-extras');
    box.replaceChildren();
    let job;
    try {
      ({ data: job } = await api(`/jobs/${jobId}`));
    } catch (_) {
      return;
    }
    if (job.testReport) {
      const r = job.testReport;
      box.appendChild(
        el('div', { className: 'extras-row' }, [
          el('strong', { text: `Tests (${r.format.toUpperCase()}): ` }),
          el('span', {
            className: r.failed ? 'tests-fail' : 'tests-pass',
            text: `${r.passed}/${r.total} passed${r.failed ? `, ${r.failed} failed` : ''}${r.skipped ? `, ${r.skipped} skipped` : ''}`,
          }),
        ])
      );
      r.failures.slice(0, 10).forEach((f) =>
        box.appendChild(
          el('div', { className: 'failure-item' }, [
            el('span', { className: 'mono', text: `✗ ${f.classname ? `${f.classname} › ` : ''}${f.name}` }),
            f.message ? el('div', { className: 'muted', text: f.message.split('\n')[0] }) : null,
          ])
        )
      );
    }
    if (job.artifactsError) box.appendChild(el('div', { className: 'extras-row tests-fail', text: job.artifactsError }));
    if (job.artifactCount) {
      const { data } = await api(`/jobs/${jobId}/artifacts`);
      const row = el('div', { className: 'extras-row' }, [el('strong', { text: 'Artifacts: ' })]);
      data.artifacts.forEach((a) =>
        row.appendChild(
          el('button', {
            className: 'button button-secondary button-small',
            text: `${a.name} (${a.size < 1024 ? `${a.size} B` : `${(a.size / 1024).toFixed(1)} KB`})`,
            dataset: { artifactJob: jobId, artifactName: a.name },
          })
        )
      );
      box.appendChild(row);
    }
  }

  async function attach(jobId) {
    if (!jobId) return;
    if (state.currentJobId && state.socket) state.socket.emit('unsubscribe-job', state.currentJobId);
    state.currentJobId = jobId;
    state.lastStatus = null;
    $('input-stream-id').value = jobId;
    showPage('stream');
    $('terminal-output').replaceChildren();
    $('job-extras').replaceChildren();
    logLine('info', `Attached to job ${jobId}`);

    // Print what has been recorded so far, then follow live output.
    try {
      const { data: job } = await api(`/jobs/${jobId}`);
      if (state.lastStatus !== job.status) {
        logLine('info', `Status: ${job.status}${job.attempt ? ` (attempt ${job.attempt}/${job.maxAttempts})` : ''}`);
      }
      state.lastStatus = job.status;
      if (TERMINAL.has(job.status)) {
        const { data } = await api(`/logs/${jobId}`);
        if (data.logs.stdout) writeOutput('stdout', data.logs.stdout);
        if (data.logs.stderr) writeOutput('stderr', data.logs.stderr);
        if (data.truncated) logLine('error', 'Output was truncated by the server limit');
        finalLine(job);
        showExtras(jobId);
      }
    } catch (e) {
      logLine('error', e.status === 404 ? 'Job not found' : `Failed to load job: ${e.message}`);
      return;
    }
    if (state.socket) state.socket.emit('subscribe-job', jobId);
  }

  function finalLine(job) {
    const parts = [`Job ${job.status}`];
    if (job.exitCode !== null && job.exitCode !== undefined) parts.push(`exit code ${job.exitCode}`);
    if (job.duration !== null && job.duration !== undefined) parts.push(fmtDuration(job.duration));
    if (job.durationMs !== undefined) parts.push(fmtDuration(job.durationMs));
    const msg = parts.join(', ') + (job.error && job.status !== 'completed' ? `: ${job.error}` : '');
    logLine(job.status === 'completed' ? 'success' : 'error', msg);
  }

  // ---------------------------------------------------------------- socket
  function connectSocket() {
    if (typeof window.io !== 'function') return;
    if (state.socket) state.socket.disconnect();
    const socket = window.io({ auth: { apiKey: apiKey() } });
    state.socket = socket;

    socket.on('connect', () => {
      $('status-dot').classList.add('dot-online');
      $('status-text').textContent = 'Live';
      if (state.currentJobId) socket.emit('subscribe-job', state.currentJobId);
    });
    socket.on('disconnect', () => {
      $('status-dot').classList.remove('dot-online');
      $('status-text').textContent = 'Offline';
    });
    socket.on('connect_error', (err) => {
      $('status-dot').classList.remove('dot-online');
      $('status-text').textContent = err && err.message === 'unauthorized' ? 'API key required' : 'Offline';
      if (err && err.message === 'unauthorized') $('auth-banner').classList.add('visible');
    });
    socket.on('job-log', (e) => {
      if (e.jobId === state.currentJobId) writeOutput(e.stream, e.data);
    });
    socket.on('job-status', (e) => {
      scheduleRefresh();
      if (e.jobId !== state.currentJobId) return;
      if (e.status === state.lastStatus && !TERMINAL.has(e.status)) return;
      state.lastStatus = e.status;
      if (TERMINAL.has(e.status)) {
        finalLine(e);
        showExtras(e.jobId);
      }
      else logLine('info', `Status: ${e.status}${e.attempt ? ` (attempt ${e.attempt})` : ''}${e.error ? `: ${e.error}` : ''}`);
    });
    socket.on('job-error', (e) => logLine('error', e.error));
    socket.on('batch-status', () => scheduleRefresh());
  }

  // ---------------------------------------------------------------- actions
  function parseCommandLine(line) {
    const out = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m;
    while ((m = re.exec(line))) out.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
    return out;
  }

  function parseEnv(text) {
    const env = {};
    text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .forEach((l) => {
        const i = l.indexOf('=');
        if (i < 1) throw new Error(`Invalid environment line: ${l}`);
        env[l.slice(0, i).trim()] = l.slice(i + 1);
      });
    return env;
  }

  async function submitJob(ev) {
    ev.preventDefault();
    $('submit-error').textContent = '';
    const payload = {
      timeout: parseInt($('input-timeout').value, 10),
      retries: parseInt($('input-retries').value, 10) || 0,
      priority: $('input-priority').value,
      metadata: { source: 'dashboard' },
    };
    if ($('input-webhook').value.trim()) payload.webhookUrl = $('input-webhook').value.trim();
    try {
      const env = parseEnv($('input-env').value);
      if (Object.keys(env).length) payload.env = env;
      if ($('input-type').value === 'script') {
        payload.script = $('input-script').value;
        payload.language = $('input-language').value;
      } else {
        const [command, ...args] = parseCommandLine($('input-command').value);
        if (!command) throw new Error('Enter a command');
        payload.command = command;
        if (args.length) payload.args = args;
      }
      const { data } = await api('/jobs', { method: 'POST', body: payload });
      await attach(data.jobId);
      scheduleRefresh();
    } catch (e) {
      $('submit-error').textContent = e.details ? `${e.message}: ${e.details.join('; ')}` : e.message;
    }
  }

  async function cancelJob(jobId) {
    if (!jobId || !confirm(`Cancel job ${jobId}?`)) return;
    try {
      const res = await api(`/jobs/${jobId}`, { method: 'DELETE' });
      logLine('info', res.message);
    } catch (e) {
      alert(`Cancel failed: ${e.message}`);
    }
    scheduleRefresh();
  }

  async function retryJob(jobId) {
    try {
      const { data } = await api(`/jobs/${jobId}/retry`, { method: 'POST' });
      await attach(data.jobId);
    } catch (e) {
      alert(`Retry failed: ${e.message}`);
    }
    scheduleRefresh();
  }

  const TEMPLATES = {
    node: ['node', "console.log('Testing Node.js environment...');\nconsole.log(JSON.stringify({ arch: process.arch, version: process.version }, null, 2));"],
    python: ['python', "import platform, sys\nprint(f'Python {sys.version.split()[0]} on {platform.system()} {platform.release()}')\nprint('Execution complete.')"],
    bash: ['bash', "echo 'Running system checks...'\nuname -a\ndf -h /workspace\necho 'Test cycle complete.'"],
    failing: ['bash', "echo 'Running assertions...'\necho 'expected 2, got 3' >&2\nexit 1"],
    junit: [
      'python',
      "import os\n# Anything written to $TESTFORGE_ARTIFACTS is kept and downloadable.\nout = os.environ['TESTFORGE_ARTIFACTS']\nwith open(os.path.join(out, 'junit.xml'), 'w') as f:\n    f.write('<testsuite name=\"demo\"><testcase classname=\"demo\" name=\"adds\" time=\"0.01\"/>'\n            '<testcase classname=\"demo\" name=\"divides\"><failure message=\"ZeroDivisionError\"/></testcase></testsuite>')\nwith open(os.path.join(out, 'summary.txt'), 'w') as f:\n    f.write('1 passed, 1 failed\\n')\nprint('wrote junit.xml and summary.txt')",
    ],
    tap: ['bash', "echo 'TAP version 13'\necho '1..3'\necho 'ok 1 - starts up'\necho 'ok 2 - reads config'\necho 'ok 3 - optional check # SKIP no network'"],
  };

  function loadTemplate(name) {
    const [language, script] = TEMPLATES[name];
    $('input-type').value = 'script';
    $('input-language').value = language;
    $('input-script').value = script;
    toggleType();
  }

  function toggleType() {
    const isScript = $('input-type').value === 'script';
    $('group-script').style.display = isScript ? 'block' : 'none';
    $('group-command').style.display = isScript ? 'none' : 'block';
  }

  // ---------------------------------------------------------------- wiring
  function wire() {
    document.querySelectorAll('.nav-item[data-page]').forEach((b) =>
      b.addEventListener('click', () => showPage(b.dataset.page))
    );
    $('btn-theme-toggle').addEventListener('click', () => {
      const next = currentTheme() === 'dark' ? 'light' : 'dark';
      localStorage.setItem('theme', next);
      applyTheme(next);
    });
    $('input-type').addEventListener('change', toggleType);
    $('submit-form').addEventListener('submit', submitJob);
    document.querySelectorAll('[data-template]').forEach((b) =>
      b.addEventListener('click', () => loadTemplate(b.dataset.template))
    );
    $('btn-attach').addEventListener('click', () => attach($('input-stream-id').value.trim()));
    $('btn-cancel-job').addEventListener('click', () => cancelJob($('input-stream-id').value.trim()));
    $('btn-clear').addEventListener('click', () => $('terminal-output').replaceChildren());
    $('h-days').addEventListener('change', loadHistoryStats);
    $('h-search').addEventListener('click', () => {
      state.historyPage = 1;
      loadHistoryJobs();
    });
    $('h-q').addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        state.historyPage = 1;
        loadHistoryJobs();
      }
    });
    $('h-prev').addEventListener('click', () => {
      state.historyPage = Math.max(1, state.historyPage - 1);
      loadHistoryJobs();
    });
    $('h-next').addEventListener('click', () => {
      state.historyPage += 1;
      loadHistoryJobs();
    });
    $('filter-status').addEventListener('change', () => {
      state.page = 1;
      loadJobs();
    });
    $('page-prev').addEventListener('click', () => {
      state.page = Math.max(1, state.page - 1);
      loadJobs();
    });
    $('page-next').addEventListener('click', () => {
      state.page += 1;
      loadJobs();
    });

    // Delegated row actions
    document.addEventListener('click', (ev) => {
      const t = ev.target.closest('[data-attach],[data-retry],[data-cancel],[data-batch],[data-artifact-job]');
      if (!t) return;
      if (t.dataset.artifactJob) downloadArtifact(t.dataset.artifactJob, t.dataset.artifactName);
      else if (t.dataset.batch) loadBatchDetail(t.dataset.batch);
      else if (t.dataset.attach) attach(t.dataset.attach);
      else if (t.dataset.retry) retryJob(t.dataset.retry);
      else if (t.dataset.cancel) cancelJob(t.dataset.cancel);
    });

    $('input-api-key').value = apiKey();
    $('settings-form').addEventListener('submit', (ev) => {
      ev.preventDefault();
      localStorage.setItem(KEY_STORAGE, $('input-api-key').value.trim());
      $('settings-status').textContent = 'Saved. Reconnecting…';
      connectSocket();
      refresh().then(() => ($('settings-status').textContent = 'Saved.'));
    });
    $('btn-clear-key').addEventListener('click', () => {
      localStorage.removeItem(KEY_STORAGE);
      $('input-api-key').value = '';
      $('settings-status').textContent = 'Key removed.';
      connectSocket();
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    const saved = localStorage.getItem('theme');
    applyTheme(saved || currentTheme());
    wire();
    connectSocket();
    refresh();
    state.refreshTimer = setInterval(refresh, POLL_MS);
  });
})();
