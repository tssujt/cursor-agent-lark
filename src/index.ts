import process from 'node:process'
import { loadConfig } from './config.ts'
import { createGateway } from './gateway.ts'
import { createLogger } from './logger.ts'

async function main(): Promise<void> {
  const logger = createLogger(process.env.LOG_LEVEL ?? 'info')

  const configArgIdx = process.argv.indexOf('--config')
  const configPath = configArgIdx >= 0 ? process.argv[configArgIdx + 1] : undefined
  const cfg = loadConfig(configPath)
  const gateway = createGateway(cfg, { logger })

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info('Shutting down gateway', { signal })
    await gateway.stop()
    logger.info('Gateway shutdown complete')
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  await gateway.start()
}

main().catch((err) => {
  const logger = createLogger('error')
  logger.error('Fatal gateway error', {
    error: err instanceof Error ? err.message : String(err),
  })
  process.exit(1)
})
