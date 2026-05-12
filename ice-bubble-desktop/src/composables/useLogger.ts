import { reactive, readonly } from 'vue'

export interface LogEntry {
  id: number
  timestamp: string
  type: 'log' | 'warn' | 'error' | 'network'
  message: string
  detail?: string
}

const MAX_LOGS = 2000
let nextId = 0

const logs: LogEntry[] = reactive([])
let initialized = false

const origConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
}

function addLog(type: LogEntry['type'], message: string, detail?: string) {
  const entry: LogEntry = {
    id: nextId++,
    timestamp: new Date().toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) + '.' + String(new Date().getMilliseconds()).padStart(3, '0'),
    type,
    message,
    detail,
  }
  logs.push(entry)
  if (logs.length > MAX_LOGS) {
    logs.splice(0, logs.length - MAX_LOGS)
  }
}

function serializeArg(arg: unknown): string {
  if (arg === undefined) return 'undefined'
  if (arg === null) return 'null'
  if (typeof arg === 'string') return arg
  if (typeof arg === 'number' || typeof arg === 'boolean') return String(arg)
  if (arg instanceof Error) return `${arg.message}\n${arg.stack || ''}`
  try {
    return JSON.stringify(arg, null, 2)
  } catch {
    return String(arg)
  }
}

function interceptConsole() {
  console.log = (...args: unknown[]) => {
    origConsole.log(...args)
    addLog('log', args.map(serializeArg).join(' '))
  }
  console.warn = (...args: unknown[]) => {
    origConsole.warn(...args)
    addLog('warn', args.map(serializeArg).join(' '))
  }
  console.error = (...args: unknown[]) => {
    origConsole.error(...args)
    const msg = args.map(serializeArg).join('\n')
    addLog('error', msg)
  }
}

function interceptFetch() {
  const origFetch = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = init?.method || 'GET'
    const start = performance.now()
    try {
      const resp = await origFetch(input, init)
      const elapsed = Math.round(performance.now() - start)
      addLog('network', `${method} ${resp.status} ${url}`, `${elapsed}ms`)
      return resp
    } catch (e) {
      const elapsed = Math.round(performance.now() - start)
      const errMsg = e instanceof Error ? e.message : String(e)
      addLog('network', `${method} ERR ${url}`, `${elapsed}ms - ${errMsg}`)
      throw e
    }
  }
}

export function useLogger() {
  if (!initialized) {
    initialized = true
    interceptConsole()
    interceptFetch()
    addLog('log', '📋 Logger 初始化完成')
  }

  const clearLogs = () => {
    logs.splice(0, logs.length)
  }

  const exportLogs = () => {
    const text = logs.map(l => `[${l.timestamp}] [${l.type.toUpperCase()}] ${l.message}${l.detail ? ' | ' + l.detail : ''}`).join('\n')
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `ice-bubble-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`
    a.click()
    URL.revokeObjectURL(url)
  }

  return {
    logs: readonly(logs),
    clearLogs,
    exportLogs,
  }
}
