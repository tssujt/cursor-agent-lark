import type {
  LocalAgentOptions,
  McpServerConfig,
  Run,
  RunResult,
  SDKAgentInfo,
  SDKCustomTool,
} from '@cursor/sdk'
import { Agent, AgentBusyError, Cursor } from '@cursor/sdk'
import { Buffer } from 'node:buffer'
import type {
  AgentRuntime,
  AgentSummary,
  CreateAgentInput,
  CreatedAgentRun,
  CursorClient,
  CursorKeyIdentity,
  CursorModelSummary,
  LocalAskUserCallback,
  McpServerSpec,
  NormalizedRunStatus,
  RunSnapshot,
  RuntimeLookupOptions,
  SendFollowUpInput,
  SteerResult,
} from './types.ts'
import { normalizeOptions } from '../hitl/parser.ts'
import {
  CursorAgentBusyError,
  CursorAgentConflictError,
  isCloudAgentId,
  isTerminalRunStatus,
} from './types.ts'

export interface CursorSdkClientOptions {
  apiKey: string
  baseUrl?: string
  requestTimeoutMs?: number
}

/**
 * Official `@cursor/sdk` wrapper supporting both Cloud and Local Agent runtimes.
 */
export class CursorSdkClient implements CursorClient {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly requestTimeoutMs: number
  // Retain active Run handles in memory so waitForRun(), steerRun(), and cancelRun() can operate directly.
  private readonly liveRuns = new Map<string, Run>()

  constructor(opts: CursorSdkClientOptions) {
    this.apiKey = opts.apiKey
    this.baseUrl = (opts.baseUrl ?? 'https://api.cursor.com').replace(/\/+$/, '')
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000
  }

  async getMe(): Promise<CursorKeyIdentity> {
    const me = await Cursor.me({ apiKey: this.apiKey })
    return {
      apiKeyName: me.apiKeyName,
      userEmail: me.userEmail,
    }
  }

  async listModels(): Promise<CursorModelSummary[]> {
    const models = await Cursor.models.list({ apiKey: this.apiKey })
    return models.map((m) => ({
      id: m.id,
      displayName: m.displayName,
      description: m.description,
    }))
  }

  async getAgent(agentId: string, options?: RuntimeLookupOptions): Promise<AgentSummary | null> {
    const runtime = resolveRuntime(agentId, options?.runtime)
    if (runtime === 'local') {
      try {
        const info = await Agent.get(agentId, { cwd: options?.cwd })
        return infoToSummary(info)
      } catch (err) {
        if (isNotFoundError(err)) return null
        // Fall back to listing local agents in cwd when Agent.get is cloud-only in an older runtime.
        const listed = await this.listAgents(100, { runtime: 'local', cwd: options?.cwd }).catch(
          () => [],
        )
        return listed.find((a) => a.agentId === agentId) ?? null
      }
    }

    try {
      const info = await Agent.get(agentId, { apiKey: this.apiKey })
      return infoToSummary(info)
    } catch (err) {
      if (isNotFoundError(err)) return null
      throw err
    }
  }

  async listAgents(limit = 50, options?: RuntimeLookupOptions): Promise<AgentSummary[]> {
    if (options?.runtime === 'local') {
      const res = await Agent.list({
        runtime: 'local',
        cwd: options.cwd,
        limit,
      })
      return res.items.map(infoToSummary)
    }

    const res = await Agent.list({
      runtime: 'cloud',
      apiKey: this.apiKey,
      limit,
      includeArchived: false,
    })
    return res.items.map(infoToSummary)
  }

  async createAgentAndRun(input: CreateAgentInput): Promise<CreatedAgentRun> {
    const runtime: AgentRuntime = input.runtime ?? 'cloud'
    const mcpServers = toSdkMcpServers(input.mcpServers)

    if (runtime === 'local') return this.createLocalAgentAndRun(input, mcpServers)

    const cloud: NonNullable<Parameters<typeof Agent.create>[0]['cloud']> = {
      repos: input.repoUrl
        ? [{ url: input.repoUrl, startingRef: input.startingRef || undefined }]
        : [],
      metadata: input.metadata,
    }
    if (input.repoUrl) {
      cloud.autoCreatePR = input.autoCreatePR
      cloud.workOnCurrentBranch = input.workOnCurrentBranch
      if (input.autoCreatePR && input.skipReviewerRequest) cloud.skipReviewerRequest = true
    }

    try {
      const agent = await Agent.create({
        apiKey: this.apiKey,
        agentId: input.agentId,
        name: input.name,
        model: input.modelId ? { id: input.modelId } : undefined,
        mode: input.mode,
        mcpServers,
        cloud,
      })

      const run = await agent.send(input.prompt)
      const agentId = run.agentId || agent.agentId
      this.liveRuns.set(runKey(agentId, run.id), run)

      return {
        agentId,
        runtime: 'cloud',
        agentUrl: `https://cursor.com/agents/${agentId}`,
        name: input.name || agentId,
        run: runToSnapshot(run),
      }
    } catch (err) {
      if (isConflictError(err)) {
        const message = err instanceof Error ? err.message : String(err)
        throw new CursorAgentConflictError(message)
      }
      throw err
    }
  }

  private async createLocalAgentAndRun(
    input: CreateAgentInput,
    mcpServers: Record<string, McpServerConfig> | undefined,
  ): Promise<CreatedAgentRun> {
    if (!input.modelId)
      throw new Error(
        'Local runtime requires a model ID (set default_model in config or pass model: <id>)',
      )

    const local = buildLocalOptions(input)
    try {
      const agent = await Agent.create({
        apiKey: this.apiKey,
        agentId: input.agentId,
        name: input.name,
        model: { id: input.modelId },
        mode: input.mode,
        mcpServers,
        local,
      })

      const run = await agent.send(input.prompt)
      const agentId = run.agentId || agent.agentId
      this.liveRuns.set(runKey(agentId, run.id), run)

      return {
        agentId,
        runtime: 'local',
        agentUrl: '',
        name: input.name || agentId,
        run: runToSnapshot(run),
      }
    } catch (err) {
      if (isConflictError(err)) {
        const message = err instanceof Error ? err.message : String(err)
        throw new CursorAgentConflictError(message)
      }
      throw err
    }
  }

  async sendFollowUp(input: SendFollowUpInput): Promise<RunSnapshot> {
    const runtime = resolveRuntime(input.agentId, input.runtime)
    const mcpServers = toSdkMcpServers(input.mcpServers)
    const agent = await Agent.resume(input.agentId, {
      apiKey: this.apiKey,
      model: input.modelId ? { id: input.modelId } : undefined,
      mode: input.mode,
      mcpServers,
      local: runtime === 'local' ? buildLocalOptions(input) : undefined,
    })

    try {
      const run = await agent.send(input.prompt)
      this.liveRuns.set(runKey(input.agentId, run.id), run)
      return runToSnapshot(run)
    } catch (err) {
      if (err instanceof AgentBusyError) throw new CursorAgentBusyError(err.message)
      throw err
    }
  }

  /**
   * Steers an active run:
   * - Local runtime uses native `Run.steer()` on the live in-process Run handle.
   * - Cloud runtime sends `delivery: "steer"` to Cursor Cloud Agents REST API v1.
   */
  async steerRun(
    agentId: string,
    prompt: string,
    options?: RuntimeLookupOptions,
  ): Promise<SteerResult> {
    const runtime = resolveRuntime(agentId, options?.runtime)
    if (runtime === 'local') {
      const live = this.findLiveRunForAgent(agentId)
      if (!live || typeof live.steer !== 'function') return { delivery: 'unavailable' }

      const outcome = await live.steer(prompt)
      if (outcome === 'complete_delivered') return { delivery: 'steered', runId: live.id }
      if (outcome === 'revert_to_followup') return { delivery: 'unavailable' }
      if (outcome.run) this.liveRuns.set(runKey(agentId, outcome.run.id), outcome.run)
      return { delivery: 'queued', runId: outcome.run?.id }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs)
    try {
      const auth = Buffer.from(`${this.apiKey}:`).toString('base64')
      const res = await fetch(`${this.baseUrl}/v1/agents/${encodeURIComponent(agentId)}/runs`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          prompt: { text: prompt },
          delivery: 'steer',
        }),
        signal: controller.signal,
      })

      if (res.status === 403) return { delivery: 'unavailable' }
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Cursor steer failed (${res.status}): ${text}`)
      }
      const data = (await res.json()) as { delivery?: string; runId?: string }
      if (data.delivery === 'steered') return { delivery: 'steered', runId: data.runId }
      return { delivery: 'queued', runId: data.runId }
    } finally {
      clearTimeout(timer)
    }
  }

  async getRun(
    agentId: string,
    runId: string,
    options?: RuntimeLookupOptions,
  ): Promise<RunSnapshot> {
    const live = this.liveRuns.get(runKey(agentId, runId))
    if (live) return runToSnapshot(live)

    const runtime = resolveRuntime(agentId, options?.runtime)
    const run =
      runtime === 'local'
        ? await Agent.getRun(runId, { runtime: 'local', cwd: options?.cwd })
        : await Agent.getRun(runId, { runtime: 'cloud', agentId, apiKey: this.apiKey })
    return runToSnapshot(run)
  }

  async getLatestRun(agentId: string, options?: RuntimeLookupOptions): Promise<RunSnapshot | null> {
    const live = this.findLiveRunForAgent(agentId)
    if (live && !isTerminalRunStatus(live.status)) return runToSnapshot(live)

    const runtime = resolveRuntime(agentId, options?.runtime)
    const list =
      runtime === 'local'
        ? await Agent.listRuns(agentId, { runtime: 'local', cwd: options?.cwd, limit: 1 })
        : await Agent.listRuns(agentId, { runtime: 'cloud', apiKey: this.apiKey, limit: 1 })
    const latest = list.items[0]
    return latest ? runToSnapshot(latest) : null
  }

  async waitForRun(
    agentId: string,
    runId: string,
    options: {
      signal: AbortSignal
      useSSE: boolean
      pollIntervalMs: number
      runtime?: AgentRuntime
      cwd?: string
      onStatus?: (status: NormalizedRunStatus) => void
    },
  ): Promise<RunSnapshot> {
    const key = runKey(agentId, runId)
    const runtime = resolveRuntime(agentId, options.runtime)
    try {
      if (options.useSSE || runtime === 'local') {
        const live =
          this.liveRuns.get(key) ??
          (runtime === 'local'
            ? await Agent.getRun(runId, { runtime: 'local', cwd: options.cwd })
            : await Agent.getRun(runId, { runtime: 'cloud', agentId, apiKey: this.apiKey }))

        if (isTerminalRunStatus(live.status)) return runToSnapshot(live)

        try {
          const snapshot = await this.consumeStream(
            live,
            agentId,
            runId,
            options.signal,
            options.onStatus,
            {
              runtime,
              cwd: options.cwd,
            },
          )
          if (snapshot) return snapshot
        } catch (err) {
          if (options.signal.aborted) throw err
          // Fall back to polling if the stream expires or disconnects transiently.
        }
      }

      return await this.pollUntilTerminal(
        agentId,
        runId,
        options.signal,
        options.pollIntervalMs,
        options.onStatus,
        {
          runtime,
          cwd: options.cwd,
        },
      )
    } finally {
      this.liveRuns.delete(key)
    }
  }

  async cancelRun(agentId: string, runId: string, options?: RuntimeLookupOptions): Promise<void> {
    const key = runKey(agentId, runId)
    const live = this.liveRuns.get(key)
    const runtime = resolveRuntime(agentId, options?.runtime)
    try {
      if (live && live.supports('cancel')) {
        await live.cancel()
      } else if (runtime === 'local') {
        await Agent.cancelRun(runId, {
          runtime: 'local',
          cwd: options?.cwd,
        })
      } else {
        await Agent.cancelRun(runId, {
          runtime: 'cloud',
          agentId,
          apiKey: this.apiKey,
        })
      }
    } finally {
      this.liveRuns.delete(key)
    }
  }

  private findLiveRunForAgent(agentId: string): Run | undefined {
    let found: Run | undefined
    for (const run of this.liveRuns.values()) {
      if (run.agentId === agentId) found = run
    }
    return found
  }

  private async consumeStream(
    run: Run,
    agentId: string,
    runId: string,
    signal: AbortSignal,
    onStatus?: (status: NormalizedRunStatus) => void,
    lookup?: RuntimeLookupOptions,
  ): Promise<RunSnapshot | null> {
    if (!run.supports('stream')) return null

    const unsub = run.onDidChangeStatus((status) => {
      onStatus?.(status)
    })

    try {
      for await (const _msg of run.stream()) {
        if (signal.aborted) return null
      }
      if (signal.aborted) return null

      if (run.supports('wait')) {
        const finalResult = await run.wait()
        return resultToSnapshot(agentId, finalResult)
      }
      const fresh = await this.getRun(agentId, runId, lookup)
      return isTerminalRunStatus(fresh.status) ? fresh : null
    } finally {
      unsub()
    }
  }

  private async pollUntilTerminal(
    agentId: string,
    runId: string,
    signal: AbortSignal,
    pollIntervalMs: number,
    onStatus?: (status: NormalizedRunStatus) => void,
    lookup?: RuntimeLookupOptions,
  ): Promise<RunSnapshot> {
    let lastStatus: NormalizedRunStatus | undefined
    while (!signal.aborted) {
      const snap = await this.getRun(agentId, runId, lookup)
      if (snap.status !== lastStatus) {
        lastStatus = snap.status
        onStatus?.(snap.status)
      }
      if (isTerminalRunStatus(snap.status)) return snap
      await sleepAbortable(pollIntervalMs, signal)
    }
    throw new DOMException('Aborted', 'AbortError')
  }
}

function resolveRuntime(agentId: string, explicit?: AgentRuntime): AgentRuntime {
  if (explicit) return explicit
  return isCloudAgentId(agentId) ? 'cloud' : 'local'
}

function buildLocalOptions(input: {
  cwd?: string
  dirs?: string[]
  sandbox?: boolean
  autoReview?: boolean
  settingSources?: LocalAgentOptions['settingSources']
  onLocalAskUser?: LocalAskUserCallback
}): LocalAgentOptions {
  const local: LocalAgentOptions = {}
  if (input.cwd) local.cwd = input.cwd
  if (input.dirs && input.dirs.length > 0) local.dirs = input.dirs
  if (input.sandbox !== undefined) local.sandboxOptions = { enabled: input.sandbox }
  if (input.autoReview !== undefined) local.autoReview = input.autoReview
  if (input.settingSources && input.settingSources.length > 0)
    local.settingSources = input.settingSources
  if (input.onLocalAskUser) {
    local.customTools = {
      ask_user: buildLocalAskUserTool(input.onLocalAskUser),
    }
  }
  return local
}

function buildLocalAskUserTool(onAskUser: LocalAskUserCallback): SDKCustomTool {
  return {
    description:
      'Submit a question to the Lark user for confirmation or decision. A custom free-text input option ("Other") is automatically appended as the last item in the Lark card, so do not add an "Other" option yourself. Returns immediately without blocking; finish any independent work and end the current run to wait for the user\'s answer.',
    inputSchema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'Clear question for the Lark user.',
        },
        options: {
          type: 'array',
          description: 'Optional list of suggested choices (strings or {label, value} objects).',
          items: {
            anyOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  value: { type: 'string' },
                },
                required: ['label'],
              },
            ],
          },
        },
        allow_custom_input: {
          type: 'boolean',
          description:
            'Whether to append a custom text input as the last option (defaults to true).',
        },
        custom_input_placeholder: {
          type: 'string',
          description: 'Optional placeholder text for the custom answer input field.',
        },
      },
      required: ['question'],
    },
    execute: async (args) => {
      const question = typeof args.question === 'string' ? args.question.trim() : ''
      if (!question) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'question is required' }],
        }
      }
      const res = await onAskUser({
        question,
        options: normalizeOptions(args.options),
        allowCustomInput:
          typeof args.allow_custom_input === 'boolean' ? args.allow_custom_input : undefined,
        customInputPlaceholder:
          typeof args.custom_input_placeholder === 'string' && args.custom_input_placeholder.trim()
            ? args.custom_input_placeholder.trim()
            : undefined,
      })
      return {
        content: [
          {
            type: 'text',
            text: `Question ${res.questionId} has been sent to the Lark user for agent ${res.agentId} (status: ${res.status}). Do NOT guess the answer. Finish any independent work if needed, then end the current run; the user's answer will arrive in a follow-up run.`,
          },
        ],
      }
    },
  }
}

function infoToSummary(info: SDKAgentInfo): AgentSummary {
  if (info.runtime === 'local' || (!info.runtime && !isCloudAgentId(info.agentId))) {
    return {
      agentId: info.agentId,
      runtime: 'local',
      agentUrl: '',
      name: info.name,
      summary: info.summary,
      status: info.status,
      repos: [],
      cwd: info.runtime === 'local' ? info.cwd : undefined,
      metadata: {},
      createdAt: info.createdAt,
      lastModified: info.lastModified,
    }
  }

  const cloudRepos = info.runtime === 'cloud' ? (info.repos ?? []) : []
  const cloudMetadata = info.runtime === 'cloud' ? (info.metadata ?? {}) : {}
  return {
    agentId: info.agentId,
    runtime: 'cloud',
    agentUrl: `https://cursor.com/agents/${info.agentId}`,
    name: info.name,
    summary: info.summary,
    status: info.status,
    repos: cloudRepos,
    metadata: cloudMetadata,
    createdAt: info.createdAt,
    lastModified: info.lastModified,
  }
}

function isNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { statusCode?: number; status?: number; code?: string; message?: string }
  if (e.statusCode === 404 || e.status === 404) return true
  if (e.code && /not_found/i.test(e.code)) return true
  return Boolean(e.message && /404|not found/i.test(e.message))
}

function isConflictError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { statusCode?: number; status?: number; code?: string; message?: string }
  if (e.statusCode === 409 || e.status === 409) return true
  return Boolean(e.code && /agent_id_conflict/i.test(e.code))
}

function toSdkMcpServers(specs?: McpServerSpec[]): Record<string, McpServerConfig> | undefined {
  if (!specs || specs.length === 0) return undefined
  const out: Record<string, McpServerConfig> = {}
  for (const s of specs) {
    if (s.type === 'stdio') {
      out[s.name] = {
        type: 'stdio',
        command: s.command,
        args: s.args,
        env: s.env,
      }
    } else {
      out[s.name] = {
        type: s.type,
        url: s.url,
        headers: s.headers,
      }
    }
  }
  return out
}

function runToSnapshot(run: Run): RunSnapshot {
  return {
    id: run.id,
    agentId: run.agentId,
    status: run.status,
    result: run.result,
    errorMessage: run.error?.message,
    durationMs: run.durationMs,
    branches: run.git?.branches ?? [],
  }
}

function resultToSnapshot(agentId: string, res: RunResult): RunSnapshot {
  return {
    id: res.id,
    agentId,
    status: res.status,
    result: res.result,
    errorMessage: res.error?.message,
    durationMs: res.durationMs,
    branches: res.git?.branches ?? [],
  }
}

function runKey(agentId: string, runId: string): string {
  return `${agentId}:${runId}`
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
