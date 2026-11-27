import { Buffer } from 'node:buffer'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { AgentRuntime } from '../cursor/types.ts'
import type { QuestionView, SessionContext } from './types.ts'

// Fixed RFC 4122 namespace UUID for deterministic Lark-thread -> Cursor-agent ID derivation.
const AGENT_NAMESPACE_BYTES = Buffer.from('7b6f0f8a8c3e4d5a9b1f2c4e6f8a0b1c', 'hex')

/**
 * Deterministically derives a Cursor Agent ID from `(botId, rootMsgId, runtime)`.
 * - `cloud` runtime uses `bc-<uuidv5>` (routed to Cursor Cloud API by `@cursor/sdk`).
 * - `local` runtime uses `<uuidv5>` without `bc-` prefix (routed to the local store by `@cursor/sdk`).
 */
export function deriveAgentId(
  botId: string,
  rootMsgId: string,
  runtime: AgentRuntime = 'cloud',
): string {
  const seed = runtime === 'local' ? `local:${botId}:${rootMsgId}` : `${botId}:${rootMsgId}`
  const hash = createHash('sha1').update(AGENT_NAMESPACE_BYTES).update(seed, 'utf8').digest()

  // Set RFC 4122 version 5 and variant bits.
  hash[6] = (hash[6]! & 0x0f) | 0x50
  hash[8] = (hash[8]! & 0x3f) | 0x80

  const hex = hash.subarray(0, 16).toString('hex')
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  return runtime === 'local' ? uuid : `bc-${uuid}`
}

interface CompactContextPayload {
  b: string
  c: string
  t: string
  r: string
  u: string
  a: string
  m?: 'c' | 'l'
  w?: string
}

/**
 * Encodes a stateless session context for the built-in `/mcp?ctx=...` query parameter.
 * When `secret` is provided, appends an HMAC-SHA256 signature to prevent tampering.
 */
export function encodeMcpContext(ctx: SessionContext, secret = ''): string {
  const payload: CompactContextPayload = {
    b: ctx.botId,
    c: ctx.chatId,
    t: ctx.chatType,
    r: ctx.rootMsgId,
    u: ctx.userId,
    a: ctx.agentId,
  }
  if (ctx.runtime === 'local') payload.m = 'l'
  if (ctx.cwd) payload.w = ctx.cwd
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  if (!secret) return body
  const sig = signPayload(body, secret)
  return `${body}.${sig}`
}

/**
 * Decodes and optionally verifies a stateless `/mcp?ctx=...` token.
 */
export function decodeMcpContext(token: string, secret = ''): SessionContext | null {
  const trimmed = token.trim()
  if (!trimmed) return null

  let body = trimmed
  if (secret) {
    const dot = trimmed.indexOf('.')
    if (dot <= 0) return null
    body = trimmed.slice(0, dot)
    const providedSig = trimmed.slice(dot + 1)
    const expectedSig = signPayload(body, secret)
    const a = Buffer.from(providedSig)
    const b = Buffer.from(expectedSig)
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  } else {
    const dot = trimmed.indexOf('.')
    if (dot > 0) body = trimmed.slice(0, dot)
  }

  try {
    const raw = JSON.parse(
      Buffer.from(body, 'base64url').toString('utf8'),
    ) as Partial<CompactContextPayload>
    if (!raw.b || !raw.c || !raw.a) return null
    const ctx: SessionContext = {
      botId: raw.b,
      chatId: raw.c,
      chatType: raw.t ?? 'group',
      rootMsgId: raw.r ?? '',
      userId: raw.u ?? '',
      agentId: raw.a,
    }
    if (raw.m === 'l') ctx.runtime = 'local'
    if (raw.w) ctx.cwd = raw.w
    return ctx
  } catch {
    return null
  }
}

function signPayload(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('base64url').slice(0, 22)
}

/**
 * Process-local TTL set for ephemeral event deduplication and double-click protection.
 */
export class TtlSet {
  private readonly entries = new Map<string, number>()

  constructor(private readonly ttlMs: number) {}

  /**
   * Adds `key` if absent or expired. Returns `true` when newly added, `false` if already present.
   */
  addIfAbsent(key: string, now = Date.now()): boolean {
    if (!key) return true
    this.pruneIfNeeded(now)
    const exp = this.entries.get(key)
    if (exp !== undefined && exp > now) return false
    this.entries.set(key, now + this.ttlMs)
    return true
  }

  has(key: string, now = Date.now()): boolean {
    const exp = this.entries.get(key)
    if (exp === undefined) return false
    if (exp <= now) {
      this.entries.delete(key)
      return false
    }
    return true
  }

  private pruneIfNeeded(now: number): void {
    if (this.entries.size < 1024) return
    for (const [k, exp] of this.entries) {
      if (exp <= now) this.entries.delete(k)
    }
  }
}

/**
 * Purely ephemeral in-memory runtime cache (safe to lose on restart).
 * Durable state lives in Cursor Cloud Agents (`agentId` + `cloud.metadata`) and Lark card payloads.
 */
export class EphemeralCache {
  readonly processedEvents = new TtlSet(5 * 60_000)
  readonly answeredQuestions = new TtlSet(24 * 60 * 60_000)
  readonly cardMsgIds = new Map<string, string>()
  readonly sessions = new Map<string, SessionContext>()
  readonly threadSessions = new Map<string, string>()
  readonly rootMsgSessions = new Map<string, string>()
  readonly pendingQuestions = new Map<string, QuestionView>()
  readonly pendingQuestionsByMsgId = new Map<string, QuestionView>()
  readonly pendingFollowUps = new Map<string, string[]>()

  indexSession(
    session: SessionContext,
    opts?: { threadId?: string; rootMsgIds?: Array<string | undefined> },
  ): void {
    this.sessions.set(session.agentId, session)
    if (session.rootMsgId) this.rootMsgSessions.set(session.rootMsgId, session.agentId)
    if (opts?.threadId) this.threadSessions.set(opts.threadId, session.agentId)
    if (opts?.rootMsgIds) {
      for (const id of opts.rootMsgIds) {
        if (id) this.rootMsgSessions.set(id, session.agentId)
      }
    }
  }

  setPendingQuestion(q: QuestionView): void {
    this.pendingQuestions.set(q.agentId, q)
    if (q.larkMsgId) this.pendingQuestionsByMsgId.set(q.larkMsgId, q)
  }

  clearPendingQuestion(agentId: string, questionId?: string): void {
    const existing = this.pendingQuestions.get(agentId)
    if (!existing) return
    if (questionId && existing.questionId !== questionId) return
    this.pendingQuestions.delete(agentId)
    if (existing.larkMsgId) this.pendingQuestionsByMsgId.delete(existing.larkMsgId)
  }

  enqueueFollowUp(agentId: string, prompt: string): void {
    const list = this.pendingFollowUps.get(agentId) ?? []
    list.push(prompt)
    this.pendingFollowUps.set(agentId, list)
  }

  drainFollowUps(agentId: string): string {
    const list = this.pendingFollowUps.get(agentId)
    if (!list || list.length === 0) return ''
    this.pendingFollowUps.delete(agentId)
    return list.join('\n\n')
  }
}
