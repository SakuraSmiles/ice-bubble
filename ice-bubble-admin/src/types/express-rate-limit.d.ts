declare module 'express-rate-limit' {
  import { Request, Response, NextFunction, RequestHandler } from 'express';

  interface RateLimitRequestHandler extends RequestHandler {}

  interface RateLimitOptions {
    windowMs: number;
    max: number;
    keyGenerator?: (req: Request) => string;
    skip?: (req: Request) => boolean;
    handler?: (req: Request, res: Response, next?: NextFunction) => void;
    standardHeaders?: boolean;
    legacyHeaders?: boolean;
    message?: string | object;
    statusCode?: number;
  }

  function rateLimit(options: RateLimitOptions): RateLimitRequestHandler;
  export default rateLimit;
}
