import type * as lark from '@larksuiteoapi/node-sdk'
import type { Logger } from '../logger.ts'
import type { CardJSON } from './cards.ts'
import { noopLogger } from '../logger.ts'

export interface ReplyResult {
  messageId: string
  threadId: string
}

export interface Messenger {
  sendCard: (chatId: string, card: CardJSON) => Promise<string>
  replyCard: (replyToMsgId: string, card: CardJSON, replyInThread?: boolean) => Promise<ReplyResult>
  updateCard: (messageId: string, card: CardJSON) => Promise<void>
  replyText: (replyToMsgId: string, text: string, replyInThread?: boolean) => Promise<ReplyResult>
  sendText: (chatId: string, text: string) => Promise<string>
}

export class LarkMessenger implements Messenger {
  constructor(
    private readonly client: lark.Client,
    private readonly logger: Logger = noopLogger,
    private readonly botId = '',
  ) {}

  async sendCard(chatId: string, card: CardJSON): Promise<string> {
    const res = await this.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    })
    assertSuccess('sendCard', res)
    const messageId = res.data?.message_id ?? ''
    this.logger.info(
      'Sent Lark card',
      compactFields({
        botId: this.botId,
        chatId,
        messageId,
        cardTitle: card.header.title.content,
        cardSubtitle: card.header.subtitle?.content,
      }),
    )
    return messageId
  }

  async replyCard(
    replyToMsgId: string,
    card: CardJSON,
    replyInThread = false,
  ): Promise<ReplyResult> {
    const res = await this.client.im.v1.message.reply({
      path: { message_id: replyToMsgId },
      data: {
        msg_type: 'interactive',
        content: JSON.stringify(card),
        reply_in_thread: replyInThread,
      },
    })
    assertSuccess('replyCard', res)
    const result = {
      messageId: res.data?.message_id ?? '',
      threadId: res.data?.thread_id ?? '',
    }
    this.logger.info(
      'Replied Lark card',
      compactFields({
        botId: this.botId,
        replyToMsgId,
        replyInThread,
        messageId: result.messageId,
        threadId: result.threadId,
        cardTitle: card.header.title.content,
        cardSubtitle: card.header.subtitle?.content,
      }),
    )
    return result
  }

  async updateCard(messageId: string, card: CardJSON): Promise<void> {
    const res = await this.client.im.v1.message.patch({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify(card),
      },
    })
    assertSuccess('updateCard', res)
    this.logger.info(
      'Updated Lark card',
      compactFields({
        botId: this.botId,
        messageId,
        cardTitle: card.header.title.content,
        cardSubtitle: card.header.subtitle?.content,
      }),
    )
  }

  async replyText(replyToMsgId: string, text: string, replyInThread = false): Promise<ReplyResult> {
    const res = await this.client.im.v1.message.reply({
      path: { message_id: replyToMsgId },
      data: {
        msg_type: 'text',
        content: JSON.stringify({ text }),
        reply_in_thread: replyInThread,
      },
    })
    assertSuccess('replyText', res)
    const result = {
      messageId: res.data?.message_id ?? '',
      threadId: res.data?.thread_id ?? '',
    }
    this.logger.info(
      'Replied Lark text',
      compactFields({
        botId: this.botId,
        replyToMsgId,
        replyInThread,
        messageId: result.messageId,
        threadId: result.threadId,
        text: previewText(text),
      }),
    )
    return result
  }

  async sendText(chatId: string, text: string): Promise<string> {
    const res = await this.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    })
    assertSuccess('sendText', res)
    const messageId = res.data?.message_id ?? ''
    this.logger.info(
      'Sent Lark text',
      compactFields({
        botId: this.botId,
        chatId,
        messageId,
        text: previewText(text),
      }),
    )
    return messageId
  }
}

function assertSuccess(op: string, res: { code?: number; msg?: string } | undefined): void {
  if (res && res.code !== undefined && res.code !== 0)
    throw new Error(`Lark ${op} failed: code=${res.code} msg=${res.msg ?? ''}`)
}

function previewText(text: string, maxLen = 200): string {
  const singleLine = text.replace(/\s+/g, ' ').trim()
  const chars = Array.from(singleLine)
  return chars.length > maxLen ? `${chars.slice(0, maxLen).join('')}...` : singleLine
}

function compactFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== '') out[k] = v
  }
  return out
}
