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
- **Multi-user.** API keys, per-user job isolation, and admin keys for queue
  operations.
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

You also receive `job-status` events for all of your own jobs without
subscribing; admins receive them for every job.

## CLI

```bash
forge run -s tests.py --watch                   # language inferred from extension
forge run -c npm -a test -l node -e CI=1 -r 2   # command, env, retries
cat suite.sh | forge run -s - --watch           # script from stdin
forge list --status failed
forge status|logs|cancel|retry|watch <jobId>
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
| `METRICS_PORT` | `9100` | Internal port for `/metrics` and `/health`. Don't expose it publicly. |

## Operations

- **Scaling:** add worker replicas for capacity and API replicas for request
  load. Both are stateless. Rate limits are kept in memory per API instance.
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
- **Backups:** Redis runs with AOF persistence (the `redis_data` volume). Job
  history is operational data with a TTL; export it elsewhere if you need
  long-term records.
- **TLS:** terminate TLS at a reverse proxy (nginx, Caddy, or a cloud load
  balancer) in front of the API and set `TRUST_PROXY`. For a remote Redis, use
  `REDIS_URL=rediss://…`.

## Project layout

```
src/
  index.ts              entry point: mode selection, startup checks, graceful shutdown
  config/               typed, validated configuration
  api/                  Express app, auth, rate limits, routes, Socket.IO
  jobs/                 job service (validation, ownership, cancel/retry), Redis store,
                        pub/sub events, runtime definitions
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
