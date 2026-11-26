import process from 'node:process'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

export interface Logger {
  debug: (msg: string, fields?: Record<string, unknown>) => void
  info: (msg: string, fields?: Record<string, unknown>) => void
  warn: (msg: string, fields?: Record<string, unknown>) => void
  error: (msg: string, fields?: Record<string, unknown>) => void
}

export function createLogger(level: string = process.env.LOG_LEVEL ?? 'info'): Logger {
  const normalized = level.trim().toLowerCase()
  const minWeight =
    LEVEL_WEIGHT[(normalized as LogLevel) in LEVEL_WEIGHT ? (normalized as LogLevel) : 'info']

  const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_WEIGHT[lvl] < minWeight) return
    const ts = new Date().toISOString()
    const extra = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : ''
    const line = `${ts} [${lvl.toUpperCase()}] ${msg}${extra}\n`
    if (lvl === 'error' || lvl === 'warn') {
      process.stderr.write(line)
    } else {
      process.stdout.write(line)
    }
  }

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
  }
}

export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}
