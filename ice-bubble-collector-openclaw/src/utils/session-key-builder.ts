/**
 * OpenClaw SessionKey 构造工具
 * 
 * SessionKey 格式: agent:{agentId}:{channel}:{accountId}:{type}:{targetId}
 * 
 * 参考文档:
 * - OpenClaw-Session数据格式参考.md
 * - 数据转换映射.md
 */

import * as path from 'path';
import * as fs from 'fs';
import { Logger } from './logger.js';

const logger = new Logger('SessionKeyBuilder');

// ==================== 模块级静态缓存 ====================
// 所有调用方共享同一个 Map，不受实例生命周期影响

/** UUID → Gateway 原始 session key 的映射（如 agent:main:main） */
let _keyMappings: Map<string, string> | undefined;
let _mappingsLoaded = false;

/**
 * 确保 sessions.json 映射已加载（模块级，仅首次调用执行一次）
 *
 * 遍历 agents 子目录下的 sessions.json 文件，
 * 构建 sessionId(UUID) → Gateway 原始 key 的反向映射。
 *
 * @param openclawDataDir - OpenClaw 数据根目录（如 ~/.openclaw）
 */
function ensureKeyMappingsLoaded(openclawDataDir?: string): void {
  if (_mappingsLoaded) return;
  _mappingsLoaded = true;

  if (!openclawDataDir) {
    logger.debug('openclawDataDir 未传入，跳过 sessions.json 加载');
    return;
  }

  try {
    const map = new Map<string, string>();
    const agentsDir = path.join(openclawDataDir, 'agents');

    if (!fs.existsSync(agentsDir)) {
      logger.debug(`agents 目录不存在，跳过: ${agentsDir}`);
      _keyMappings = map;
      return;
    }

    const agentDirs = fs.readdirSync(agentsDir, { withFileTypes: true });

    for (const entry of agentDirs) {
      if (!entry.isDirectory()) continue;

      const sessionsJsonPath = path.join(agentsDir, entry.name, 'sessions', 'sessions.json');

      try {
        if (!fs.existsSync(sessionsJsonPath)) continue;

        const content = fs.readFileSync(sessionsJsonPath, 'utf-8');
        const data = JSON.parse(content) as Record<string, any>;

        for (const [key, sessionEntry] of Object.entries(data)) {
          if (
            sessionEntry &&
            typeof sessionEntry.sessionId === 'string' &&
            typeof key === 'string' &&
            key.startsWith('agent:')
          ) {
            map.set(sessionEntry.sessionId, key);
          }
        }

        logger.debug(`已加载 sessions.json: agent=${entry.name}, mappings=${Object.keys(data).length}`);
      } catch (err) {
        // sessions.json 可能不存在或解析失败，容错跳过
        logger.debug(`sessions.json 加载失败，跳过: ${sessionsJsonPath}`, { error: String(err) });
      }
    }

    _keyMappings = map;
    logger.info(`模块级 session key 映射加载完成: ${map.size} 条`);
  } catch (err) {
    _keyMappings = new Map();
    logger.warn(`加载 sessions.json 映射失败: ${String(err)}`);
  }
}

/**
 * SessionKey 格式
 * 
 * 支持多种段数：
 * - 标准 6 段: agent:{agentId}:{channel}:{accountId}:{type}:{targetId}
 *   示例: agent:dev:local:default:direct:012582c0-3fc5-4a35-818c-0dd9a1c359d4
 * - 短 5 段: agent:{agentId}:subagent:{uuid}
 *   示例: agent:dev1:subagent:a1b2c3d4
 * - 短 4 段: agent:{agentId}:{targetId}
 *   示例: agent:main:main
 */
export interface SessionKeyComponents {
  agentId: string;
  channel: string;
  accountId: string;
  type: string;
  targetId: string;
}

/**
 * 从 Session 文件路径构造 SessionKey
 * 
 * 路径格式: ~/.openclaw/agents/<agentId>/sessions/<sessionKey>.jsonl
 * 输出格式: agent:{agentId}:{channel}:{accountId}:{type}:{targetId}
 * 
 * @param filePath - Session 文件路径
 * @param openclawDataDir - 可选，OpenClaw 数据根目录。传入后首次调用会加载 sessions.json 映射，
 *                          将 UUID 文件名反查为 Gateway 原始 key（如 agent:main:main）
 * @returns SessionKey 字符串
 * 
 * @example
 * const key = buildSessionKeyFromPath(
 *   '/home/user/.openclaw/agents/dev/sessions/agent:dev:local:default:direct:012582c0.jsonl'
 * );
 * // 返回: agent:dev:local:default:direct:012582c0
 */
export function buildSessionKeyFromPath(filePath: string, openclawDataDir?: string): string {
  // 标准化路径
  const normalizedPath = filePath.replace(/\\/g, '/');
  
  // 提取文件名(不含扩展名)
  const basename = path.basename(normalizedPath, '.jsonl');
  
  // 检查文件名是否已经是 SessionKey 格式
  if (basename.startsWith('agent:')) {
    return basename;
  }

  // 从路径中提取 agentId
  // 路径格式: ~/.openclaw/agents/<agentId>/sessions/<filename>.jsonl
  const pathParts = normalizedPath.split('/');
  const agentsIndex = pathParts.findIndex(p => p === 'agents');
  
  if (agentsIndex === -1 || agentsIndex + 1 >= pathParts.length) {
    logger.warn(`无法从路径提取 agentId: ${filePath}, 使用默认值 'unknown'`);
    return `agent:unknown:local:default:direct:${basename}`;
  }

  const agentId = pathParts[agentsIndex + 1];
  
  // 如果文件名是 UUID 格式，优先从 sessions.json 反查 Gateway 原始 key
  if (isUUID(basename)) {
    // 触发模块级 sessions.json 加载（仅首次执行）
    ensureKeyMappingsLoaded(openclawDataDir);

    // O(1) 静态 Map 查找
    if (_keyMappings) {
      const gwKey = _keyMappings.get(basename);
      if (gwKey) {
        logger.debug(`通过 sessions.json 反查 Gateway key: ${basename} → ${gwKey}`);
        return gwKey;
      }
    }

    // Fallback: 构造标准 key
    const sessionKey = `agent:${agentId}:local:default:direct:${basename}`;
    logger.debug(`构造本地 SessionKey (fallback): ${sessionKey}`);
    return sessionKey;
  }

  // 其他情况,直接使用文件名作为 targetId
  const sessionKey = `agent:${agentId}:local:default:direct:${basename}`;
  logger.debug(`构造 SessionKey: ${sessionKey}`);
  return sessionKey;
}

/**
 * 从 SessionKey 提取 Agent ID
 * 
 * 直接取第 2 段（split(':')[1]），支持任意段数的 session key。
 * 
 * @param sessionKey - SessionKey 字符串
 * @returns Agent ID
 * 
 * @example
 * const agentId = extractAgentId('agent:dev:local:default:direct:012582c0');
 * // 返回: dev
 * const shortId = extractAgentId('agent:main:main');
 * // 返回: main
 */
export function extractAgentId(sessionKey: string): string {
  if (!sessionKey.startsWith('agent:')) {
    throw new Error(`无效的 SessionKey 格式: ${sessionKey}`);
  }

  const parts = sessionKey.split(':');
  if (parts.length < 2) {
    throw new Error(`SessionKey 格式错误，无法提取 agentId: ${sessionKey}`);
  }

  return parts[1];
}

/**
 * 解析 SessionKey 为组件对象
 * 
 * 支持可变长度格式：
 * - 4 段 (agent:main:main)：agentId=第2段，剩余第3段起合并为 targetId
 * - 5 段 (agent:dev1:subagent:uuid)：agentId=第2段
 * - 6 段标准格式：保持原有逻辑
 * - 通用原则：agentId 始终是第 2 段（split(':')[1]）
 * 
 * @param sessionKey - SessionKey 字符串
 * @returns SessionKey 组件对象
 * 
 * @example
 * const components = parseSessionKey('agent:dev:local:default:direct:012582c0');
 * // 返回: { agentId: 'dev', channel: 'local', accountId: 'default', type: 'direct', targetId: '012582c0' }
 * const short = parseSessionKey('agent:main:main');
 * // 返回: { agentId: 'main', channel: '', accountId: '', type: '', targetId: 'main' }
 */
export function parseSessionKey(sessionKey: string): SessionKeyComponents {
  if (!sessionKey.startsWith('agent:')) {
    throw new Error(`无效的 SessionKey 格式: ${sessionKey}`);
  }

  const parts = sessionKey.split(':');

  if (parts[0] !== 'agent') {
    throw new Error(`SessionKey 前缀错误: ${parts[0]}`);
  }

  const agentId = parts[1];

  if (parts.length === 6) {
    // 标准 6 段格式: agent:agentId:channel:accountId:type:targetId
    const [, , channel, accountId, type, targetId] = parts;
    return { agentId, channel, accountId, type, targetId };
  }

  if (parts.length === 4) {
    // 短格式 4 段: agent:agentId:rest... (如 agent:main:main)
    // 第 3 段起合并为 targetId，其余字段为空
    const targetId = parts.slice(2).join(':');
    return { agentId, channel: '', accountId: '', type: '', targetId };
  }

  if (parts.length === 5) {
    // 短格式 5 段: agent:agentId:subagent:uuid (如 agent:dev1:subagent:<uuid>)
    const targetId = parts.slice(2).join(':');
    return { agentId, channel: '', accountId: '', type: '', targetId };
  }

  // 其他段数：兼容处理，第 3 段起合并为 targetId
  const targetId = parts.slice(2).join(':');
  return { agentId, channel: '', accountId: '', type: '', targetId };
}

/**
 * 构造 SessionKey
 * 
 * @param components - SessionKey 组件对象
 * @returns SessionKey 字符串
 * 
 * @example
 * const key = buildSessionKey({
 *   agentId: 'dev',
 *   channel: 'local',
 *   accountId: 'default',
 *   type: 'direct',
 *   targetId: '012582c0'
 * });
 * // 返回: agent:dev:local:default:direct:012582c0
 */
export function buildSessionKey(components: SessionKeyComponents): string {
  const { agentId, channel, accountId, type, targetId } = components;
  
  if (!agentId || !channel || !accountId || !type || !targetId) {
    throw new Error('SessionKey 组件不能为空');
  }

  return `agent:${agentId}:${channel}:${accountId}:${type}:${targetId}`;
}

/**
 * 从 SessionKey 提取 Channel
 * 
 * @param sessionKey - SessionKey 字符串
 * @returns Channel
 */
export function extractChannel(sessionKey: string): string {
  const components = parseSessionKey(sessionKey);
  return components.channel;
}

/**
 * 从 SessionKey 提取 Account ID
 * 
 * @param sessionKey - SessionKey 字符串
 * @returns Account ID
 */
export function extractAccountId(sessionKey: string): string {
  const components = parseSessionKey(sessionKey);
  return components.accountId;
}

/**
 * 从 SessionKey 提取 Target ID
 * 
 * @param sessionKey - SessionKey 字符串
 * @returns Target ID
 */
export function extractTargetId(sessionKey: string): string {
  const components = parseSessionKey(sessionKey);
  return components.targetId;
}

/**
 * 验证 SessionKey 格式
 * 
 * @param sessionKey - SessionKey 字符串
 * @returns 是否有效
 */
export function isValidSessionKey(sessionKey: string): boolean {
  try {
    parseSessionKey(sessionKey);
    return true;
  } catch {
    return false;
  }
}

/**
 * 重新加载 session 映射（重置缓存并重新读取 sessions.json）
 *
 * 用于定时扫描时刷新映射，确保新创建的 session 能被反查。
 *
 * @param openclawDataDir - OpenClaw 数据根目录
 */
export function reloadSessionMappings(openclawDataDir: string): void {
  _mappingsLoaded = false;
  _keyMappings = undefined;
  ensureKeyMappingsLoaded(openclawDataDir);
}

/**
 * 判断字符串是否为 UUID 格式
 * 
 * @param str - 待判断的字符串
 * @returns 是否为 UUID
 */
function isUUID(str: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(str);
}
