import { describe, expect, it } from 'bun:test'
import type { CursorClient, GatewayBot, Messenger } from '../src/lib.ts'
import {
  createGateway,
  noopLogger,
  parseConfigFromObject,
  parseConfigFromToml,
} from '../src/lib.ts'

function createFakeCursorClient(): CursorClient {
  return {
    getMe: async () => ({ apiKeyName: 'test-key', userEmail: 'dev@example.com' }),
    listModels: async () => [],
    getAgent: async () => null,
    listAgents: async () => [],
    createAgentAndRun: async () => {
      throw new Error('not implemented')
    },
    sendFollowUp: async () => {
      throw new Error('not implemented')
    },
    steerRun: async () => ({ delivery: 'unavailable' }),
    getRun: async () => {
      throw new Error('not implemented')
    },
    getLatestRun: async () => null,
    waitForRun: async () => {
      throw new Error('not implemented')
    },
    cancelRun: async () => {},
  }
}

function createFakeMessenger(): Messenger {
  return {
    sendCard: async () => 'om_card',
    replyCard: async () => ({ messageId: 'om_rcard', threadId: '' }),
    updateCard: async () => {},
    replyText: async () => ({ messageId: 'om_rtxt', threadId: '' }),
    sendText: async () => 'om_txt',
  }
}

describe('createGateway library API', () => {
  it('runs from an in-memory object without starting an HTTP server and handles /healthz + /mcp', async () => {
    const startedBots: string[] = []
    const stoppedBots: string[] = []

    const cfg = parseConfigFromObject({
      cursor: { api_key: 'key_test' },
      mcp: {
        public_url: 'https://gw.example.com',
        auth_token: 'secret-token',
      },
      bots: [
        {
          id: 'bot-a',
          name: 'Bot A',
          app_id: 'cli_a',
          app_secret: 'sec_a',
          require_mention: false,
        },
      ],
    })

    const gw = createGateway(cfg, {
      logger: noopLogger,
      startHttpServer: false,
      createCursorClient: () => createFakeCursorClient(),
      createBot: (botCfg): GatewayBot => ({
        id: botCfg.id,
        name: botCfg.name,
        config: botCfg,
        messenger: createFakeMessenger(),
        start: async () => {
          startedBots.push(botCfg.id)
        },
        stop: () => {
          stoppedBots.push(botCfg.id)
        },
      }),
    })

    await gw.start()
    expect(gw.server).toBeNull()
    expect(startedBots).toEqual(['bot-a'])

    const healthRes = await gw.handleRequest(new Request('http://local/healthz'))
    expect(healthRes.status).toBe(200)
    const health = (await healthRes.json()) as {
      status: string
      mcp_enabled: boolean
      bots: Array<{ id: string }>
    }
    expect(health.status).toBe('ok')
    expect(health.mcp_enabled).toBe(true)
    expect(health.bots.map((b) => b.id)).toEqual(['bot-a'])

    const unauthMcp = await gw.handleRequest(new Request('http://local/mcp', { method: 'POST' }))
    expect(unauthMcp.status).toBe(401)

    await gw.stop()
    expect(stoppedBots).toEqual(['bot-a'])
  })

  it('supports starting a real Bun HTTP server and cleanly reloading with new TOML config', async () => {
    const lifecycle: string[] = []

    const buildGw = (tomlText: string) =>
      createGateway(parseConfigFromToml(tomlText, { env: {} }), {
        logger: noopLogger,
        checkCursorAuthOnStart: false,
        createCursorClient: () => createFakeCursorClient(),
        createBot: (botCfg): GatewayBot => ({
          id: botCfg.id,
          name: botCfg.name,
          config: botCfg,
          messenger: createFakeMessenger(),
          start: async () => {
            lifecycle.push(`start:${botCfg.id}`)
          },
          stop: () => {
            lifecycle.push(`stop:${botCfg.id}`)
          },
        }),
      })

    const gw1 = buildGw(`
[server]
hostname = '127.0.0.1'
port = 0

[cursor]
api_key = 'key_v1'

[[bots]]
id = 'v1-bot'
app_id = 'cli_v1'
app_secret = 'sec_v1'
`)
    await gw1.start()
    try {
      expect(gw1.server).not.toBeNull()
      const res1 = await fetch(new URL('/healthz', gw1.server!.url))
      const body1 = (await res1.json()) as { bots: Array<{ id: string }> }
      expect(body1.bots.map((b) => b.id)).toEqual(['v1-bot'])
    } finally {
      await gw1.stop()
    }

    const gw2 = buildGw(`
[server]
hostname = '127.0.0.1'
port = 0

[cursor]
api_key = 'key_v2'

[[bots]]
id = 'v2-bot'
app_id = 'cli_v2'
app_secret = 'sec_v2'
`)
    await gw2.start()
    try {
      expect(gw2.server).not.toBeNull()
      const res2 = await fetch(new URL('/healthz', gw2.server!.url))
      const body2 = (await res2.json()) as { bots: Array<{ id: string }> }
      expect(body2.bots.map((b) => b.id)).toEqual(['v2-bot'])
    } finally {
      await gw2.stop()
    }

    expect(lifecycle).toEqual(['start:v1-bot', 'stop:v1-bot', 'start:v2-bot', 'stop:v2-bot'])
  })
})
