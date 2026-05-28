// 日志级别定义，与 Pino 对齐

export const LogLevel = {
  TRACE: 'trace',
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
  FATAL: 'fatal',
} as const;

export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

/** Pino 数字级别映射 */
const levelMap: Record<string, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

export function parseLevel(level: string): number {
  const normalized = level.toLowerCase();
  if (normalized in levelMap) return levelMap[normalized];
  return levelMap.info;
}

export function levelToString(level: string | number): string {
  if (typeof level === 'string') return level;
  const entry = Object.entries(levelMap).find(([, v]) => v === level);
  return entry ? entry[0] : 'info';
}
