import { describe, expect, it } from 'bun:test'
import { buildPresetPrompt } from '../src/cursor/prompt.ts'

describe('bot preset prompt', () => {
  it.each([undefined, '', ' \n\t '])(
    'preserves user input without preset instructions (%j)',
    (preset) => {
      const prompt = '  Investigate this failure.\nKeep the reproduction.  '
      expect(buildPresetPrompt(prompt, preset)).toBe(prompt)
    },
  )

  it('prefixes multiline bot instructions without changing the user message', () => {
    expect(
      buildPresetPrompt('  Fix the API.\n', '  Answer in Chinese.\nAdd regression tests.  '),
    ).toBe(
      '[Bot Instructions]\nAnswer in Chinese.\nAdd regression tests.\n\n[User Message]\n  Fix the API.\n',
    )
  })
})
