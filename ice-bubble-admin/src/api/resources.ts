/**
 * Resources API - 静态资源
 *
 * NOTE: /avatars/:filename is registered in index.ts BEFORE auth middleware
 * (browser <img> tags cannot send Authorization header).
 * This router is mounted after auth, so no avatar route here.
 */

import { Router } from 'express';
import type { DataRepository } from '../storage/data-repository.js';

export function createResourcesRouter(_repository: DataRepository): Router {
  const router = Router();
  // Placeholder for future protected resource routes.
  return router;
}
