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
import { Logger } from './logger';

const logger = new Logger('SessionKeyBuilder');

/**
 * SessionKey 格式
 * 
 * agent:{agentId}:{channel}:{accountId}:{type}:{targetId}
 * 
 * 示例:
 * - agent:dev:local:default:direct:012582c0-3fc5-4a35-818c-0dd9a1c359d4
 * - agent:prod:discord:acc-123:direct:peer-456
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
 * @returns SessionKey 字符串
 * 
 * @example
 * const key = buildSessionKeyFromPath(
 *   '/home/user/.openclaw/agents/dev/sessions/agent:dev:local:default:direct:012582c0.jsonl'
 * );
 * // 返回: agent:dev:local:default:direct:012582c0
 */
export function buildSessionKeyFromPath(filePath: string): string {
  logger.debug(`从路径构造 SessionKey: ${filePath}`);

  // 标准化路径
  const normalizedPath = filePath.replace(/\\/g, '/');
  
  // 提取文件名(不含扩展名)
  const basename = path.basename(normalizedPath, '.jsonl');
  
  // 检查文件名是否已经是 SessionKey 格式
  if (basename.startsWith('agent:')) {
    logger.debug(`文件名已是 SessionKey 格式: ${basename}`);
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
  
  // 如果文件名是 UUID 格式,构造本地 SessionKey
  if (isUUID(basename)) {
    const sessionKey = `agent:${agentId}:local:default:direct:${basename}`;
    logger.debug(`构造本地 SessionKey: ${sessionKey}`);
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
 * @param sessionKey - SessionKey 字符串
 * @returns Agent ID
 * 
 * @example
 * const agentId = extractAgentId('agent:dev:local:default:direct:012582c0');
 * // 返回: dev
 */
export function extractAgentId(sessionKey: string): string {
  const components = parseSessionKey(sessionKey);
  return components.agentId;
}

/**
 * 解析 SessionKey 为组件对象
 * 
 * @param sessionKey - SessionKey 字符串
 * @returns SessionKey 组件对象
 * 
 * @example
 * const components = parseSessionKey('agent:dev:local:default:direct:012582c0');
 * // 返回: { agentId: 'dev', channel: 'local', accountId: 'default', type: 'direct', targetId: '012582c0' }
 */
export function parseSessionKey(sessionKey: string): SessionKeyComponents {
  if (!sessionKey.startsWith('agent:')) {
    throw new Error(`无效的 SessionKey 格式: ${sessionKey}`);
  }

  const parts = sessionKey.split(':');
  
  if (parts.length !== 6) {
    throw new Error(`SessionKey 格式错误,期望 6 个部分,实际 ${parts.length}: ${sessionKey}`);
  }

  const [prefix, agentId, channel, accountId, type, targetId] = parts;

  if (prefix !== 'agent') {
    throw new Error(`SessionKey 前缀错误: ${prefix}`);
  }

  return {
    agentId,
    channel,
    accountId,
    type,
    targetId
  };
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
 * 判断字符串是否为 UUID 格式
 * 
 * @param str - 待判断的字符串
 * @returns 是否为 UUID
 */
function isUUID(str: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(str);
}
