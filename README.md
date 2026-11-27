# TestForge

A distributed, sandboxed test execution engine. Submit a script or command over
HTTP, the CLI, or the web dashboard. TestForge queues it, runs it in an isolated
container on a pool of workers, streams the output live and keeps the result.

- **Sandboxed by default.** Every job runs in a fresh container with no network,
  a read-only filesystem, no Linux capabilities, an unprivileged user, and
  CPU, memory and process limits.
- **Distributed.** API servers and workers are separate processes that scale
  independently. Redis and BullMQ carry the queue; Redis pub/sub carries live
  logs and cancellation between processes.
- **Reliable.** Retries with exponential backoff, timeouts, cancellation of
  queued or running jobs, crash recovery, and graceful shutdown that re-queues
  interrupted jobs instead of failing them.
- **Multi-user.** API keys, per-user job isolation, admin keys for queue
  operations, per-key quotas, and rate limits shared across API servers.
- **CI-friendly.** Priorities, batches and test matrices, JUnit/TAP result
  parsing, downloadable artifacts, and signed webhooks when jobs finish.
- **Observable.** Structured JSON logs, Prometheus metrics, a Grafana
  dashboard, and health and readiness endpoints.

---

## Architecture

```
            ┌──────────────┐   ┌───────────┐   ┌──────────────┐
 clients →  │  Dashboard   │   │  forge    │   │  REST/JSON   │
            │ (browser)    │   │  CLI      │   │  clients     │
            └──────┬───────┘   └─────┬─────┘   └──────┬───────┘
                   └──────── HTTPS + WebSocket ───────┘
                                     │  X-API-Key
                        ┌────────────▼────────────┐
                        │  API server(s)          │  ENGINE_MODE=api
                        │  Express + Socket.IO    │  validation, auth, rate limits
                        └──────┬──────────▲───────┘
                 enqueue job   │          │  status / log events (pub/sub)
                        ┌──────▼──────────┴───────┐
                        │         Redis           │  BullMQ queue, job records,
                        │                         │  output, worker heartbeats
                        └──────┬──────────▲───────┘
                 claim job     │          │  status, logs, results
                        ┌──────▼──────────┴───────┐
                        │  Worker(s)              │  ENGINE_MODE=worker
                        │  BullMQ worker          │  concurrency N each
                        └──────┬──────────────────┘
                               │ Docker API
                ┌──────────────▼───────────────┐
                │ one locked-down container    │  --network none, read-only fs,
                │ per job attempt              │  cap-drop ALL, user nobody,
                └──────────────────────────────┘  memory/CPU/pids limits
```

**Job lifecycle:** `queued → running → completed | failed | timeout | cancelled`,
with `retrying` between attempts when `retries > 0`.

Job records live in Redis independently of BullMQ's own retention, for
`JOB_TTL_SECONDS` (7 days by default). They hold the spec, status, attempts,
exit code, timing, and stdout/stderr (capped at `MAX_OUTPUT_BYTES`).

## Security model

Read this before exposing TestForge to anyone.

| Layer | Protection |
|---|---|
| API | API keys sent only in headers (`X-API-Key` or `Authorization: Bearer`) and compared in constant time. Users see only their own jobs (other users' jobs return 404). Admin keys are required for queue control and system introspection. Per-key rate limits, a stricter limit on submissions, strict input validation, a strict CSP, and no secrets or request bodies in logs. |
| Job spec | A command must be a bare name on `WORKER_ALLOWED_COMMANDS` and runs without a shell (arguments are passed as-is). Job env vars can't override `PATH`, `LD_*`, `NODE_OPTIONS` and similar loader or interpreter hooks. Scripts and metadata have size limits. |
| Sandbox (`WORKER_EXECUTOR=docker`) | A fresh container per attempt: `NetworkMode=none`, read-only root filesystem with tmpfs `/workspace` and `/tmp`, `CapDrop=ALL`, `no-new-privileges`, user `65534`, memory (no swap), CPU and pids limits, `nofile` ulimit, and an init process. The container is force-removed afterwards, and orphans left by a crash are removed on worker start. Jobs never see the worker's environment. |
| Worker host | The worker talks to the Docker daemon, which is root-equivalent on that host. Run workers on dedicated hosts or VMs that hold nothing else of value. For untrusted code, add a stronger runtime with `DOCKER_RUNTIME=runsc` (gVisor) or Kata Containers. The public API never gets the Docker socket. |

`WORKER_EXECUTOR=local` runs jobs as plain child processes with the worker's
privileges. It's for local development only, and TestForge refuses to start
with it in production unless you set `WORKER_ALLOW_UNSAFE_LOCAL=true`.

## Quick start (Docker Compose)

Requires Docker with Compose v2.24 or newer.

```bash
./scripts/init-env.sh             # writes .env with random Redis password + API keys
docker compose up -d --build      # redis + api + worker
open http://localhost:3000        # dashboard → "API Key" → paste the user key
```

Then run a job:

```bash
npm ci && npm run build
export TESTFORGE_HOST=http://localhost:3000 TESTFORGE_API_KEY=<user key from init-env>
echo 'console.log("hello from", process.version)' > hello.js
npx forge run -s hello.js --watch
```

To change the stack:

```bash
docker compose up -d --scale worker=4             # more capacity
docker compose --profile monitoring up -d         # Prometheus :9090 and Grafana :3001 (localhost only)
docker compose logs -f worker                     # JSON logs
```

The first job for each language pulls its runtime image, so it's slower. Set
`DOCKER_PULL_POLICY=never` and pre-pull images on air-gapped hosts.

## Local development

```bash
npm ci
docker run -d --rm -p 6379:6379 redis:7-alpine
cp .env.example .env
# in .env: API_AUTH_ENABLED=false (or set API_KEYS), and optionally
#          WORKER_EXECUTOR=local to run without Docker
npm run dev                       # hybrid mode: API + worker in one process, auto-reload
```

| Command | Purpose |
|---|---|
| `npm test` | Unit tests (mocked Redis and Docker; the local executor uses real processes) |
| `REDIS_TEST_URL=redis://127.0.0.1:6379/1 npm run test:integration` | End-to-end against real Redis and BullMQ |
| `npm run test:coverage` | Unit tests with coverage thresholds |
| `npm run lint` / `npm run typecheck` | Static checks |
| `npm run build && npm start` | Production build |

## Using the API

Every endpoint is under `/api/v1` and returns `{ success, data?, error?, details? }`.
Send `X-API-Key: <key>` on every request except `/health`.

### Submit a job: `POST /jobs`

```json
{
  "language": "python",
  "script": "import sys\nprint(sys.version)",
  "env": { "SUITE": "smoke" },
  "timeout": 60000,
  "retries": 2,
  "metadata": { "commit": "abc123" }
}
```

To run a command instead of a script: `{ "command": "npm", "args": ["test"], "language": "node" }`.

| Field | Notes |
|---|---|
| `script` / `command` | Exactly one is required. A `command` is a single allow-listed executable; put its parameters in `args`. |
| `language` | `bash` (default), `sh`, `node`, `python`, `ruby`, `php`, `go`, `java`. Chooses the interpreter and image. For commands, it is inferred from the command when omitted. |
| `timeout` | Milliseconds, from 1000 to `SECURITY_MAX_EXECUTION_TIME`. Defaults to `WORKER_TIMEOUT`. |
| `retries` | Extra attempts after a failure or timeout, up to `QUEUE_MAX_RETRIES`. Backoff is exponential. |
| `priority` | `high`, `normal` (default) or `low`. Higher-priority jobs are picked first. |
| `webhookUrl` | Receives a signed POST when the job finishes (see [Webhooks](#webhooks)). Must be `https` and public by default. |
| `env` | Up to 64 variables. Reserved names are rejected. Values are never returned by the API. |

It returns `201 { jobId, status: "queued", submittedAt }`.

### Other endpoints

| Method and path | Who | Description |
|---|---|---|
| `GET /jobs?status=&page=&limit=` | owner | List jobs, newest first |
| `GET /jobs/:id` | owner | Job detail (script, args, env key names, attempts, result) |
| `GET /logs/:id` | owner | `{ logs: { stdout, stderr }, truncated, available }` |
| `GET /result/:id` | owner | Detail plus full output |
| `GET /status/:id` | owner | Summary plus the first 4 KB of output (legacy) |
| `GET /jobs/:id/report` | owner | Parsed JUnit/TAP test report, or `null` |
| `GET /jobs/:id/artifacts` | owner | `{ artifacts: [{ name, size }], truncated }` |
| `GET /jobs/:id/artifacts/<name>` | owner | Download one artifact (always `application/octet-stream`, as an attachment) |
| `POST /batches` | owner | Submit a list of jobs or a test matrix (see [Batches](#batches-and-test-matrices)) |
| `GET /batches`, `GET /batches/:id` | owner | Batch progress, per-job status, rolled-up test counts |
| `DELETE /batches/:id` | owner | Cancel every unfinished job in the batch |
| `DELETE /jobs/:id` | owner | Cancel: `200 cancelled` if it was queued, `202 cancelling` if it's running |
| `POST /jobs/:id/retry` | owner | Re-run a failed, timed-out or cancelled job as a new job (`retryOf` links them) |
| `GET /queue/stats` | any key | Queue counts plus aggregated worker capacity |
| `GET /health` | public | `healthy` / `degraded` (no workers) / `unhealthy` (503, Redis down) |
| `GET /workers` | admin | Live worker heartbeats |
| `GET /metrics`, `GET /metrics/prometheus`, `GET /info` | admin | Introspection |
| `POST /queue/pause`, `POST /queue/resume` | admin | Stop or start taking new jobs. Running jobs finish. |
| `DELETE /queue/clear` | admin | Cancel every job that hasn't started |

`POST /submit-test` still works as an alias of `POST /jobs`.

### Real-time: Socket.IO

```js
const socket = io('https://testforge.example', { auth: { apiKey } });
socket.emit('subscribe-job', jobId);
socket.on('job-state',  ({ job }) => {});                    // snapshot on subscribe
socket.on('job-log',    ({ stream, data }) => {});           // live stdout/stderr
socket.on('job-status', ({ status, exitCode, error }) => {}); // every transition
```

You also receive `job-status` and `batch-status` events for all of your own
jobs and batches without subscribing; admins receive them for everything.

### Test reports and artifacts

Every job gets a writable directory in `$TESTFORGE_ARTIFACTS`. Anything a job
writes there is kept with the job, up to `ARTIFACT_MAX_FILES` files and
`ARTIFACT_MAX_BYTES` bytes, and can be downloaded from the API, CLI or
dashboard.

TestForge builds a test report automatically:

- **JUnit XML:** any `*.xml` artifact with `<testcase>` elements. This works
  with pytest `--junitxml`, jest-junit, Maven Surefire, go-junit-report and
  others. Several files are merged.
- **TAP:** otherwise, TAP printed to stdout (`TAP version 13` or a `1..N` plan).

```bash
pytest --junitxml="$TESTFORGE_ARTIFACTS/junit.xml"
```

The report (totals plus up to 50 failures with messages) appears in job
details, list views, the dashboard, batch summaries and webhook payloads. A
job's status still comes from its exit code.

### Batches and test matrices

`POST /batches` takes either an explicit list of jobs or a matrix that
expands into the cartesian product of its axes (up to `BATCH_MAX_JOBS`):

```json
{
  "name": "nightly",
  "webhookUrl": "https://ci.example.com/hooks/testforge",
  "matrix": {
    "base": { "language": "bash", "script": "./run-suite.sh \"$SUITE\"", "timeout": 600000 },
    "axes": { "env": { "SUITE": ["unit", "integration", "e2e"], "DB": ["postgres", "mysql"] } }
  }
}
```

That creates 6 jobs. Each one records its combination in `metadata.matrix`.
A `language` axis is also available, but every language must accept the same
script. The whole batch is checked against your quota up front. A batch is
`completed` only when every job completed; otherwise it ends `failed`.

### Webhooks

When a job finishes, TestForge POSTs `{ id, event: "job.finished", createdAt, job }`
to the job's `webhookUrl`. When the last job of a batch finishes, it sends
`event: "batch.finished"` with the batch summary to the batch's URL. Admins can
also send every event to `WEBHOOK_URLS`. Deliveries run from workers through
their own queue, with exponential backoff for up to `WEBHOOK_MAX_ATTEMPTS`
attempts. A 2xx response counts as delivered; 4xx responses (except 408 and
429) are not retried. Each job produces its event exactly once, even if a
cancel races with completion. Delivery itself is at-least-once, so deduplicate
on `X-TestForge-Delivery`.

Requests carry the headers `X-TestForge-Event`, `X-TestForge-Delivery` (a
unique id) and `X-TestForge-Timestamp`. When `WEBHOOK_SECRET` is set, they also
carry `X-TestForge-Signature: sha256=HMAC_SHA256(secret, "<timestamp>.<raw body>")`.
Verify it like this:

```js
const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(`${req.headers['x-testforge-timestamp']}.${rawBody}`).digest('hex');
const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers['x-testforge-signature']));
```

User-supplied URLs must be `https` and must not point at private, loopback,
link-local or metadata addresses. The address check runs again at connect
time, so DNS rebinding can't get around it. Relax this with
`WEBHOOK_ALLOW_HTTP` and `WEBHOOK_ALLOW_PRIVATE_NETWORKS` only on trusted
networks.

### Quotas and rate limits

Non-admin keys are limited to `QUOTA_MAX_ACTIVE_JOBS` queued or running jobs
(default 100) and, optionally, `QUOTA_MAX_JOBS_PER_DAY` submissions per UTC
day. Going over returns `429` with details. Rate limits (`RATE_LIMIT_MAX`
requests and `SUBMIT_RATE_LIMIT_MAX` submissions per window) are counted in
Redis, so they hold across every API replica.

## CLI

```bash
forge run -s tests.py --watch                   # language inferred from extension
forge run -c npm -a test -l node -e CI=1 -r 2   # command, env, retries
cat suite.sh | forge run -s - --watch           # script from stdin
forge run -s suite.py -p high --webhook https://ci.example.com/hook
forge list --status failed
forge status|logs|cancel|retry|watch <jobId>
forge report <jobId>                            # test results; exits 1 if any failed
forge artifacts <jobId> [-o ./artifacts]        # list or download
forge batch run matrix.json --watch             # exit 0 only if every job completed
forge batch status|watch|cancel <batchId>; forge batch list
forge queue | forge health
```

The host comes from `--host` or `TESTFORGE_HOST`, and the key from `--api-key`
or `TESTFORGE_API_KEY`. Add `--json` for machine-readable output.

`run --watch` and `watch` exit with **0** (completed), **1** (failed),
**2** (timeout) or **3** (cancelled), so CI pipelines can use them directly.

## Configuration

Everything is set with environment variables. `.env.example` documents every
option with its default. Invalid configuration stops startup with exit code 78
and a list of the problems. The main options:

| Variable | Default | |
|---|---|---|
| `ENGINE_MODE` | `hybrid` | `api`, `worker`, or both in one process |
| `API_KEYS` / `ADMIN_API_KEYS` | none | Comma-separated, at least 16 characters each. Required unless `API_AUTH_ENABLED=false`. |
| `REDIS_URL` or `REDIS_HOST`/`PORT`/`PASSWORD` | `127.0.0.1:6379` | Redis must use `maxmemory-policy noeviction` |
| `WORKER_EXECUTOR` | `docker` | `local` is for development only |
| `WORKER_CONCURRENCY` | `4` | Jobs run in parallel per worker process |
| `WORKER_MAX_MEMORY_MB` / `WORKER_CPUS` / `WORKER_PIDS_LIMIT` | `512` / `1` / `256` | Per-job sandbox limits |
| `WORKER_NETWORK_ENABLED` | `false` | Give jobs network access, e.g. for `npm install` |
| `DOCKER_RUNTIME` | none | For example `runsc` for gVisor |
| `RUNTIME_IMAGE_<LANG>` | see `.env.example` | Swap in images that have your test dependencies preinstalled |
| `WORKER_TIMEOUT` / `SECURITY_MAX_EXECUTION_TIME` | 5 min / 30 min | Default and maximum job timeout |
| `JOB_TTL_SECONDS` | 7 days | How long job records and output are kept |
| `MAX_OUTPUT_BYTES` | 1 MiB | Cap on stdout and stderr combined, per attempt |
| `TRUST_PROXY` | `false` | Set behind a load balancer so rate limits see the real client IP |
| `QUOTA_MAX_ACTIVE_JOBS` / `QUOTA_MAX_JOBS_PER_DAY` | `100` / `0` | Per-key quotas (`0` = unlimited; admins are exempt) |
| `ARTIFACT_MAX_BYTES` / `ARTIFACT_MAX_FILES` | 10 MiB / `50` | Per-job artifact limits |
| `WEBHOOK_SECRET` | none | Signs webhook deliveries. Set it. |
| `RATE_LIMIT_STORE` | `redis` | `memory` makes limits per instance |
| `METRICS_PORT` | `9100` | Internal port for `/metrics` and `/health`. Don't expose it publicly. |

## Operations

- **Scaling:** add worker replicas for capacity and API replicas for request
  load. Both are stateless; rate limits and quotas live in Redis.
- **Deploys and shutdown:** on SIGTERM, an API server stops accepting
  connections. A worker stops taking jobs and waits up to `SHUTDOWN_TIMEOUT` for
  running jobs to finish. Any job still running after that is stopped and put
  back in the queue, then another worker runs it once the lock expires (about
  30 seconds). Set the orchestrator's grace period longer than
  `SHUTDOWN_TIMEOUT`; Compose uses 60 s.
- **Crashes:** BullMQ's stalled-job check re-queues jobs held by a crashed
  worker. The worker removes its orphaned containers on restart.
- **Health checks:** `GET /api/v1/health` on the API port is for load
  balancers. `GET :9100/health` is per-process liveness, and the Docker image
  `HEALTHCHECK` uses it.
- **Monitoring:** Prometheus scrapes `:9100/metrics` on every API and worker
  instance (discovered by DNS in Compose). Key series:
  `forge_jobs_completed_total{status}`, `forge_job_duration_ms`,
  `forge_queue_waiting`, `forge_workers_active`, and
  `forge_http_request_duration_seconds`.
- **Backups and history:** Redis runs with AOF persistence (the `redis_data`
  volume). Job history, output and artifacts expire after `JOB_TTL_SECONDS`.
  For permanent records, point `WEBHOOK_URLS` at a service that stores the
  `job.finished` payloads, or raise the TTL and size Redis to fit.
- **Artifacts and Redis memory:** artifacts are stored in Redis. Size Redis for
  roughly `ARTIFACT_MAX_BYTES` × jobs per TTL period, or lower the limits.
- **Custom runtime images** (`RUNTIME_IMAGE_*`) need `sh`, and `tar` for
  artifacts. Every default Alpine-based image has both.
- **TLS:** terminate TLS at a reverse proxy (nginx, Caddy, or a cloud load
  balancer) in front of the API and set `TRUST_PROXY`. For a remote Redis, use
  `REDIS_URL=rediss://…`.

## Project layout

```
src/
  index.ts              entry point: mode selection, startup checks, graceful shutdown
  config/               typed, validated configuration
  api/                  Express app, auth, rate limits, routes, Socket.IO
  jobs/                 job service (validation, ownership, quotas, cancel/retry), batches,
                        lifecycle (finalize-once), JUnit/TAP reports, artifacts, Redis store, events
  webhooks/             signed, retried, SSRF-guarded webhook delivery
  queue/                Redis connections, BullMQ queue wrapper
  workers/              worker manager (lifecycle, retries, heartbeats), Docker and local executors
  cli/forge.ts          command-line client
  metricsServer.ts      internal /metrics + /health listener
public/                 dashboard (static, CSP-compatible; no inline script)
test/                   unit, realtime and integration tests
docker/                 Prometheus config, Grafana provisioning and dashboard
scripts/init-env.sh     generates a production .env
```

## License

MIT
