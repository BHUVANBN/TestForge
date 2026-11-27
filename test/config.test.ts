import { loadConfig } from '../src/config';

const base = {
  NODE_ENV: 'test',
  API_AUTH_ENABLED: 'true',
  API_KEYS: 'a-very-long-user-key-123',
};

describe('config', () => {
  it('loads secure defaults', () => {
    const cfg = loadConfig({ ...base });
    expect(cfg.auth.enabled).toBe(true);
    expect(cfg.workers.executor).toBe('docker');
    expect(cfg.docker.networkEnabled).toBe(false);
    expect(cfg.queue.defaultRetries).toBe(0);
    expect(cfg.mode).toBe('hybrid');
  });

  it('refuses auth without keys', () => {
    expect(() => loadConfig({ NODE_ENV: 'test' })).toThrow(/no keys are configured/);
  });

  it('allows disabling auth explicitly', () => {
    expect(loadConfig({ NODE_ENV: 'test', API_AUTH_ENABLED: 'false' }).auth.enabled).toBe(false);
  });

  it('rejects short API keys', () => {
    expect(() => loadConfig({ ...base, API_KEYS: 'short' })).toThrow(/at least 16/);
  });

  it('refuses the unsandboxed executor in production unless explicitly allowed', () => {
    const env = { ...base, NODE_ENV: 'production', WORKER_EXECUTOR: 'local' };
    expect(() => loadConfig(env)).toThrow(/refused in production/);
    expect(loadConfig({ ...env, WORKER_ALLOW_UNSAFE_LOCAL: 'true' }).workers.executor).toBe('local');
  });

  it('reports invalid values', () => {
    expect(() => loadConfig({ ...base, PORT: 'abc' })).toThrow(/Invalid numeric/);
    expect(() => loadConfig({ ...base, ENGINE_MODE: 'both' })).toThrow(/mode/);
    expect(() => loadConfig({ ...base, WORKER_TIMEOUT: '999999999' })).toThrow(/WORKER_TIMEOUT/);
    expect(() => loadConfig({ ...base, SECURITY_MAX_SCRIPT_BYTES: '500000' })).toThrow(/maxScriptBytes/);
  });

  it('parses lists, booleans and image overrides', () => {
    const cfg = loadConfig({
      ...base,
      CORS_ORIGIN: 'https://a.example, https://b.example',
      WORKER_NETWORK_ENABLED: 'yes',
      RUNTIME_IMAGE_NODE: 'node:20-alpine',
      TRUST_PROXY: '1',
    });
    expect(cfg.server.corsOrigins).toEqual(['https://a.example', 'https://b.example']);
    expect(cfg.docker.networkEnabled).toBe(true);
    expect(cfg.docker.images.node).toBe('node:20-alpine');
    expect(cfg.server.trustProxy).toBe(1);
  });
});
