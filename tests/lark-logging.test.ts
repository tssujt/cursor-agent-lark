import type * as lark from '@larksuiteoapi/node-sdk'
import { describe, expect, it } from 'bun:test'
import type { Logger } from '../src/logger.ts'
import { buildHelpCard } from '../src/lark/cards.ts'
import { extractMessageText } from '../src/lark/message-content.ts'
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

  it('extracts text from post and interactive alert cards and fetches quoted messages', async () => {
    const alertCardJson = JSON.stringify({
      title: 'prod-k8s cronjob 异常报警',
      elements: [
        [{ tag: 'text', text: '报警时间：2026-11-26 17:57:57' }],
        [{ tag: 'text', text: 'pod：spaceport-cron-tianji-ftp-forecast-29928106' }],
      ],
    })
    expect(extractMessageText('interactive', alertCardJson)).toBe(
      'prod-k8s cronjob 异常报警\n报警时间：2026-11-26 17:57:57\npod：spaceport-cron-tianji-ftp-forecast-29928106',
    )

    const localePostJson = JSON.stringify({
      zh_cn: {
        title: '告警通知',
        content: [[{ tag: 'text', text: '服务超时' }]],
      },
    })
    expect(extractMessageText('post', localePostJson)).toBe('告警通知\n服务超时')

    const fakeClient = {
      im: {
        v1: {
          message: {
            get: async () => ({
              code: 0,
              data: {
                items: [{ msg_type: 'interactive', body: { content: alertCardJson } }],
              },
            }),
          },
        },
      },
    } as unknown as lark.Client

    const { logger, entries } = createMemoryLogger()
    const messenger = new LarkMessenger(fakeClient, logger, 'ops-bot')
    const fetched = await messenger.getMessageText('om_alert_1')
    expect(fetched).toContain('prod-k8s cronjob 异常报警')
    expect(entries.at(-1)?.msg).toBe('Fetched quoted Lark message')
  })
})
