/**
 * 采集器基类
 */

import { EventEmitter } from 'events';

export abstract class BaseCollector extends EventEmitter {
    abstract start(): Promise<void>;
    abstract stop(): Promise<void>;
    abstract getName(): string;
}
