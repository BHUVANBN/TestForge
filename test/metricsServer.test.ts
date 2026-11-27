import { AddressInfo } from 'net';
import { loadConfig, setConfig } from '../src/config';
import { startMetricsServer } from '../src/metricsServer';

describe('metrics server', () => {
  beforeAll(() => setConfig(loadConfig({ ...process.env, METRICS_PORT: '0', METRICS_HOST: '127.0.0.1' })));
  afterAll(() => setConfig(loadConfig()));

  it('serves prometheus metrics and health', async () => {
    let healthy = true;
    const server = startMetricsServer({ sampleQueue: false, health: async () => healthy });
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const metrics = await fetch(`${base}/metrics`);
      expect(metrics.status).toBe(200);
      expect(await metrics.text()).toContain('forge_jobs_completed_total');

      expect((await fetch(`${base}/health`)).status).toBe(200);
      healthy = false;
      expect((await fetch(`${base}/health`)).status).toBe(503);
      expect((await fetch(`${base}/nope`)).status).toBe(404);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
