#!/usr/bin/env node
import axios, { AxiosError, AxiosInstance } from 'axios';
import { Command, Option } from 'commander';
import fs from 'fs';
import path from 'path';
import { VERSION } from '../version';

const EXTENSION_LANGUAGE: Record<string, string> = {
  '.sh': 'bash',
  '.bash': 'bash',
  '.js': 'node',
  '.mjs': 'node',
  '.cjs': 'node',
  '.py': 'python',
  '.rb': 'ruby',
  '.php': 'php',
  '.go': 'go',
  '.java': 'java',
};

/** Process exit codes for `run --watch` / `watch`, so CI pipelines can branch on them. */
const EXIT_CODES: Record<string, number> = { completed: 0, failed: 1, timeout: 2, cancelled: 3 };
const TERMINAL = new Set(Object.keys(EXIT_CODES));
const ICONS: Record<string, string> = {
  queued: '⏳',
  running: '🔄',
  retrying: '🔁',
  completed: '✅',
  failed: '❌',
  timeout: '⏱️',
  cancelled: '🛑',
};

const program = new Command();
let api: AxiosInstance;

program
  .name('forge')
  .description('TestForge CLI: submit and monitor test jobs')
  .version(VERSION)
  .addOption(new Option('-H, --host <url>', 'API base URL').env('TESTFORGE_HOST').default('http://localhost:3000'))
  .addOption(new Option('-k, --api-key <key>', 'API key').env('TESTFORGE_API_KEY'))
  .option('--json', 'Print raw JSON responses')
  .hook('preAction', () => {
    const opts = program.opts();
    api = axios.create({
      baseURL: `${String(opts.host).replace(/\/$/, '')}/api/v1`,
      timeout: 30_000,
      headers: opts.apiKey ? { 'X-API-Key': opts.apiKey } : {},
    });
  });

const json = () => !!program.opts().json;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fail(prefix: string, err: unknown): never {
  const e = err as AxiosError<any>;
  const body = e.response?.data;
  const reason = body?.error ?? e.message;
  console.error(`❌ ${prefix}: ${reason}`);
  if (Array.isArray(body?.details)) body.details.forEach((d: string) => console.error(`   - ${d}`));
  if (e.response?.status === 401) console.error('   Set an API key with --api-key or TESTFORGE_API_KEY.');
  process.exit(e.response ? 1 : 4);
}

const collect = (value: string, previous: string[] = []) => [...previous, value];

program
  .command('run')
  .description('Submit a job')
  .option('-s, --script <file>', 'Script file to execute ("-" reads stdin)')
  .option('-l, --language <lang>', 'Script language (bash, sh, node, python, ruby, php, go, java); inferred from the file extension')
  .option('-c, --command <cmd>', 'Executable to run instead of a script (e.g. node, python3)')
  .option('-a, --args <args...>', 'Arguments for --command')
  .option('-e, --env <KEY=VALUE>', 'Environment variable (repeatable)', collect)
  .option('-t, --timeout <ms>', 'Timeout in milliseconds')
  .option('-r, --retries <n>', 'Retries after a failed attempt')
  .option('-m, --metadata <json>', 'Metadata JSON object')
  .option('-w, --watch', 'Wait for the job, print its output and exit with its status')
  .action(async (opts) => {
    const payload: Record<string, unknown> = {};
    if (opts.script) {
      payload.script = opts.script === '-' ? fs.readFileSync(0, 'utf8') : readFile(opts.script);
      payload.language = opts.language ?? EXTENSION_LANGUAGE[path.extname(opts.script).toLowerCase()] ?? 'bash';
    } else if (opts.command) {
      payload.command = opts.command;
      if (opts.args) payload.args = opts.args;
      if (opts.language) payload.language = opts.language;
    } else {
      console.error('❌ Provide either --script <file> or --command <cmd>');
      process.exit(1);
    }
    if (opts.timeout) payload.timeout = parseInt(opts.timeout, 10);
    if (opts.retries) payload.retries = parseInt(opts.retries, 10);
    if (opts.env) {
      payload.env = Object.fromEntries(
        (opts.env as string[]).map((kv) => {
          const i = kv.indexOf('=');
          if (i < 1) {
            console.error(`❌ Invalid --env "${kv}" (expected KEY=VALUE)`);
            process.exit(1);
          }
          return [kv.slice(0, i), kv.slice(i + 1)];
        })
      );
    }
    if (opts.metadata) {
      try {
        payload.metadata = JSON.parse(opts.metadata);
      } catch {
        console.error('❌ --metadata must be valid JSON');
        process.exit(1);
      }
    }

    try {
      const { data } = await api.post('/jobs', payload);
      const jobId = data.data.jobId;
      if (json() && !opts.watch) return console.log(JSON.stringify(data.data));
      console.error(`✅ Job submitted: ${jobId}`);
      if (opts.watch) process.exit(await watch(jobId));
      console.error(`   forge status ${jobId}\n   forge watch ${jobId}`);
    } catch (err) {
      fail('Failed to submit job', err);
    }
  });

program
  .command('status <jobId>')
  .description('Show job status')
  .action(async (jobId) => {
    try {
      const { data } = await api.get(`/jobs/${jobId}`);
      const j = data.data;
      if (json()) return console.log(JSON.stringify(j, null, 2));
      console.log(`${ICONS[j.status] ?? '•'} ${j.jobId}`);
      console.log(`   Status:    ${j.status}`);
      console.log(`   Attempt:   ${j.attempt}/${j.maxAttempts}`);
      console.log(`   Runtime:   ${j.language ?? j.command}`);
      if (j.exitCode !== null) console.log(`   Exit code: ${j.exitCode}`);
      if (j.duration !== null) console.log(`   Duration:  ${j.duration}ms`);
      if (j.error) console.log(`   Error:     ${j.error}`);
      if (j.retryOf) console.log(`   Retry of:  ${j.retryOf}`);
    } catch (err) {
      fail('Failed to get status', err);
    }
  });

program
  .command('logs <jobId>')
  .description('Print job stdout/stderr')
  .option('--stdout', 'Only stdout')
  .option('--stderr', 'Only stderr')
  .action(async (jobId, opts) => {
    try {
      const { data } = await api.get(`/logs/${jobId}`);
      if (json()) return console.log(JSON.stringify(data.data, null, 2));
      printLogs(data.data, opts);
    } catch (err) {
      fail('Failed to get logs', err);
    }
  });

program
  .command('list')
  .description('List recent jobs')
  .option('-s, --status <status>', 'Filter by status')
  .option('-n, --limit <n>', 'Number of jobs', '20')
  .option('-p, --page <n>', 'Page', '1')
  .action(async (opts) => {
    try {
      const { data } = await api.get('/jobs', { params: { status: opts.status, limit: opts.limit, page: opts.page } });
      if (json()) return console.log(JSON.stringify(data.data, null, 2));
      const { jobs, pagination } = data.data;
      if (!jobs.length) return console.log('No jobs found.');
      for (const j of jobs) {
        console.log(
          `${ICONS[j.status] ?? '•'} ${j.jobId}  ${j.status.padEnd(9)} ${String(j.language ?? j.command).padEnd(8)} ` +
            `${j.duration !== null ? `${j.duration}ms` : '-'}  ${new Date(j.submittedAt).toLocaleString()}`
        );
      }
      console.log(`\nPage ${pagination.page}/${Math.max(1, pagination.pages)}: ${pagination.total} job(s)`);
    } catch (err) {
      fail('Failed to list jobs', err);
    }
  });

program
  .command('cancel <jobId>')
  .description('Cancel a queued or running job')
  .action(async (jobId) => {
    try {
      const { data } = await api.delete(`/jobs/${jobId}`);
      console.log(`🛑 ${data.message}`);
    } catch (err) {
      fail('Failed to cancel', err);
    }
  });

program
  .command('retry <jobId>')
  .description('Re-run a failed, timed-out or cancelled job as a new job')
  .option('-w, --watch', 'Wait for the new job')
  .action(async (jobId, opts) => {
    try {
      const { data } = await api.post(`/jobs/${jobId}/retry`);
      console.error(`🔁 Re-submitted as ${data.data.jobId}`);
      if (opts.watch) process.exit(await watch(data.data.jobId));
    } catch (err) {
      fail('Failed to retry', err);
    }
  });

program
  .command('watch <jobId>')
  .description('Wait for a job to finish, print its output and exit with its status')
  .action(async (jobId) => process.exit(await watch(jobId)));

program
  .command('health')
  .description('Check engine health')
  .action(async () => {
    try {
      const { data } = await api.get('/health', { validateStatus: () => true });
      const h = data.data;
      if (json()) return console.log(JSON.stringify(h, null, 2));
      console.log(`${h.status === 'healthy' ? '💚' : '⚠️'} ${String(h.status).toUpperCase()}  (v${h.version})`);
      for (const [name, check] of Object.entries<any>(h.checks)) {
        console.log(`   ${name.padEnd(8)} ${check.healthy ? '✅' : '❌'} ${check.message ?? ''}`);
      }
      process.exit(h.status === 'unhealthy' ? 1 : 0);
    } catch (err) {
      fail('Health check failed', err);
    }
  });

program
  .command('queue')
  .description('Show queue and worker statistics')
  .action(async () => {
    try {
      const { data } = await api.get('/queue/stats');
      if (json()) return console.log(JSON.stringify(data.data, null, 2));
      const { queue: q, workers: w } = data.data;
      console.log(`📊 Queue${q.paused ? ' (PAUSED)' : ''}`);
      console.log(`   Waiting: ${q.waiting}  Active: ${q.active}  Delayed: ${q.delayed}`);
      console.log(`\n🔧 Workers: ${w.instances} instance(s)`);
      console.log(`   Slots busy: ${w.active}/${w.total}  Avg duration: ${w.averageExecutionTime}ms`);
      console.log(`   Completed: ${w.completed}  Failed: ${w.failed}`);
    } catch (err) {
      fail('Failed to get queue stats', err);
    }
  });

function readFile(file: string): string {
  const p = path.resolve(file);
  if (!fs.existsSync(p)) {
    console.error(`❌ Script file not found: ${p}`);
    process.exit(1);
  }
  return fs.readFileSync(p, 'utf8');
}

function printLogs(data: any, opts: { stdout?: boolean; stderr?: boolean } = {}) {
  if (!data.available) {
    console.error('(no output recorded yet)');
    return;
  }
  if (!opts.stderr) process.stdout.write(data.logs.stdout);
  if (!opts.stdout) process.stderr.write(data.logs.stderr);
  if (data.truncated) console.error('\n[output truncated by server limit]');
}

async function watch(jobId: string): Promise<number> {
  let last = '';
  let failures = 0;
  for (;;) {
    try {
      const { data } = await api.get(`/jobs/${jobId}`);
      failures = 0;
      const j = data.data;
      if (j.status !== last) {
        const attempt = j.maxAttempts > 1 && j.attempt ? ` (attempt ${j.attempt}/${j.maxAttempts})` : '';
        console.error(`${ICONS[j.status] ?? '•'} [${new Date().toLocaleTimeString()}] ${j.status}${attempt}`);
        last = j.status;
      }
      if (TERMINAL.has(j.status)) {
        const { data: logs } = await api.get(`/logs/${jobId}`);
        if (json()) {
          console.log(JSON.stringify({ ...j, logs: logs.data.logs }, null, 2));
        } else {
          printLogs(logs.data);
          console.error(
            `\n${ICONS[j.status]} ${j.status}` +
              (j.exitCode !== null ? `, exit code ${j.exitCode}` : '') +
              (j.duration !== null ? `, ${j.duration}ms` : '') +
              (j.error && j.status !== 'completed' ? `: ${j.error}` : '')
          );
        }
        return EXIT_CODES[j.status];
      }
    } catch (err) {
      const status = (err as AxiosError).response?.status;
      if (status === 404 || status === 401 || status === 403) fail('Watch failed', err);
      if (++failures > 30) fail('Watch failed', err);
    }
    await sleep(1000);
  }
}

program.parseAsync(process.argv);
