import { describe, expect, it } from 'bun:test'
import type { LarkBotConfig } from '../src/config.ts'
import type {
  AgentRuntime,
  AgentSummary,
  CreateAgentInput,
  CreatedAgentRun,
  CursorClient,
  CursorKeyIdentity,
  CursorModelSummary,
  NormalizedRunStatus,
  RunSnapshot,
  RuntimeLookupOptions,
  SendFollowUpInput,
  SteerResult,
} from '../src/cursor/types.ts'
import type { CardJSON } from '../src/lark/cards.ts'
import type { Messenger, ReplyResult } from '../src/lark/messenger.ts'
import { createDefaultConfig } from '../src/config.ts'
import { CursorAgentConflictError, isTerminalRunStatus } from '../src/cursor/types.ts'
import { TaskManager } from '../src/manager/task-manager.ts'
import { decodeMcpContext, deriveAgentId } from '../src/store/store.ts'

class FakeMessenger implements Messenger {
  private seq = 0
  readonly sentCards: CardJSON[] = []
  readonly repliedCards: CardJSON[] = []
  readonly replyCardCalls: Array<{
    replyToMsgId: string
    replyInThread: boolean
    messageId: string
  }> = []
  readonly replyTextCalls: Array<{ replyToMsgId: string; text: string; replyInThread: boolean }> =
    []
  readonly updatedCards = new Map<string, CardJSON>()
  readonly texts: string[] = []

  private nextId(prefix: string): string {
    return `${prefix}_${++this.seq}`
  }

  async sendCard(_chatId: string, card: CardJSON): Promise<string> {
    this.sentCards.push(card)
    return this.nextId('om_card')
  }

  async replyCard(
    replyToMsgId: string,
    card: CardJSON,
    replyInThread = false,
  ): Promise<ReplyResult> {
    const messageId = this.nextId('om_rcard')
    this.repliedCards.push(card)
    this.replyCardCalls.push({ replyToMsgId, replyInThread, messageId })
    return {
      messageId,
      threadId: replyInThread ? `omt_${replyToMsgId}` : '',
    }
  }

  async updateCard(messageId: string, card: CardJSON): Promise<void> {
    this.updatedCards.set(messageId, card)
  }

  async replyText(replyToMsgId: string, text: string, replyInThread = false): Promise<ReplyResult> {
    this.texts.push(text)
    this.replyTextCalls.push({ replyToMsgId, text, replyInThread })
    return {
      messageId: this.nextId('om_txt'),
      threadId: replyInThread ? `omt_${replyToMsgId}` : '',
    }
  }

  async sendText(_chatId: string, text: string): Promise<string> {
    this.texts.push(text)
    return this.nextId('om_txt')
  }
}

class FakeCursorClient implements CursorClient {
  private runSeq = 0
  readonly createReqs: CreateAgentInput[] = []
  readonly followUpReqs: SendFollowUpInput[] = []
  readonly steerReqs: Array<{ agentId: string; prompt: string; runtime?: AgentRuntime }> = []
  readonly cancelledRuns: string[] = []
  readonly agents = new Map<string, AgentSummary>()
  readonly runs = new Map<string, RunSnapshot>()
  readonly latestRunByAgent = new Map<string, string>()

  async getMe(): Promise<CursorKeyIdentity> {
    return { apiKeyName: 'test-key' }
  }

  async listModels(): Promise<CursorModelSummary[]> {
    return [{ id: 'composer-2', displayName: 'Composer 2' }]
  }

  async getAgent(agentId: string, options?: RuntimeLookupOptions): Promise<AgentSummary | null> {
    const found = this.agents.get(agentId)
    if (!found) return null
    if (options?.runtime && found.runtime !== options.runtime) return null
    return {
      ...found,
      metadata: { ...found.metadata },
      repos: [...found.repos],
    }
  }

  async listAgents(limit = 50, options?: RuntimeLookupOptions): Promise<AgentSummary[]> {
    return Array.from(this.agents.values())
      .filter((a) => !options?.runtime || a.runtime === options.runtime)
      .reverse()
      .slice(0, limit)
      .map((a) => ({
        ...a,
        metadata: { ...a.metadata },
        repos: [...a.repos],
      }))
  }

  async createAgentAndRun(input: CreateAgentInput): Promise<CreatedAgentRun> {
    const runtime: AgentRuntime = input.runtime ?? 'cloud'
    const agentId =
      input.agentId || (runtime === 'local' ? `local-${this.runSeq + 1}` : `bc-${this.runSeq + 1}`)
    if (this.agents.has(agentId))
      throw new CursorAgentConflictError(`Agent ${agentId} already exists`)

    this.createReqs.push(input)
    const runId = `run-${++this.runSeq}`
    const snap: RunSnapshot = {
      id: runId,
      agentId,
      status: 'running',
      branches: [],
    }
    this.runs.set(runId, snap)
    this.latestRunByAgent.set(agentId, runId)
    const agentUrl = runtime === 'cloud' ? `https://cursor.com/agents/${agentId}` : ''
    this.agents.set(agentId, {
      agentId,
      runtime,
      agentUrl,
      name: input.name || agentId,
      summary: '',
      status: 'running',
      repos: input.repoUrl ? [input.repoUrl] : [],
      cwd: input.cwd,
      metadata: { ...(input.metadata ?? {}) },
      createdAt: Date.now(),
      lastModified: Date.now(),
    })

    return {
      agentId,
      runtime,
      agentUrl,
      name: input.name || agentId,
      run: { ...snap },
    }
  }

  async sendFollowUp(input: SendFollowUpInput): Promise<RunSnapshot> {
    this.followUpReqs.push(input)
    const runId = `run-${++this.runSeq}`
    const snap: RunSnapshot = {
      id: runId,
      agentId: input.agentId,
      status: 'running',
      branches: [],
    }
    this.runs.set(runId, snap)
    this.latestRunByAgent.set(input.agentId, runId)
    const agent = this.agents.get(input.agentId)
    if (agent) {
      agent.status = 'running'
      agent.lastModified = Date.now()
    }
    return { ...snap }
  }

  async steerRun(
    agentId: string,
    prompt: string,
    options?: RuntimeLookupOptions,
  ): Promise<SteerResult> {
    this.steerReqs.push({ agentId, prompt, runtime: options?.runtime })
    return {
      delivery: 'steered',
      runId: this.latestRunByAgent.get(agentId),
    }
  }

  async getRun(_agentId: string, runId: string): Promise<RunSnapshot> {
    const snap = this.runs.get(runId)
    if (!snap) throw new Error(`run ${runId} not found`)
    return { ...snap }
  }

  async getLatestRun(agentId: string): Promise<RunSnapshot | null> {
    const runId = this.latestRunByAgent.get(agentId)
    return runId ? this.getRun(agentId, runId) : null
  }

  async waitForRun(
    agentId: string,
    runId: string,
    options: {
      signal: AbortSignal
      pollIntervalMs: number
      onStatus?: (status: NormalizedRunStatus) => void
    },
  ): Promise<RunSnapshot> {
    while (!options.signal.aborted) {
      const snap = await this.getRun(agentId, runId)
      if (isTerminalRunStatus(snap.status)) return snap
      await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs))
    }
    throw new DOMException('Aborted', 'AbortError')
  }

  async cancelRun(agentId: string, runId: string): Promise<void> {
    this.cancelledRuns.push(runId)
    const snap = this.runs.get(runId)
    if (snap) snap.status = 'cancelled'
    const agent = this.agents.get(agentId)
    if (agent) agent.status = 'finished'
  }

  seedRunningAgent(agent: AgentSummary, runId = `run-${++this.runSeq}`): string {
    this.agents.set(agent.agentId, { ...agent, status: 'running' })
    this.runs.set(runId, {
      id: runId,
      agentId: agent.agentId,
      status: 'running',
      branches: [],
    })
    this.latestRunByAgent.set(agent.agentId, runId)
    return runId
  }

  finishRun(runId: string, result: string, prUrl = ''): void {
    const snap = this.runs.get(runId)
    if (!snap) throw new Error(`run ${runId} not found`)
    snap.status = 'finished'
    snap.result = result
    snap.durationMs = 5000
    if (prUrl) {
      snap.branches = [
        {
          repoUrl: 'github.com/acme/backend',
          branch: 'cursor/cache-opt',
          prUrl,
        },
      ]
    }
    const agent = this.agents.get(snap.agentId)
    if (agent) {
      agent.status = 'finished'
      agent.summary = result
      agent.lastModified = Date.now()
    }
  }
}

function findCallbackValues(card: CardJSON): Array<Record<string, unknown>> {
  const results: Array<Record<string, unknown>> = []
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    const rec = node as Record<string, unknown>
    if (rec.type === 'callback' && rec.value && typeof rec.value === 'object')
      results.push(rec.value as Record<string, unknown>)
    for (const val of Object.values(rec)) visit(val)
  }
  visit(card)
  return results
}

async function waitUntil(cond: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
  throw new Error('Timed out waiting for condition')
}

function createMultiBotEnv() {
  const cfg = createDefaultConfig()
  cfg.cursor.apiKey = 'key_test'
  cfg.cursor.pollIntervalMs = 15
  cfg.cursor.useSSE = false
  cfg.repos.aliases = {
    backend: {
      url: 'https://github.com/acme/backend',
      defaultBranch: 'main',
      allowedUsers: [],
    },
    'web-app': {
      url: 'https://github.com/acme/web-app',
      defaultBranch: 'main',
      allowedUsers: [],
    },
  }

  const backendBotCfg: LarkBotConfig = {
    id: 'backend-bot',
    name: 'Backend Bot',
    appId: 'cli_backend',
    appSecret: 'sec_backend',
    domain: 'feishu',
    verificationToken: '',
    encryptKey: '',
    logLevel: 'info',
    defaultRepo: 'backend',
  }
  const frontendBotCfg: LarkBotConfig = {
    id: 'frontend-bot',
    name: 'Frontend Bot',
    appId: 'cli_frontend',
    appSecret: 'sec_frontend',
    domain: 'lark',
    verificationToken: '',
    encryptKey: '',
    logLevel: 'info',
    defaultRepo: 'web-app',
  }
  cfg.bots = [backendBotCfg, frontendBotCfg]

  const backendCursor = new FakeCursorClient()
  const frontendCursor = new FakeCursorClient()
  const backendMessenger = new FakeMessenger()
  const frontendMessenger = new FakeMessenger()

  const runtimes = [
    { config: backendBotCfg, messenger: backendMessenger, cursor: backendCursor },
    { config: frontendBotCfg, messenger: frontendMessenger, cursor: frontendCursor },
  ]
  const manager = new TaskManager(cfg, runtimes)
  const createRestartedManager = (): TaskManager => new TaskManager(cfg, runtimes)

  return {
    cfg,
    backendCursor,
    frontendCursor,
    backendMessenger,
    frontendMessenger,
    manager,
    createRestartedManager,
  }
}

describe('TaskManager end-to-end (stateless multi-bot Lark)', () => {
  it('completes Prompt-JSON HITL -> stateless card answer across restart -> follow-up -> PR card', async () => {
    const { backendCursor, backendMessenger, manager, createRestartedManager } = createMultiBotEnv()
    const restartedManager = createRestartedManager()
    try {
      const createMsg = {
        botId: 'backend-bot',
        eventId: 'evt-create-1',
        messageId: 'om_u1',
        rootId: '',
        parentId: '',
        threadId: '',
        chatId: 'oc_chat1',
        chatType: 'group',
        senderId: 'ou_alice',
        text: '@_user_1\nrepo: backend\nbranch: main\ntask: Add query caching and open a PR',
        mentioned: true,
      }
      await manager.handleMessage(createMsg)
      // Duplicate event delivery is deduped in-memory
      await manager.handleMessage(createMsg)
      // Duplicate delivery on a restarted instance is also idempotent via deterministic agentId (409 conflict)
      await restartedManager.handleMessage({ ...createMsg, eventId: 'evt-create-redelivery' })
      expect(backendCursor.createReqs).toHaveLength(1)

      const expectedAgentId = deriveAgentId('backend-bot', 'om_u1')
      expect(backendCursor.createReqs[0]?.agentId).toBe(expectedAgentId)

      backendCursor.finishRun(
        'run-1',
        'Please confirm TTL:\n```json\n{"type":"question","question":"What cache TTL should be used?","options":[{"label":"5 minutes","value":"300"},{"label":"10 minutes","value":"600"}]}\n```',
      )

      await waitUntil(() => backendMessenger.repliedCards.length === 2)
      const qCard = backendMessenger.repliedCards[1]!
      const qMsgId = backendMessenger.replyCardCalls[1]!.messageId
      const callbacks = findCallbackValues(qCard)
      const optionCallbacks = callbacks.filter((v) => v.action === 'answer_question')
      const customCallback = callbacks.find((v) => v.action === 'answer_question_custom')!
      expect(optionCallbacks).toHaveLength(2)
      expect(customCallback.agent_id).toBe(expectedAgentId)
      const option600 = optionCallbacks.find((v) => v.answer === '600')!
      expect(option600.agent_id).toBe(expectedAgentId)
      expect(option600.owner_id).toBe('ou_alice')

      // Handle card action on the fresh restartedManager (proving zero DB is required!)
      const unauth = await restartedManager.handleCardAction({
        botId: 'backend-bot',
        operatorOpenId: 'ou_bob',
        chatId: 'oc_chat1',
        messageId: qMsgId,
        actionValue: option600,
        formValue: {},
      })
      expect(unauth.toastType).toBe('warning')

      // Creator submits a custom answer via the last-item input form
      const ok = await restartedManager.handleCardAction({
        botId: 'backend-bot',
        operatorOpenId: 'ou_alice',
        chatId: 'oc_chat1',
        messageId: qMsgId,
        actionValue: customCallback,
        formValue: { custom_answer: '900s with sliding window' },
      })
      expect(ok.toastType).toBe('success')
      expect(ok.card).toBeDefined()

      // Duplicate click rejected
      const dup = await restartedManager.handleCardAction({
        botId: 'backend-bot',
        operatorOpenId: 'ou_alice',
        chatId: 'oc_chat1',
        messageId: qMsgId,
        actionValue: option600,
        formValue: {},
      })
      expect(dup.toastType).toBe('warning')

      await waitUntil(() => backendCursor.followUpReqs.length === 1)
      expect(backendCursor.followUpReqs[0]?.prompt).toContain('900s with sliding window')

      backendCursor.finishRun(
        'run-2',
        'Added query caching and opened a PR.',
        'https://github.com/acme/backend/pull/99',
      )

      // Restarted manager has no cached cardMsgId, so it posts a fresh final status card in the thread
      await waitUntil(() => backendMessenger.repliedCards.length === 3)
      const finalCardJson = JSON.stringify(backendMessenger.repliedCards[2])
      expect(finalCardJson).toContain('https://github.com/acme/backend/pull/99')
      expect(backendMessenger.replyCardCalls[2]?.replyToMsgId).toBe('om_u1')
      expect(backendMessenger.replyCardCalls[2]?.replyInThread).toBe(true)
    } finally {
      await manager.stop()
      await restartedManager.stop()
    }
  })

  it('isolates multiple bots, injects signed MCP ctx + multiple MCP servers, and routes ask_user', async () => {
    const { cfg, backendCursor, frontendCursor, backendMessenger, frontendMessenger, manager } =
      createMultiBotEnv()
    cfg.mcp.publicUrl = 'https://gw.example.com'
    cfg.mcp.authToken = 'tok-123'
    cfg.mcp.servers = {
      linear: { type: 'http', url: 'https://mcp.linear.app/sse' },
      github: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
      },
    }
    cfg.cursor.enableSteer = false
    cfg.bots[0]!.presetPrompt = 'Backend-only instructions.'
    cfg.bots[1]!.presetPrompt = 'Frontend-only instructions.'
    try {
      await manager.handleMessage({
        botId: 'frontend-bot',
        eventId: 'evt-fe-1',
        messageId: 'om_fe1',
        rootId: '',
        parentId: '',
        threadId: '',
        chatId: 'oc_shared_group',
        chatType: 'group',
        senderId: 'ou_alice',
        text: '@_user_1 Add dark mode toggle',
        mentioned: true,
      })

      expect(frontendCursor.createReqs).toHaveLength(1)
      expect(backendCursor.createReqs).toHaveLength(0)
      expect(frontendCursor.createReqs[0]?.repoUrl).toBe('https://github.com/acme/web-app')
      expect(frontendCursor.createReqs[0]?.metadata?.lark_bot_id).toBe('frontend-bot')
      expect(frontendCursor.createReqs[0]?.prompt).toStartWith(
        '[Bot Instructions]\nFrontend-only instructions.\n\n[User Message]\nAdd dark mode toggle',
      )
      expect(frontendCursor.createReqs[0]?.prompt).not.toContain('Backend-only instructions.')

      const injectedMcps = frontendCursor.createReqs[0]?.mcpServers ?? []
      expect(injectedMcps.map((m) => m.name)).toEqual(['linear', 'github', 'lark-hitl'])
      const hitlMcp = injectedMcps.find((m) => m.name === 'lark-hitl')
      expect(hitlMcp?.type).toBe('http')
      const ctxToken =
        hitlMcp?.type === 'http' ? (new URL(hitlMcp.url).searchParams.get('ctx') ?? '') : ''
      const decodedCtx = decodeMcpContext(ctxToken, 'tok-123')
      expect(decodedCtx).toEqual({
        botId: 'frontend-bot',
        chatId: 'oc_shared_group',
        chatType: 'group',
        rootMsgId: 'om_fe1',
        userId: 'ou_alice',
        agentId: deriveAgentId('frontend-bot', 'om_fe1'),
      })

      expect(frontendMessenger.repliedCards).toHaveLength(1)
      expect(backendMessenger.repliedCards).toHaveLength(0)

      // Stateless MCP ask_user passes decoded context -> routes to frontendMessenger
      await manager.handleAskUser({
        context: decodedCtx!,
        agentId: decodedCtx!.agentId,
        question: 'Should dark mode follow system preference by default?',
        options: [
          { label: 'Yes', value: 'system' },
          { label: 'No, default light', value: 'light' },
        ],
      })
      expect(frontendMessenger.repliedCards).toHaveLength(2)
      expect(backendMessenger.repliedCards).toHaveLength(0)

      const qMsgId = frontendMessenger.replyCardCalls[1]!.messageId
      await manager.handleMessage({
        botId: 'frontend-bot',
        eventId: 'evt-reply-q',
        messageId: 'om_reply_q',
        rootId: 'om_fe1',
        parentId: qMsgId,
        threadId: 'omt_om_fe1',
        chatId: 'oc_shared_group',
        chatType: 'group',
        senderId: 'ou_alice',
        text: 'Follow system preference',
        mentioned: false,
      })

      // Steer is disabled so answer is queued until run-1 finishes
      await waitUntil(() => frontendMessenger.texts.some((t) => t.includes('Resuming Agent')))

      frontendCursor.finishRun('run-1', 'Waiting for user confirmation.')
      await waitUntil(() => frontendCursor.followUpReqs.length === 1)
      expect(frontendCursor.followUpReqs[0]?.prompt).toContain('Follow system preference')
      expect(frontendCursor.followUpReqs[0]?.prompt).not.toContain('[Bot Instructions]')
      expect(frontendCursor.followUpReqs[0]?.prompt).not.toContain('Frontend-only instructions.')
      expect(frontendCursor.followUpReqs[0]?.prompt).not.toContain('Backend-only instructions.')
      expect(frontendCursor.followUpReqs[0]?.mcpServers).toHaveLength(3)
    } finally {
      await manager.stop()
    }
  })

  it('binds a group thread to one Agent session across restarts via deterministic agentId', async () => {
    const { backendCursor, backendMessenger, manager, createRestartedManager } = createMultiBotEnv()
    const restartedManager = createRestartedManager()
    try {
      await manager.handleMessage({
        botId: 'backend-bot',
        eventId: 'evt-c1',
        messageId: 'om_c1',
        rootId: '',
        parentId: '',
        threadId: '',
        chatId: 'oc_chat3',
        chatType: 'group',
        senderId: 'ou_alice',
        text: '@_user_1 repo: backend\ntask: Optimize query',
        mentioned: true,
      })
      const agentId = deriveAgentId('backend-bot', 'om_c1')
      expect(backendMessenger.replyCardCalls[0]?.replyInThread).toBe(true)

      // Plain message inside the thread on a fresh restartedManager continues the exact same Agent
      await restartedManager.handleMessage({
        botId: 'backend-bot',
        eventId: 'evt-c2',
        messageId: 'om_c2',
        rootId: 'om_c1',
        parentId: '',
        threadId: 'omt_om_c1',
        chatId: 'oc_chat3',
        chatType: 'group',
        senderId: 'ou_alice',
        text: 'Also add slow query logging',
        mentioned: false,
      })
      expect(backendCursor.createReqs).toHaveLength(1)
      expect(backendCursor.steerReqs).toHaveLength(1)
      expect(backendCursor.steerReqs[0]).toEqual({
        agentId,
        prompt: 'Also add slow query logging',
        runtime: 'cloud',
      })
      expect(backendMessenger.replyTextCalls[0]?.replyInThread).toBe(true)

      // Plain text starting with a command word (without leading '/') still continues the thread Agent
      await restartedManager.handleMessage({
        botId: 'backend-bot',
        eventId: 'evt-c2b',
        messageId: 'om_c2b',
        rootId: 'om_c1',
        parentId: '',
        threadId: 'omt_om_c1',
        chatId: 'oc_chat3',
        chatType: 'group',
        senderId: 'ou_alice',
        text: 'list slow queries and add indexes',
        mentioned: false,
      })
      expect(backendCursor.steerReqs).toHaveLength(2)
      expect(backendCursor.steerReqs[1]).toEqual({
        agentId,
        prompt: 'list slow queries and add indexes',
        runtime: 'cloud',
      })

      // Slash commands inside a thread work without @mention and without specifying agentId
      const cardsBeforeStatus = backendMessenger.repliedCards.length
      await restartedManager.handleMessage({
        botId: 'backend-bot',
        eventId: 'evt-thread-status',
        messageId: 'om_status',
        rootId: 'om_c1',
        parentId: '',
        threadId: 'omt_om_c1',
        chatId: 'oc_chat3',
        chatType: 'group',
        senderId: 'ou_alice',
        text: '/status',
        mentioned: false,
      })
      expect(backendMessenger.repliedCards).toHaveLength(cardsBeforeStatus + 1)
      expect(JSON.stringify(backendMessenger.repliedCards.at(-1))).toContain(agentId)

      // /list queries Cursor Cloud directly
      await restartedManager.handleMessage({
        botId: 'backend-bot',
        eventId: 'evt-list',
        messageId: 'om_list',
        rootId: '',
        parentId: '',
        threadId: '',
        chatId: 'oc_chat3',
        chatType: 'group',
        senderId: 'ou_alice',
        text: '@_user_1 /list',
        mentioned: true,
      })
      expect(JSON.stringify(backendMessenger.repliedCards.at(-1))).toContain(agentId)

      // Cancel via stateless card callback
      const cancelRes = await restartedManager.handleCardAction({
        botId: 'backend-bot',
        operatorOpenId: 'ou_alice',
        chatId: 'oc_chat3',
        messageId: backendMessenger.replyCardCalls[0]!.messageId,
        actionValue: {
          action: 'cancel_task',
          agent_id: agentId,
          owner_id: 'ou_alice',
          root_msg_id: 'om_c1',
          chat_type: 'group',
        },
        formValue: {},
      })
      expect(cancelRes.toastType).toBe('success')
      expect(backendCursor.cancelledRuns).toContain('run-1')
    } finally {
      await manager.stop()
      await restartedManager.stop()
    }
  })

  it('recovers running cloud agents on startup without a local database', async () => {
    const { backendCursor, backendMessenger, manager } = createMultiBotEnv()
    try {
      const agentId = deriveAgentId('backend-bot', 'om_rec_root')
      const runId = backendCursor.seedRunningAgent({
        agentId,
        runtime: 'cloud',
        agentUrl: `https://cursor.com/agents/${agentId}`,
        name: 'Recovered task',
        summary: '',
        status: 'running',
        repos: ['https://github.com/acme/backend'],
        metadata: {
          lark_bot_id: 'backend-bot',
          lark_chat_id: 'oc_rec',
          lark_chat_type: 'group',
          lark_root_msg_id: 'om_rec_root',
          lark_user_id: 'ou_alice',
        },
        lastModified: Date.now(),
      })

      await manager.start()
      backendCursor.finishRun(
        runId,
        'Finished after restart.',
        'https://github.com/acme/backend/pull/101',
      )

      await waitUntil(() => backendMessenger.repliedCards.length === 1)
      expect(backendMessenger.replyCardCalls[0]?.replyToMsgId).toBe('om_rec_root')
      expect(backendMessenger.replyCardCalls[0]?.replyInThread).toBe(true)
      expect(JSON.stringify(backendMessenger.repliedCards[0])).toContain(
        'https://github.com/acme/backend/pull/101',
      )
    } finally {
      await manager.stop()
    }
  })

  it('disables replyInThread in p2p direct chats', async () => {
    const { backendMessenger, manager } = createMultiBotEnv()
    try {
      await manager.handleMessage({
        botId: 'backend-bot',
        eventId: 'evt-p2p-1',
        messageId: 'om_p2p_1',
        rootId: '',
        parentId: '',
        threadId: '',
        chatId: 'oc_p2p',
        chatType: 'p2p',
        senderId: 'ou_alice',
        text: 'Add unit tests',
        mentioned: false,
      })
      expect(backendMessenger.replyCardCalls[0]?.replyInThread).toBe(false)
    } finally {
      await manager.stop()
    }
  })

  it('auto-creates threads for top-level group messages only on bots with requireMention=false', async () => {
    const { cfg, backendCursor, frontendCursor, backendMessenger, frontendMessenger, manager } =
      createMultiBotEnv()
    cfg.auth.allowedUsers = ['ou_alice']
    cfg.bots[1]!.requireMention = false

    try {
      // Bot with default requireMention=true ignores unmentioned group messages (and does not reply permission errors).
      await manager.handleMessage({
        botId: 'backend-bot',
        eventId: 'evt-bg-unmentioned-1',
        messageId: 'om_bg_1',
        rootId: '',
        parentId: '',
        threadId: '',
        chatId: 'oc_group_auto',
        chatType: 'group',
        senderId: 'ou_bob',
        text: 'General chat message',
        mentioned: false,
      })
      expect(backendCursor.createReqs).toHaveLength(0)
      expect(backendMessenger.repliedCards).toHaveLength(0)
      expect(backendMessenger.texts).toHaveLength(0)

      // Bot with requireMention=false auto-creates a thread for a top-level group message without @mention.
      await manager.handleMessage({
        botId: 'frontend-bot',
        eventId: 'evt-fg-auto-1',
        messageId: 'om_fg_1',
        rootId: '',
        parentId: '',
        threadId: '',
        chatId: 'oc_group_auto',
        chatType: 'group',
        senderId: 'ou_alice',
        text: 'Build a responsive navbar',
        mentioned: false,
      })
      expect(frontendCursor.createReqs).toHaveLength(1)
      expect(frontendCursor.createReqs[0]?.agentId).toBe(deriveAgentId('frontend-bot', 'om_fg_1'))
      expect(frontendMessenger.replyCardCalls[0]?.replyToMsgId).toBe('om_fg_1')
      expect(frontendMessenger.replyCardCalls[0]?.replyInThread).toBe(true)

      // Topic-group root messages may already carry threadId while rootId/parentId are empty.
      await manager.handleMessage({
        botId: 'frontend-bot',
        eventId: 'evt-fg-topic-root',
        messageId: 'om_fg_topic',
        rootId: '',
        parentId: '',
        threadId: 'omt_topic_root',
        chatId: 'oc_topic_group',
        chatType: 'group',
        senderId: 'ou_alice',
        text: 'Add keyboard navigation',
        mentioned: false,
      })
      expect(frontendCursor.createReqs).toHaveLength(2)
      expect(frontendMessenger.replyCardCalls[1]?.replyToMsgId).toBe('om_fg_topic')
      expect(frontendMessenger.replyCardCalls[1]?.replyInThread).toBe(true)

      // Replies inside unrelated non-bot threads are still ignored without @mention.
      await manager.handleMessage({
        botId: 'frontend-bot',
        eventId: 'evt-fg-unrelated-reply',
        messageId: 'om_fg_reply',
        rootId: 'om_someone_else',
        parentId: 'om_someone_else',
        threadId: 'omt_someone_else',
        chatId: 'oc_group_auto',
        chatType: 'group',
        senderId: 'ou_alice',
        text: 'Looks good to me',
        mentioned: false,
      })
      expect(frontendCursor.createReqs).toHaveLength(2)

      // Unauthorized users triggering a requireMention=false bot still receive the permission rejection.
      await manager.handleMessage({
        botId: 'frontend-bot',
        eventId: 'evt-fg-unauth',
        messageId: 'om_fg_unauth',
        rootId: '',
        parentId: '',
        threadId: '',
        chatId: 'oc_group_auto',
        chatType: 'group',
        senderId: 'ou_bob',
        text: 'Deploy to prod',
        mentioned: false,
      })
      expect(frontendCursor.createReqs).toHaveLength(2)
      expect(frontendMessenger.texts.at(-1)).toContain('do not have permission')
    } finally {
      await manager.stop()
    }
  })

  it('passes multiple repositories to cloud agent from default_repos and repos: header', async () => {
    const { cfg, backendCursor, backendMessenger, manager } = createMultiBotEnv()
    cfg.bots[0]!.defaultRepos = ['backend', 'web-app']
    try {
      await manager.handleMessage({
        botId: 'backend-bot',
        eventId: 'evt-multi-default',
        messageId: 'om_multi_1',
        rootId: '',
        parentId: '',
        threadId: '',
        chatId: 'oc_multi',
        chatType: 'group',
        senderId: 'ou_alice',
        text: '@_user_1 Trace cross-repo API contract',
        mentioned: true,
      })

      expect(backendCursor.createReqs).toHaveLength(1)
      expect(backendCursor.createReqs[0]?.repos).toEqual([
        { url: 'https://github.com/acme/backend', startingRef: 'main' },
        { url: 'https://github.com/acme/web-app', startingRef: 'main' },
      ])
      expect(JSON.stringify(backendMessenger.repliedCards[0])).toContain(
        'github.com/acme/backend, github.com/acme/web-app',
      )

      await manager.handleMessage({
        botId: 'backend-bot',
        eventId: 'evt-multi-explicit',
        messageId: 'om_multi_2',
        rootId: '',
        parentId: '',
        threadId: '',
        chatId: 'oc_multi',
        chatType: 'group',
        senderId: 'ou_alice',
        text: '@_user_1\nrepos: web-app, backend\nbranch: develop\ntask: Compare both repos',
        mentioned: true,
      })

      expect(backendCursor.createReqs).toHaveLength(2)
      expect(backendCursor.createReqs[1]?.repos).toEqual([
        { url: 'https://github.com/acme/web-app', startingRef: 'develop' },
        { url: 'https://github.com/acme/backend', startingRef: 'develop' },
      ])
    } finally {
      await manager.stop()
    }
  })

  it('supports local runtime with cwd, in-process ask_user, and cross-restart thread continuation', async () => {
    const cfg = createDefaultConfig()
    cfg.cursor.apiKey = 'key_local'
    cfg.cursor.pollIntervalMs = 15
    cfg.cursor.useSSE = false
    const localBotCfg: LarkBotConfig = {
      id: 'local-bot',
      name: 'Local Bot',
      appId: 'cli_local',
      appSecret: 'sec_local',
      domain: 'lark',
      verificationToken: '',
      encryptKey: '',
      logLevel: 'info',
      runtime: 'local',
      cwd: '/workspace/local-app',
      dirs: ['/workspace/shared-lib'],
      presetPrompt: 'Keep local changes minimal.',
      defaultModel: 'composer-2',
      sandbox: true,
    }
    cfg.bots = [localBotCfg]

    const localCursor = new FakeCursorClient()
    const localMessenger = new FakeMessenger()
    const runtimes = [{ config: localBotCfg, messenger: localMessenger, cursor: localCursor }]
    const manager = new TaskManager(cfg, runtimes)
    const restartedManager = new TaskManager(cfg, runtimes)

    try {
      await manager.handleMessage({
        botId: 'local-bot',
        eventId: 'evt-local-1',
        messageId: 'om_loc_1',
        rootId: '',
        parentId: '',
        threadId: '',
        chatId: 'oc_local',
        chatType: 'group',
        senderId: 'ou_alice',
        text: '@_user_1 Fix flaky integration tests',
        mentioned: true,
      })

      expect(localCursor.createReqs).toHaveLength(1)
      const createReq = localCursor.createReqs[0]!
      const expectedAgentId = deriveAgentId('local-bot', 'om_loc_1', 'local')
      expect(createReq.runtime).toBe('local')
      expect(createReq.agentId).toBe(expectedAgentId)
      expect(createReq.cwd).toBe('/workspace/local-app')
      expect(createReq.dirs).toEqual(['/workspace/shared-lib'])
      expect(createReq.prompt).toStartWith(
        '[Bot Instructions]\nKeep local changes minimal.\n\n[User Message]\nFix flaky integration tests',
      )
      expect(createReq.modelId).toBe('composer-2')
      expect(createReq.sandbox).toBe(true)
      expect(createReq.mcpServers).toBeUndefined()
      expect(createReq.onLocalAskUser).toBeDefined()

      // Invoke in-process local ask_user callback (no public MCP URL needed)
      const askRes = await createReq.onLocalAskUser!({
        question: 'Should we keep the legacy mock fixture?',
        options: [
          { label: 'Keep it', value: 'keep' },
          { label: 'Remove it', value: 'remove' },
        ],
      })
      expect(askRes.agentId).toBe(expectedAgentId)
      expect(localMessenger.repliedCards).toHaveLength(2)

      // Finish run-1 so answering triggers sendFollowUp cleanly
      localCursor.finishRun('run-1', 'Waiting for user decision.')
      await waitUntil(() => localMessenger.updatedCards.size >= 1)

      const qCard = localMessenger.repliedCards[1]!
      const qMsgId = localMessenger.replyCardCalls[1]!.messageId
      const customCallback = findCallbackValues(qCard).find(
        (v) => v.action === 'answer_question_custom',
      )!
      expect(customCallback.runtime).toBe('local')
      expect(customCallback.cwd).toBe('/workspace/local-app')

      // Answer on restartedManager -> resumes local agent with cwd & onLocalAskUser
      const ok = await restartedManager.handleCardAction({
        botId: 'local-bot',
        operatorOpenId: 'ou_alice',
        chatId: 'oc_local',
        messageId: qMsgId,
        actionValue: customCallback,
        formValue: { custom_answer: 'Migrate fixture to builder helper' },
      })
      expect(ok.toastType).toBe('success')

      await waitUntil(() => localCursor.followUpReqs.length === 1)
      const followReq = localCursor.followUpReqs[0]!
      expect(followReq.runtime).toBe('local')
      expect(followReq.cwd).toBe('/workspace/local-app')
      expect(followReq.dirs).toEqual(['/workspace/shared-lib'])
      expect(followReq.prompt).not.toContain('[Bot Instructions]')
      expect(followReq.prompt).not.toContain('Keep local changes minimal.')
      expect(followReq.modelId).toBe('composer-2')
      expect(followReq.onLocalAskUser).toBeDefined()
      expect(followReq.prompt).toContain('Migrate fixture to builder helper')

      // Thread reply on restartedManager steers the active local run
      await restartedManager.handleMessage({
        botId: 'local-bot',
        eventId: 'evt-local-steer',
        messageId: 'om_loc_2',
        rootId: 'om_loc_1',
        parentId: '',
        threadId: 'omt_om_loc_1',
        chatId: 'oc_local',
        chatType: 'group',
        senderId: 'ou_alice',
        text: 'Also run typecheck before finishing',
        mentioned: false,
      })
      expect(localCursor.steerReqs).toHaveLength(1)
      expect(localCursor.steerReqs[0]).toEqual({
        agentId: expectedAgentId,
        prompt: 'Also run typecheck before finishing',
        runtime: 'local',
      })
    } finally {
      await manager.stop()
      await restartedManager.stop()
    }
  })
})
