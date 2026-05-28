/** 消息角色 */
export type MessageRole = 'user' | 'agent' | 'tool';

/** 数据来源 */
export type DataSource = 'websocket' | 'file' | 'http' | 'sqlite';

/** Agent 运行状态 */
export type AgentStatus = 'online' | 'offline' | 'busy';
