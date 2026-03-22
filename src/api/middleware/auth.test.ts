/**
 * Auth middleware unit tests.
 */

import { Request, Response, NextFunction } from 'express';

// We will manipulate the config mock per test
const mockConfig = {
  auth: { enabled: false, apiKeys: [] as string[] },
};

jest.mock('../../config', () => ({ __esModule: true, default: mockConfig }));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { apiKeyAuth } from '../middleware/auth';

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    query: {},
    path: '/some-path',
    ip: '127.0.0.1',
    ...overrides,
  } as unknown as Request;
}

function makeRes(): { res: Response; json: jest.Mock; status: jest.Mock } {
  const json = jest.fn().mockReturnThis();
  const status = jest.fn().mockReturnValue({ json });
  const res = { status, json } as unknown as Response;
  return { res, json, status };
}

describe('apiKeyAuth middleware', () => {
  const next: NextFunction = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockConfig.auth.enabled = false;
    mockConfig.auth.apiKeys = [];
  });

  it('should pass through when auth is disabled', () => {
    const req = makeReq();
    const { res } = makeRes();

    apiKeyAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('should pass through for /health even when auth is enabled', () => {
    mockConfig.auth.enabled = true;
    mockConfig.auth.apiKeys = ['secret-key'];

    const req = makeReq({ path: '/health' });
    const { res } = makeRes();

    apiKeyAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('should return 401 when key is missing and auth is enabled', () => {
    mockConfig.auth.enabled = true;
    mockConfig.auth.apiKeys = ['secret-key'];

    const req = makeReq({ path: '/submit-test' });
    const { res, status, json } = makeRes();

    apiKeyAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: false, error: 'Unauthorized' }));
  });

  it('should return 403 for an invalid API key', () => {
    mockConfig.auth.enabled = true;
    mockConfig.auth.apiKeys = ['secret-key'];

    const req = makeReq({
      path: '/submit-test',
      headers: { 'x-api-key': 'wrong-key' },
    });
    const { res, status } = makeRes();

    apiKeyAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
  });

  it('should pass through with a valid X-API-Key header', () => {
    mockConfig.auth.enabled = true;
    mockConfig.auth.apiKeys = ['secret-key'];

    const req = makeReq({
      path: '/submit-test',
      headers: { 'x-api-key': 'secret-key' },
    });
    const { res } = makeRes();

    apiKeyAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('should pass through with a valid api_key query parameter', () => {
    mockConfig.auth.enabled = true;
    mockConfig.auth.apiKeys = ['secret-key'];

    const req = makeReq({
      path: '/submit-test',
      query: { api_key: 'secret-key' },
    });
    const { res } = makeRes();

    apiKeyAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('should pass through when auth is enabled but no keys are configured', () => {
    mockConfig.auth.enabled = true;
    mockConfig.auth.apiKeys = [];

    const req = makeReq({ path: '/submit-test' });
    const { res } = makeRes();

    apiKeyAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});
