import { describe, expect, it } from 'bun:test'
import { extractQuestionFromResult } from '../src/hitl/parser.ts'

describe('HITL question parser', () => {
  it('extracts fenced JSON question with string options', () => {
    const result =
      'Please confirm cache TTL:\n\n```json\n{\n  "type": "question",\n  "question": "What TTL should be used?",\n  "options": ["5m", "10m", "30m"]\n}\n```'
    const parsed = extractQuestionFromResult(result)
    expect(parsed).not.toBeNull()
    expect(parsed?.question).toBe('What TTL should be used?')
    expect(parsed?.options).toEqual([
      { label: '5m', value: '5m' },
      { label: '10m', value: '10m' },
      { label: '30m', value: '30m' },
    ])
  })

  it('extracts raw JSON question with label/value options and custom input settings', () => {
    const result =
      '{"type":"question","question":"Cache expiration policy?","options":[{"label":"5 minutes","value":"300"},{"label":"10 minutes","value":"600"}],"allow_custom_input":true,"custom_input_placeholder":"Enter TTL in seconds"}'
    const parsed = extractQuestionFromResult(result)
    expect(parsed).toEqual({
      question: 'Cache expiration policy?',
      options: [
        { label: '5 minutes', value: '300' },
        { label: '10 minutes', value: '600' },
      ],
      allowCustomInput: true,
      customInputPlaceholder: 'Enter TTL in seconds',
    })
  })

  it('ignores non-question JSON blocks', () => {
    const result = 'Done.\n```json\n{"type":"summary","files":3}\n```'
    expect(extractQuestionFromResult(result)).toBeNull()
  })
})
