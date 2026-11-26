import type { GatewayConfig, LarkBotConfig } from './config.ts'
import type { CursorClient } from './cursor/types.ts'
import type { LarkBotHandlers } from './lark/bot.ts'
import type { Messenger } from './lark/messenger.ts'
import type { Logger } from './logger.ts'
import type { BotRuntime } from './manager/task-manager.ts'
import { getMcpEndpointUrl, resolveBotPolicy, validateConfig } from './config.ts'
import { CursorSdkClient } from './cursor/client.ts'
import { createMcpRequestHandler } from './hitl/mcp-server.ts'
import { LarkBot } from './lark/bot.ts'
import { createLogger } from './logger.ts'
import { TaskManager } from './manager/task-manager.ts'

export interface GatewayBot {
  readonly id: string
  readonly name: string
  readonly config: LarkBotConfig
  readonly messenger: Messenger
  start: () => Promise<void>
  stop: () => void
}

export interface CreateGatewayOptions {
  logger?: Logger
  /** Start the built-in Bun HTTP server for `/healthz` and `/mcp`. Defaults to `true`. */
  startHttpServer?: boolean
  /** Run non-fatal `Cursor.me()` startup checks for each unique API key. Defaults to `true`. */
  checkCursorAuthOnStart?: boolean
  /** Optional custom factory for `CursorClient` instances (deduplicated per API key). */
  createCursorClient?: (apiKey: string, cfg: GatewayConfig) => CursorClient
  /** Optional custom factory for `LarkBot` instances. */
  createBot?: (botCfg: LarkBotConfig, handlers: LarkBotHandlers, logger: Logger) => GatewayBot
}

export interface GatewayHandle {
  readonly config: GatewayConfig
  readonly bots: readonly GatewayBot[]
  readonly manager: TaskManager
  readonly mcpHandler: (req: Request) => Promise<Response>
  /** Web-standard fetch handler serving `/healthz` and `/mcp` (can be mounted in an external HTTP server). */
  readonly handleRequest: (req: Request) => Promise<Response>
  /** Active Bun HTTP server when `startHttpServer` is enabled and the gateway is running. */
  readonly server: ReturnType<typeof Bun.serve> | null
  start: () => Promise<void>
  stop: () => Promise<void>
}

/**
 * Builds a self-contained, restartable gateway instance from an in-memory `GatewayConfig`.
 * Does not read files from disk, register process signal handlers, or call `process.exit()`.
 */
export function createGateway(
  cfg: GatewayConfig,
  options: CreateGatewayOptions = {},
): GatewayHandle {
  validateConfig(cfg)

  const logger = options.logger ?? createLogger()
  const startHttpServer = options.startHttpServer ?? true
  const checkCursorAuthOnStart = options.checkCursorAuthOnStart ?? true

  // Share one CursorClient per unique API key across bots.
  const cursorClients = new Map<string, CursorClient>()
  const getCursorClient = (apiKey: string): CursorClient => {
    let client = cursorClients.get(apiKey)
    if (!client) {
      client = options.createCursorClient
        ? options.createCursorClient(apiKey, cfg)
        : new CursorSdkClient({
            apiKey,
            baseUrl: cfg.cursor.baseUrl,
            requestTimeoutMs: cfg.cursor.requestTimeoutMs,
          })
      cursorClients.set(apiKey, client)
    }
    return client
  }

  let taskManager: TaskManager | undefined
  const bots: GatewayBot[] = []
  const runtimes: BotRuntime[] = []

  for (const botCfg of cfg.bots) {
    const policy = resolveBotPolicy(cfg, botCfg)
    const cursorClient = getCursorClient(policy.cursorApiKey)
    const handlers: LarkBotHandlers = {
      onMessage: async (ev) => {
        if (taskManager) await taskManager.handleMessage(ev)
      },
      onCardAction: async (ev) => {
        if (!taskManager) {
          return {
            toastType: 'warning',
            toastText: 'Gateway is initializing, please try again shortly.',
          }
        }
        return taskManager.handleCardAction(ev)
      },
    }
    const bot = options.createBot
      ? options.createBot(botCfg, handlers, logger)
      : new LarkBot(botCfg, handlers, logger)
    bots.push(bot)
    runtimes.push({
      config: botCfg,
      messenger: bot.messenger,
      cursor: cursorClient,
    })
  }

  const manager = new TaskManager(cfg, runtimes, logger)
  taskManager = manager

  const mcpHandler = createMcpRequestHandler({
    authToken: cfg.mcp.authToken,
    onAskUser: (req) => manager.handleAskUser(req),
  })

  const handleRequest = async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    if (url.pathname === '/healthz') {
      return Response.json({
        status: 'ok',
        stateless: true,
        bots: cfg.bots.map((b) => ({
          id: b.id,
          name: b.name,
          domain: b.domain,
          runtime: resolveBotPolicy(cfg, b).runtime,
        })),
        mcp_enabled: Boolean(getMcpEndpointUrl(cfg)),
      })
    }
    if (url.pathname === '/mcp') {
      return mcpHandler(req)
    }
    return new Response('Not Found', { status: 404 })
  }

  let server: ReturnType<typeof Bun.serve> | null = null
  let started = false
  let stopped = false

  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    for (const bot of bots) bot.stop()
    if (server) {
      await server.stop()
      server = null
    }
    await manager.stop()
  }

  const start = async (): Promise<void> => {
    if (stopped) throw new Error('Gateway has already been stopped; create a new gateway instance')
    if (started) return
    started = true

    try {
      if (checkCursorAuthOnStart) {
        for (const client of cursorClients.values()) {
          try {
            const me = await client.getMe()
            logger.info('Cursor SDK authenticated', {
              keyName: me.apiKeyName,
              email: me.userEmail,
            })
          } catch (err) {
            logger.warn('Cursor API key check warning', {
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
      }

      await manager.start()

      if (startHttpServer) {
        server = Bun.serve({
          hostname: cfg.server.hostname,
          port: cfg.server.port,
          fetch: handleRequest,
        })
        logger.info('HTTP server listening', {
          url: server.url.toString(),
          bots: cfg.bots.map((b) => b.id),
          mcpPublicUrl: getMcpEndpointUrl(cfg),
        })
      }

      await Promise.all(bots.map((bot) => bot.start()))
    } catch (err) {
      await stop()
      throw err
    }
  }

  return {
    config: cfg,
    bots,
    manager,
    mcpHandler,
    handleRequest,
    get server() {
      return server
    },
    start,
    stop,
  }
}
