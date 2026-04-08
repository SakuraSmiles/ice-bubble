/**
 * OpenClaw .jsonl 文件读取工具
 * 
 * 提供文件读取和增量读取功能,用于解析 OpenClaw Session 文件
 */

import * as fs from 'fs';
import * as readline from 'readline';
import { OpenClawEvent } from '../types/openclaw';
import { Logger } from './logger';

const logger = new Logger('FileReader');

/**
 * 读取 .jsonl 文件,返回 OpenClaw 事件数组
 * 
 * @param filePath - .jsonl 文件路径
 * @returns OpenClaw 事件数组
 * @throws 文件不存在或格式错误时抛出异常
 * 
 * @example
 * const events = await readJsonlFile('/path/to/session.jsonl');
 * console.log(`读取了 ${events.length} 个事件`);
 */
export async function readJsonlFile(filePath: string): Promise<OpenClawEvent[]> {
  logger.debug(`开始读取文件: ${filePath}`);

  // 检查文件是否存在
  if (!fs.existsSync(filePath)) {
    throw new Error(`文件不存在: ${filePath}`);
  }

  const events: OpenClawEvent[] = [];
  let lineCount = 0;
  let errorCount = 0;

  return new Promise((resolve, reject) => {
    const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    rl.on('line', (line) => {
      lineCount++;
      
      // 跳过空行
      if (!line.trim()) {
        return;
      }

      try {
        const event = JSON.parse(line) as OpenClawEvent;
        events.push(event);
      } catch (error) {
        errorCount++;
        logger.warn(`第 ${lineCount} 行 JSON 解析失败: ${line.substring(0, 100)}...`);
      }
    });

    rl.on('close', () => {
      logger.info(`文件读取完成: ${filePath}`, {
        总行数: lineCount,
        成功解析: events.length,
        解析失败: errorCount
      });
      resolve(events);
    });

    rl.on('error', (error) => {
      logger.error(`文件读取失败: ${filePath}`, error);
      reject(error);
    });
  });
}

/**
 * 增量读取 .jsonl 文件(从指定行开始)
 * 
 * 用于断点续传场景,避免重复读取已处理的行
 * 
 * @param filePath - .jsonl 文件路径
 * @param startLine - 起始行号(从 0 开始)
 * @returns 事件数组和结束行号
 * 
 * @example
 * // 从第 100 行开始读取
 * const { events, endLine } = await readJsonlFileIncremental('/path/to/session.jsonl', 100);
 * console.log(`读取了 ${events.length} 个事件,结束于第 ${endLine} 行`);
 * 
 * // 下次增量读取
 * const nextResult = await readJsonlFileIncremental('/path/to/session.jsonl', endLine);
 */
export async function readJsonlFileIncremental(
  filePath: string, 
  startLine: number
): Promise<{ events: OpenClawEvent[], endLine: number }> {
  logger.debug(`增量读取文件: ${filePath}, 起始行: ${startLine}`);

  // 检查文件是否存在
  if (!fs.existsSync(filePath)) {
    throw new Error(`文件不存在: ${filePath}`);
  }

  // 起始行不能为负数
  if (startLine < 0) {
    throw new Error(`起始行号不能为负数: ${startLine}`);
  }

  const events: OpenClawEvent[] = [];
  let currentLine = 0;
  let errorCount = 0;

  return new Promise((resolve, reject) => {
    const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    rl.on('line', (line) => {
      // 跳过前 startLine 行
      if (currentLine < startLine) {
        currentLine++;
        return;
      }

      currentLine++;

      // 跳过空行
      if (!line.trim()) {
        return;
      }

      try {
        // 移除 BOM 字符（Windows UTF-8 with BOM）
        const cleanLine = line.replace(/^\uFEFF/, '');
        const event = JSON.parse(cleanLine) as OpenClawEvent;
        events.push(event);
      } catch (error) {
        errorCount++;
        logger.warn(`第 ${currentLine} 行 JSON 解析失败: ${line.substring(0, 100)}...`);
      }
    });

    rl.on('close', () => {
      logger.info(`增量读取完成: ${filePath}`, {
        起始行: startLine,
        结束行: currentLine,
        成功解析: events.length,
        解析失败: errorCount
      });
      resolve({
        events,
        endLine: currentLine
      });
    });

    rl.on('error', (error) => {
      logger.error(`增量读取失败: ${filePath}`, error);
      reject(error);
    });
  });
}

/**
 * 同步读取 .jsonl 文件(适用于小文件)
 * 
 * @param filePath - .jsonl 文件路径
 * @returns OpenClaw 事件数组
 * 
 * @example
 * const events = readJsonlFileSync('/path/to/session.jsonl');
 */
export function readJsonlFileSync(filePath: string): OpenClawEvent[] {
  logger.debug(`同步读取文件: ${filePath}`);

  if (!fs.existsSync(filePath)) {
    throw new Error(`文件不存在: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const events: OpenClawEvent[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }

    try {
      const event = JSON.parse(line) as OpenClawEvent;
      events.push(event);
    } catch (error) {
      logger.warn(`第 ${i + 1} 行 JSON 解析失败: ${line.substring(0, 100)}...`);
    }
  }

  logger.info(`同步读取完成: ${filePath}, 共 ${events.length} 个事件`);
  return events;
}
