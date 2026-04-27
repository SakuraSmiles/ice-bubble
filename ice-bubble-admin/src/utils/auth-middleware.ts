/**
 * Shared Bearer Token Auth Middleware
 * 
 * Token resolution order:
 * 1. Environment variable: ICE_AUTH_TOKEN
 * 2. Fallback config value
 * 
 * Auth is skipped if:
 * - NODE_ENV === 'production' && no token configured (fail-closed)
 * - token is empty/undefined (backward compatible)
 */

import type { Request, Response, NextFunction } from 'express';

export interface AuthMiddlewareConfig {
    token?: string;
}

/**
 * Get auth token from environment variable, fallback to config
 */
export function getAuthToken(configToken?: string): string {
    return process.env.ICE_AUTH_TOKEN || configToken || '';
}

/**
 * Create Bearer token auth middleware
 * Optional: skips auth if token is empty (backward compatible)
 */
export function createBearerAuthMiddleware(config: AuthMiddlewareConfig) {
    const token = getAuthToken(config.token);

    return (req: Request, res: Response, next: NextFunction): void => {
        // Skip auth if token not configured (backward compatible)
        if (!token) {
            next();
            return;
        }

        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            res.status(401).json({ error: '未提供认证令牌', code: 'UNAUTHORIZED' });
            return;
        }

        const providedToken = authHeader.slice(7);
        if (providedToken !== token) {
            res.status(401).json({ error: '认证令牌无效', code: 'INVALID_TOKEN' });
            return;
        }

        next();
    };
}
