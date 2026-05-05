/**
 * Shared Bearer Token Auth Middleware
 * 
 * Token resolution order:
 * 1. Environment variable: ICE_AUTH_TOKEN
 * 2. Fallback config value
 * 3. Auto-generated random token (if none configured)
 * 
 * Auth is always enforced. Localhost requests (127.0.0.1, ::1) are exempted
 * to allow same-machine proxy (e.g. Desktop → Admin) to work without tokens.
 */

import { randomBytes } from 'crypto';
import type { Request, Response, NextFunction } from 'express';

export interface AuthMiddlewareConfig {
    token?: string;
}

/**
 * Generate a random hex token
 */
function generateToken(): string {
    return randomBytes(24).toString('hex');
}

/**
 * Check if the request originates from localhost
 */
function isLocalhost(req: Request): boolean {
    const ip = req.ip || req.socket.remoteAddress || '';
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === 'localhost';
}

/**
 * Get auth token from environment variable, fallback to config.
 * If none configured, auto-generate and log a warning.
 */
export function getAuthToken(configToken?: string): string {
    const envToken = process.env.ICE_AUTH_TOKEN || configToken || '';
    if (envToken) return envToken;

    const generated = generateToken();
    console.log(`[AUTH] No AUTH_TOKEN configured. Generated token: ${generated}. Set AUTH_TOKEN env var to use your own.`);
    return generated;
}

/**
 * Create Bearer token auth middleware.
 * Always enforces auth unless request is from localhost.
 */
export function createBearerAuthMiddleware(config: AuthMiddlewareConfig) {
    const token = getAuthToken(config.token);

    return (req: Request, res: Response, next: NextFunction): void => {
        // Exempt localhost (same-machine proxy)
        if (isLocalhost(req)) {
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
