import type * as lark from '@larksuiteoapi/node-sdk'
import { describe, expect, it } from 'bun:test'
import type { Logger } from '../src/logger.ts'
import { buildHelpCard } from '../src/lark/cards.ts'
import { LarkMessenger } from '../src/lark/messenger.ts'

interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error'
  msg: string
  fields?: Record<string, unknown>
}

function createMemoryLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = []
  return {
    entries,
    logger: {
      debug: (msg, fields) => entries.push({ level: 'debug', msg, fields }),
      info: (msg, fields) => entries.push({ level: 'info', msg, fields }),
      warn: (msg, fields) => entries.push({ level: 'warn', msg, fields }),
      error: (msg, fields) => entries.push({ level: 'error', msg, fields }),
    },
  }
}

describe('LarkMessenger logging', () => {
  it('logs outbound text and card messages with ids, thread flags, and truncated previews', async () => {
    const fakeClient = {
      im: {
        v1: {
          message: {
            create: async () => ({ code: 0, data: { message_id: 'om_created' } }),
            reply: async () => ({
              code: 0,
              data: { message_id: 'om_replied', thread_id: 'omt_1' },
            }),
            patch: async () => ({ code: 0 }),
          },
        },
      },
    } as unknown as lark.Client

    const { logger, entries } = createMemoryLogger()
    const messenger = new LarkMessenger(fakeClient, logger, 'backend-bot')
    const card = buildHelpCard(false, 'Backend Bot')

    await messenger.sendText('oc_1', `hello\n${'x'.repeat(250)}`)
    await messenger.replyText('om_root', 'reply text', true)
    await messenger.sendCard('oc_1', card)
    await messenger.replyCard('om_root', card, true)
    await messenger.updateCard('om_card', card)

    expect(entries.map((e) => e.msg)).toEqual([
      'Sent Lark text',
      'Replied Lark text',
      'Sent Lark card',
      'Replied Lark card',
      'Updated Lark card',
    ])
    expect(entries[0]?.fields?.botId).toBe('backend-bot')
    expect(entries[0]?.fields?.messageId).toBe('om_created')
    expect(String(entries[0]?.fields?.text)).toEndWith('...')
    expect(entries[1]?.fields).toEqual({
      botId: 'backend-bot',
      replyToMsgId: 'om_root',
      replyInThread: true,
      messageId: 'om_replied',
      threadId: 'omt_1',
      text: 'reply text',
    })
    expect(entries[3]?.fields).toEqual({
      botId: 'backend-bot',
      replyToMsgId: 'om_root',
      replyInThread: true,
      messageId: 'om_replied',
      threadId: 'omt_1',
      cardTitle: card.header.title.content,
    })
  })
})
