import { createHmac } from 'crypto';
import dns from 'dns';
import http from 'http';
import { AddressInfo } from 'net';
import { loadConfig, setConfig } from '../src/config';
import { deliver, isPrivateAddress, signPayload, validateWebhookUrl } from '../src/webhooks';

describe('SSRF protection', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['172.20.0.1', true],
    ['192.168.1.1', true],
    ['169.254.169.254', true],
    ['100.64.0.1', true],
    ['::1', true],
    ['fd00::1', true],
    ['::ffff:127.0.0.1', true],
    ['8.8.8.8', false],
    ['2606:4700::1111', false],
  ])('isPrivateAddress(%s) = %s', (ip, expected) => expect(isPrivateAddress(ip)).toBe(expected));

  it('validates webhook URLs', () => {
    expect(validateWebhookUrl('https://hooks.example.com/ci')).toEqual([]);
    expect(validateWebhookUrl('http://hooks.example.com/ci').join()).toMatch(/https/);
    expect(validateWebhookUrl('https://user:pw@example.com').join()).toMatch(/credentials/);
    expect(validateWebhookUrl('https://169.254.169.254/latest').join()).toMatch(/private/);
    expect(validateWebhookUrl('https://localhost/x').join()).toMatch(/internal/);
    expect(validateWebhookUrl('ftp://example.com').join()).toMatch(/https/);
    expect(validateWebhookUrl('not a url').join()).toMatch(/absolute URL/);
  });

  it('refuses at connect time when DNS resolves to a private address (rebinding)', async () => {
    const spy = jest.spyOn(dns, 'lookup').mockImplementation(((_h: string, _o: unknown, cb: any) =>
      cb(null, [{ address: '169.254.169.254', family: 4 }])) as any);
    await expect(
      deliver({ id: '1', url: 'https://rebind.example.com/hook', event: 'job.finished', payload: {} })
    ).rejects.toThrow(/private address/);
    spy.mockRestore();
  });
});

describe('delivery', () => {
  let server: http.Server;
  let received: { headers: http.IncomingHttpHeaders; body: string }[];
  let status = 200;
  let url: string;

  beforeAll(async () => {
    setConfig(
      loadConfig({ ...process.env, WEBHOOK_ALLOW_HTTP: 'true', WEBHOOK_ALLOW_PRIVATE_NETWORKS: 'true', WEBHOOK_SECRET: 's3cret' })
    );
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.writeHead(status).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  });

  afterAll(async () => {
    setConfig(loadConfig());
    await new Promise((r) => server.close(r));
  });

  beforeEach(() => {
    received = [];
    status = 200;
  });

  it('POSTs a signed JSON payload', async () => {
    await deliver({ id: 'd1', url, event: 'job.finished', payload: { job: { id: 'j1', status: 'completed' } } });
    expect(received).toHaveLength(1);
    const { headers, body } = received[0];
    expect(JSON.parse(body)).toMatchObject({ id: 'd1', event: 'job.finished', job: { id: 'j1' } });
    expect(headers['x-testforge-event']).toBe('job.finished');
    const expected = `sha256=${createHmac('sha256', 's3cret').update(`${headers['x-testforge-timestamp']}.${body}`).digest('hex')}`;
    expect(headers['x-testforge-signature']).toBe(expected);
    expect(signPayload('s3cret', String(headers['x-testforge-timestamp']), body)).toBe(expected);
  });

  it('treats 5xx as retryable and 4xx as permanent', async () => {
    status = 503;
    const retryable = await deliver({ id: 'd2', url, event: 'job.finished', payload: {} }).catch((e) => e);
    expect(retryable.constructor.name).toBe('Error');
    status = 404;
    const permanent = await deliver({ id: 'd3', url, event: 'job.finished', payload: {} }).catch((e) => e);
    expect(permanent.constructor.name).toBe('PermanentError');
  });
});
