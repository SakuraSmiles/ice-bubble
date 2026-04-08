/**
 * 采集策略接口
 */

import { CollectionMode } from '../types/index.js';

export interface CollectionStrategy {
    start(): Promise<void>;
    stop(): Promise<void>;
    getMode(): CollectionMode;
}
