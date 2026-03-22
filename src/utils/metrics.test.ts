import { register, initMetrics, queueWaitingGauge, workersActiveGauge } from './metrics';
import client from 'prom-client';

describe('Metrics', () => {
  // Intentionally leaving registry intact as the metrics are module-scoped

  describe('initMetrics()', () => {
    it('should initialize successfully', () => {
      // should not throw
      expect(() => initMetrics()).not.toThrow();
    });
  });

  describe('Prometheus endpoints', () => {
    it('should expose metrics globally via register', async () => {
      initMetrics();
      queueWaitingGauge.set(5);
      workersActiveGauge.set(2);
      
      const metrics = await register.metrics();
      expect(metrics).toContain('forge_queue_waiting');
      expect(metrics).toContain('forge_workers_active');
    });
  });
});
