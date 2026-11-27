// Deterministic test configuration (loaded before any module).
process.env.NODE_ENV = 'test';
process.env.API_AUTH_ENABLED = 'true';
process.env.API_KEYS = 'user-key-0123456789abcdef,other-key-0123456789abcdef';
process.env.ADMIN_API_KEYS = 'admin-key-0123456789abcdef';
process.env.WORKER_EXECUTOR = 'local';
process.env.WORKER_TEMP_DIR = require('os').tmpdir() + '/testforge-tests';
process.env.WORKER_KILL_TIMEOUT = '1000';
process.env.LOG_LEVEL = 'silent';
process.env.METRICS_ENABLED = 'false';
