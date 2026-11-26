import * as lark from '@larksuiteoapi/node-sdk'
import type { LarkBotConfig } from '../config.ts'
import type { Logger } from '../logger.ts'
import type { CardJSON } from './cards.ts'
import type { Messenger } from './messenger.ts'
import { noopLogger } from '../logger.ts'
import { LarkMessenger } from './messenger.ts'

export interface LarkMessageEvent {
  botId: string
  eventId: string
  messageId: string
  rootId: string
  parentId: string
  threadId: string
  chatId: string
  chatType: string
  senderId: string
  text: string
  mentioned: boolean
}

export interface LarkCardEvent {
  botId: string
  operatorOpenId: string
  chatId: string
  messageId: string
  actionValue: Record<string, unknown>
  formValue: Record<string, unknown>
  inputValue?: string
}

export interface LarkCardReply {
  toastType?: 'success' | 'info' | 'warning' | 'error'
  toastText?: string
  card?: CardJSON
}

export interface LarkBotHandlers {
  onMessage: (event: LarkMessageEvent) => Promise<void>
  onCardAction: (event: LarkCardEvent) => Promise<LarkCardReply>
}

export class LarkBot {
  readonly id: string
  readonly name: string
  readonly config: LarkBotConfig
  readonly messenger: Messenger
  private readonly client: lark.Client
  private readonly wsClient: lark.WSClient
  private readonly eventDispatcher: lark.EventDispatcher
  private readonly logger: Logger

  constructor(cfg: LarkBotConfig, handlers: LarkBotHandlers, logger: Logger = noopLogger) {
    this.id = cfg.id
    this.name = cfg.name
    this.config = cfg
    this.logger = logger
    const domain = cfg.domain === 'feishu' ? lark.Domain.Feishu : lark.Domain.Lark
    const loggerLevel = parseLarkLogLevel(cfg.logLevel)

    this.client = new lark.Client({
      appId: cfg.appId,
      appSecret: cfg.appSecret,
      domain,
      loggerLevel,
    })
    this.messenger = new LarkMessenger(this.client, this.logger, this.id)

    this.eventDispatcher = new lark.EventDispatcher({
      verificationToken: cfg.verificationToken || undefined,
      encryptKey: cfg.encryptKey || undefined,
      loggerLevel,
    }).register({
      'im.message.receive_v1': async (data) => {
        if (!data?.message) return
        const messageId = data.message.message_id ?? ''
        const chatId = data.message.chat_id ?? ''
        const chatType = data.message.chat_type ?? ''
        const messageType = data.message.message_type ?? ''
        if (data.sender?.sender_type === 'bot') {
          this.logger.debug('Ignoring Lark message from bot', {
            botId: this.id,
            messageId,
            chatId,
          })
          return
        }

        const text = extractMessageText(messageType, data.message.content)
        if (!text) {
          this.logger.info('Ignoring unsupported or empty Lark message', {
            botId: this.id,
            messageId,
            chatId,
            chatType,
            messageType,
          })
          return
        }

        const senderId = data.sender?.sender_id?.open_id ?? data.sender?.sender_id?.user_id ?? ''
        const rawEvent = data as unknown as { event_id?: string }
        const ev: LarkMessageEvent = {
          botId: this.id,
          eventId: rawEvent.event_id ?? '',
          messageId,
          rootId: data.message.root_id ?? '',
          parentId: data.message.parent_id ?? '',
          threadId: data.message.thread_id ?? '',
          chatId,
          chatType,
          senderId,
          text,
          mentioned: Array.isArray(data.message.mentions) && data.message.mentions.length > 0,
        }

        this.logger.info(
          'Received Lark message',
          compactFields({
            botId: this.id,
            eventId: ev.eventId,
            messageId: ev.messageId,
            chatId: ev.chatId,
            chatType: ev.chatType,
            threadId: ev.threadId,
            rootId: ev.rootId,
            parentId: ev.parentId,
            senderId: ev.senderId,
            messageType,
            mentioned: ev.mentioned,
            text: previewText(ev.text),
          }),
        )

        // Return immediately to ack the Lark WS frame; process Cursor API calls asynchronously.
        void handlers.onMessage(ev).catch((err) => {
          this.logger.error('Failed to handle Lark message', {
            botId: this.id,
            messageId: ev.messageId,
            error: err instanceof Error ? err.message : String(err),
          })
        })
      },
      'card.action.trigger': async (data: unknown) => {
        const raw = data as {
          operator?: { open_id?: string }
          context?: { open_chat_id?: string; open_message_id?: string }
          open_chat_id?: string
          open_message_id?: string
          action?: {
            value?: Record<string, unknown>
            form_value?: Record<string, unknown> | string
            input_value?: string
          }
        }

        const cardEvent: LarkCardEvent = {
          botId: this.id,
          operatorOpenId: raw.operator?.open_id ?? '',
          chatId: raw.context?.open_chat_id ?? raw.open_chat_id ?? '',
          messageId: raw.context?.open_message_id ?? raw.open_message_id ?? '',
          actionValue: raw.action?.value ?? {},
          formValue: parseFormValue(raw.action?.form_value),
          inputValue: typeof raw.action?.input_value === 'string' ? raw.action.input_value : '',
        }
        const actionName =
          typeof cardEvent.actionValue.action === 'string' ? cardEvent.actionValue.action : ''
        this.logger.info(
          'Received Lark card action',
          compactFields({
            botId: this.id,
            operatorOpenId: cardEvent.operatorOpenId,
            chatId: cardEvent.chatId,
            messageId: cardEvent.messageId,
            action: actionName,
          }),
        )

        const reply = await handlers.onCardAction(cardEvent)
        this.logger.info(
          'Handled Lark card action',
          compactFields({
            botId: this.id,
            messageId: cardEvent.messageId,
            action: actionName,
            toastType: reply.toastType,
            toastText: reply.toastText,
          }),
        )

        const resp: Record<string, unknown> = {}
        if (reply.toastText) {
          resp.toast = {
            type: reply.toastType ?? 'info',
            content: reply.toastText,
          }
        }
        if (reply.card) {
          resp.card = {
            type: 'raw',
            data: reply.card,
          }
        }
        return resp
      },
    })

    this.wsClient = new lark.WSClient({
      appId: cfg.appId,
      appSecret: cfg.appSecret,
      domain,
      loggerLevel,
    })
  }

  async start(): Promise<void> {
    this.logger.info('Starting Lark WebSocket long connection', {
      botId: this.id,
      domain: this.config.domain,
    })
    await this.wsClient.start({
      eventDispatcher: this.eventDispatcher,
    })
  }

  stop(): void {
    this.wsClient.close({ force: true })
  }
}

export function extractMessageText(
  msgType: string | undefined,
  content: string | undefined,
): string {
  if (!content) return ''
  try {
    if (msgType === 'text') {
      const parsed = JSON.parse(content) as { text?: string }
      return parsed.text?.trim() ?? ''
    }
    if (msgType === 'post') {
      const parsed = JSON.parse(content) as {
        title?: string
        content?: Array<Array<{ tag?: string; text?: string }>>
      }
      const lines: string[] = []
      if (parsed.title?.trim()) lines.push(parsed.title.trim())
      for (const para of parsed.content ?? []) {
        const line = para
          .filter((el) => el.tag === 'text' || el.tag === 'a')
          .map((el) => el.text ?? '')
          .join('')
          .trim()
        if (line) lines.push(line)
      }
      return lines.join('\n')
    }
  } catch {
    return ''
  }
  return ''
}

function parseFormValue(
  raw: Record<string, unknown> | string | undefined,
): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {}
    } catch {
      return {}
    }
  }
  return raw
}

function parseLarkLogLevel(level: LarkBotConfig['logLevel']): lark.LoggerLevel {
  switch (level) {
    case 'debug':
      return lark.LoggerLevel.debug
    case 'warn':
      return lark.LoggerLevel.warn
    case 'error':
      return lark.LoggerLevel.error
    default:
      return lark.LoggerLevel.info
  }
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
