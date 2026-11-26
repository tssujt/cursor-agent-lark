import { describe, expect, it } from 'bun:test'
import type { SessionContext } from '../src/store/types.ts'
import {
  decodeMcpContext,
  deriveAgentId,
  encodeMcpContext,
  EphemeralCache,
  TtlSet,
} from '../src/store/store.ts'

describe('stateless session utilities', () => {
  it('derives deterministic RFC 4122 UUIDv5 bc- agent IDs scoped by bot and root message', () => {
    const id1 = deriveAgentId('backend-bot', 'om_root_1')
    const id2 = deriveAgentId('backend-bot', 'om_root_1')
    const otherMsg = deriveAgentId('backend-bot', 'om_root_2')
    const otherBot = deriveAgentId('frontend-bot', 'om_root_1')

    expect(id1).toBe(id2)
    expect(id1).toMatch(/^bc-[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(id1).not.toBe(otherMsg)
    expect(id1).not.toBe(otherBot)

    const localId1 = deriveAgentId('backend-bot', 'om_root_1', 'local')
    const localId2 = deriveAgentId('backend-bot', 'om_root_1', 'local')
    expect(localId1).toBe(localId2)
    expect(localId1).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(localId1.startsWith('bc-')).toBe(false)
    expect(localId1).not.toBe(id1.slice(3))
  })

  it('encodes, signs, decodes, and rejects tampered MCP context tokens', () => {
    const ctx: SessionContext = {
      botId: 'backend-bot',
      chatId: 'oc_chat1',
      chatType: 'group',
      rootMsgId: 'om_root_1',
      userId: 'ou_alice',
      agentId: deriveAgentId('backend-bot', 'om_root_1'),
    }

    const unsigned = encodeMcpContext(ctx)
    expect(decodeMcpContext(unsigned)).toEqual(ctx)

    const signed = encodeMcpContext(ctx, 'secret-key')
    expect(signed).toContain('.')
    expect(decodeMcpContext(signed, 'secret-key')).toEqual(ctx)
    expect(decodeMcpContext(signed, 'wrong-key')).toBeNull()
    expect(decodeMcpContext(`${signed}x`, 'secret-key')).toBeNull()
    expect(decodeMcpContext(unsigned, 'secret-key')).toBeNull()
  })

  it('deduplicates keys within TTL and expires them afterward', () => {
    const set = new TtlSet(1_000)
    expect(set.addIfAbsent('bot-a:evt-1', 100)).toBe(true)
    expect(set.addIfAbsent('bot-a:evt-1', 500)).toBe(false)
    expect(set.has('bot-a:evt-1', 500)).toBe(true)
    expect(set.addIfAbsent('bot-b:evt-1', 500)).toBe(true)

    expect(set.has('bot-a:evt-1', 1_200)).toBe(false)
    expect(set.addIfAbsent('bot-a:evt-1', 1_200)).toBe(true)
  })

  it('tracks pending questions and follow-up queues in EphemeralCache', () => {
    const cache = new EphemeralCache()
    cache.setPendingQuestion({
      questionId: 'q-1',
      agentId: 'bc-1',
      botId: 'backend-bot',
      larkChatId: 'oc_1',
      larkChatType: 'group',
      larkRootMsgId: 'om_root',
      larkUserId: 'ou_alice',
      larkMsgId: 'om_q1',
      question: 'Cache TTL?',
      options: [{ label: '5m', value: '300' }],
    })

    expect(cache.pendingQuestions.get('bc-1')?.questionId).toBe('q-1')
    expect(cache.pendingQuestionsByMsgId.get('om_q1')?.questionId).toBe('q-1')

    cache.clearPendingQuestion('bc-1', 'q-other')
    expect(cache.pendingQuestions.has('bc-1')).toBe(true)

    cache.clearPendingQuestion('bc-1', 'q-1')
    expect(cache.pendingQuestions.has('bc-1')).toBe(false)
    expect(cache.pendingQuestionsByMsgId.has('om_q1')).toBe(false)

    cache.enqueueFollowUp('bc-1', 'First follow-up')
    cache.enqueueFollowUp('bc-1', 'Second follow-up')
    expect(cache.drainFollowUps('bc-1')).toBe('First follow-up\n\nSecond follow-up')
    expect(cache.drainFollowUps('bc-1')).toBe('')
  })
})
