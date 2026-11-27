import { describe, expect, it } from 'bun:test'
import { isBotMentioned, normalizeMentionText } from '../src/lark/bot.ts'

describe('LarkBot mention detection', () => {
  const botIdentity = {
    openId: 'ou_bot_self',
    appName: 'Weather Prod Debug Agent',
    configName: 'Weather Bot',
  }

  it('returns true only when this bot open_id is mentioned', () => {
    expect(isBotMentioned([], botIdentity)).toBe(false)
    expect(
      isBotMentioned(
        [{ key: '@_user_1', id: { open_id: 'ou_colleague' }, name: 'Alice' }],
        botIdentity,
      ),
    ).toBe(false)
    expect(isBotMentioned([{ key: '@_all', id: {}, name: '所有人' }], botIdentity)).toBe(false)
    expect(
      isBotMentioned(
        [
          { key: '@_user_1', id: { open_id: 'ou_colleague' }, name: 'Alice' },
          { key: '@_user_2', id: { open_id: 'ou_bot_self' }, name: 'Weather Prod Debug Agent' },
        ],
        botIdentity,
      ),
    ).toBe(true)
  })

  it('falls back to exact bot name match only when open_id is unavailable', () => {
    const noOpenId = { configName: 'Weather Bot' }
    expect(
      isBotMentioned(
        [{ key: '@_user_1', id: { open_id: 'ou_colleague' }, name: 'Alice' }],
        noOpenId,
      ),
    ).toBe(false)
    expect(
      isBotMentioned(
        [{ key: '@_user_1', id: { open_id: 'ou_bot_self' }, name: 'Weather Bot' }],
        noOpenId,
      ),
    ).toBe(true)
  })

  it('strips self mention while preserving other user mentions as @Name', () => {
    const mentions = [
      { key: '@_user_1', id: { open_id: 'ou_bot_self' }, name: 'Weather Prod Debug Agent' },
      { key: '@_user_2', id: { open_id: 'ou_alice' }, name: 'Alice' },
      { key: '@_user_10', id: { open_id: 'ou_bob' }, name: 'Bob' },
    ]
    expect(
      normalizeMentionText(
        '@_user_1 帮我问下 @_user_2 和 @_user_10 这个报错',
        mentions,
        botIdentity,
      ),
    ).toBe('帮我问下 @Alice 和 @Bob 这个报错')

    expect(normalizeMentionText('@_user_1', [mentions[0]!], botIdentity)).toBe('')
  })
})
