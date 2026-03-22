#!/usr/bin/env node

import { Command } from 'commander';
import axios, { AxiosInstance } from 'axios';
import fs from 'fs';
import path from 'path';

const program = new Command();
let apiClient: AxiosInstance;

program
  .name('forge')
  .description('TestForge CLI - Submit and monitor distributed test jobs')
  .version('1.0.0')
  .option('-H, --host <host>', 'API host', 'http://localhost:3000')
  .hook('preAction', (thisCommand) => {
    const opts = thisCommand.opts();
    apiClient = axios.create({
      baseURL: `${opts.host}/api/v1`,
      timeout: 30000,
    });
  });

// ── submit ──────────────────────────────────────────────────────────────────
program
  .command('run')
  .description('Submit a test job to the engine')
  .option('-s, --script <file>', 'Path to script file to execute')
  .option('-c, --command <cmd>', 'Command to run (e.g. node, python3)')
  .option('-a, --args <args...>', 'Arguments for the command')
  .option('-t, --timeout <ms>', 'Timeout in milliseconds', '30000')
  .option('-m, --metadata <json>', 'Metadata as JSON string')
  .option('-w, --watch', 'Wait and stream job progress until completion')
  .action(async (opts) => {
    const payload: Record<string, any> = {
      timeout: parseInt(opts.timeout, 10),
      metadata: opts.metadata ? JSON.parse(opts.metadata) : undefined,
    };

    if (opts.script) {
      const scriptPath = path.resolve(opts.script);
      if (!fs.existsSync(scriptPath)) {
        console.error(`❌ Script file not found: ${scriptPath}`);
        process.exit(1);
      }
      payload.script = fs.readFileSync(scriptPath, 'utf8');
    } else if (opts.command) {
      payload.command = opts.command;
      payload.args = opts.args || [];
    } else {
      console.error('❌ Provide either --script or --command');
      process.exit(1);
    }

    try {
      const { data } = await apiClient.post('/submit-test', payload);
      const jobId = data.data.jobId;
      console.log(`✅ Job submitted: ${jobId}`);
      console.log(`   Queue position: ${data.data.queuePosition}`);

      if (opts.watch) {
        await watchJob(jobId);
      } else {
        console.log(`\nTo monitor: forge status ${jobId}`);
        console.log(`To watch:   forge watch ${jobId}`);
      }
    } catch (err: any) {
      console.error('❌ Failed to submit job:', err.response?.data?.error || err.message);
      process.exit(1);
    }
  });

// ── status ───────────────────────────────────────────────────────────────────
program
  .command('status <jobId>')
  .description('Get the current status of a job')
  .action(async (jobId) => {
    try {
      const { data } = await apiClient.get(`/status/${jobId}`);
      const job = data.data;
      const statusIcon = job.status === 'completed' ? '✅' : job.status === 'failed' ? '❌' : '🔄';
      console.log(`${statusIcon} Job: ${jobId}`);
      console.log(`   Status:   ${job.status}`);
      console.log(`   Attempts: ${job.attemptsMade}`);
      if (job.result) {
        console.log(`   Exit:     ${job.result.exitCode}`);
        console.log(`   Duration: ${job.result.duration}ms`);
        if (job.result.error) console.log(`   Error:    ${job.result.error}`);
      }
    } catch (err: any) {
      console.error('❌ Failed to get status:', err.response?.data?.error || err.message);
      process.exit(1);
    }
  });

// ── logs ─────────────────────────────────────────────────────────────────────
program
  .command('logs <jobId>')
  .description('Get stdout/stderr logs for a job')
  .option('--stderr', 'Show only stderr')
  .action(async (jobId, opts) => {
    try {
      const { data } = await apiClient.get(`/logs/${jobId}`);
      const logs = data.data.logs;
      if (opts.stderr) {
        console.log(logs.stderr || '(empty)');
      } else {
        console.log('=== STDOUT ===');
        console.log(logs.stdout || '(empty)');
        console.log('\n=== STDERR ===');
        console.log(logs.stderr || '(empty)');
      }
    } catch (err: any) {
      console.error('❌ Failed to get logs:', err.response?.data?.error || err.message);
      process.exit(1);
    }
  });

// ── cancel ────────────────────────────────────────────────────────────────────
program
  .command('cancel <jobId>')
  .description('Cancel a running or pending job')
  .action(async (jobId) => {
    try {
      await apiClient.delete(`/jobs/${jobId}`);
      console.log(`🛑 Job ${jobId} cancelled`);
    } catch (err: any) {
      console.error('❌ Failed to cancel:', err.response?.data?.error || err.message);
      process.exit(1);
    }
  });

// ── retry ─────────────────────────────────────────────────────────────────────
program
  .command('retry <jobId>')
  .description('Retry a failed job')
  .action(async (jobId) => {
    try {
      await apiClient.post(`/jobs/${jobId}/retry`);
      console.log(`🔁 Job ${jobId} queued for retry`);
    } catch (err: any) {
      console.error('❌ Failed to retry:', err.response?.data?.error || err.message);
      process.exit(1);
    }
  });

// ── health ────────────────────────────────────────────────────────────────────
program
  .command('health')
  .description('Check engine health')
  .action(async () => {
    try {
      const { data } = await apiClient.get('/health');
      const h = data.data;
      const icon = h.status === 'healthy' ? '💚' : '⚠️';
      console.log(`${icon} Engine Status: ${h.status.toUpperCase()}`);
      console.log(`   Uptime: ${Math.round(h.uptime)}s`);
      console.log(`   Redis:   ${h.checks.redis ? '✅' : '❌'}`);
      console.log(`   Queue:   ${h.checks.queue ? '✅' : '❌'}`);
      console.log(`   Workers: ${h.checks.workers ? '✅' : '❌'}`);
    } catch (err: any) {
      console.error('❌ Health check failed:', err.message);
      process.exit(1);
    }
  });

// ── queue ─────────────────────────────────────────────────────────────────────
program
  .command('queue')
  .description('Show queue statistics')
  .action(async () => {
    try {
      const { data } = await apiClient.get('/queue/stats');
      const q = data.data.queue;
      const w = data.data.workers;
      console.log('📊 Queue Stats:');
      console.log(`   Waiting:   ${q.waiting}`);
      console.log(`   Active:    ${q.active}`);
      console.log(`   Completed: ${q.completed}`);
      console.log(`   Failed:    ${q.failed}`);
      console.log(`   Delayed:   ${q.delayed}`);
      console.log('\n🔧 Worker Stats:');
      console.log(`   Active: ${w.active} / ${w.total}`);
      console.log(`   Idle:   ${w.idle}`);
      console.log(`   Avg Duration: ${Math.round(w.averageExecutionTime)}ms`);
    } catch (err: any) {
      console.error('❌ Failed to get queue stats:', err.message);
      process.exit(1);
    }
  });

// ── watch (internal helper) ───────────────────────────────────────────────────
program
  .command('watch <jobId>')
  .description('Watch a job until completion')
  .action(watchJob);

async function watchJob(jobId: string): Promise<void> {
  console.log(`👀 Watching job ${jobId}...`);
  const terminalStates = ['completed', 'failed', 'cancelled'];
  let lastStatus = '';

  while (true) {
    try {
      const { data } = await apiClient.get(`/status/${jobId}`);
      const job = data.data;

      if (job.status !== lastStatus) {
        const icons: Record<string, string> = {
          pending: '⏳', active: '🔄', completed: '✅', failed: '❌', cancelled: '🛑'
        };
        console.log(`${icons[job.status] || '•'} [${new Date().toLocaleTimeString()}] Status: ${job.status}`);
        lastStatus = job.status;
      }

      if (terminalStates.includes(job.status)) {
        if (job.result) {
          console.log(`\n📋 Result:`);
          console.log(`   Exit Code: ${job.result.exitCode}`);
          console.log(`   Duration:  ${job.result.duration}ms`);
          if (job.result.stdout) {
            console.log('\n--- stdout ---');
            console.log(job.result.stdout.substring(0, 500));
          }
          if (job.result.error) {
            console.log('\n--- error ---');
            console.log(job.result.error);
          }
        }
        break;
      }

      await new Promise(r => setTimeout(r, 1500));
    } catch (err: any) {
      console.error('❌ Watch error:', err.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

program.parse(process.argv);
