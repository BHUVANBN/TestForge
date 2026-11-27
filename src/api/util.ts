import { NextFunction, Request, RequestHandler, Response } from 'express';

/** Forward async errors to Express's error handler (Express 4 doesn't). */
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };
