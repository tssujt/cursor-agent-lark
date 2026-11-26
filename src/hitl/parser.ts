import type { QuestionOption } from '../store/types.ts'

export interface ParsedQuestion {
  question: string
  options: QuestionOption[]
  allowCustomInput?: boolean
  customInputPlaceholder?: string
}

export function buildHitlPrompt(
  userPrompt: string,
  agentId: string,
  options: { useMcp: boolean; enablePromptFallback: boolean },
): string {
  const sections = [userPrompt.trim()]

  if (options.useMcp) {
    sections.push(`[Human-in-the-Loop Instructions]
Agent ID: ${agentId}
When you encounter an ambiguous requirement or decision that requires confirmation from the Lark user:
1. Call the \`ask_user\` MCP tool with a clear question and optional choices (a custom free-text input option is automatically appended as the last item in the Lark card, so do not add an "Other" option yourself).
2. After submitting the question, do not guess the answer.
3. Finish any independent work first; if remaining work depends on the answer, end the current run.
4. Once the user responds in Lark, their confirmed answer will arrive in a follow-up run so you can continue.`)
  } else if (options.enablePromptFallback) {
    sections.push(`[Human-in-the-Loop Instructions]
When you encounter an ambiguous requirement or decision that requires confirmation from the user:
1. Do not guess the answer; finish any independent work first.
2. End the current run and append a fenced JSON block at the end of your final reply (a custom free-text input option is automatically appended as the last item in the Lark card, so do not add an "Other" option yourself):
\`\`\`json
{
  "type": "question",
  "question": "Clear question for the user",
  "options": [
    {"label": "Display label", "value": "option_value"}
  ]
}
\`\`\`
3. Once the user confirms in Lark, their answer will arrive in a follow-up run so you can continue.
If no confirmation is needed, complete the task normally and do not output a "type": "question" JSON block.`)
  }

  return sections.join('\n\n---\n\n')
}

export function buildAnswerFollowUp(
  questionId: string,
  questionText: string,
  answer: string,
): string {
  return `Regarding question ${questionId} (${questionText.trim()}), the user confirmed: ${answer.trim()}.\nPlease continue the previous task based on this decision.`
}

const FENCED_JSON_RE = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/g

export function extractQuestionFromResult(result: string): ParsedQuestion | null {
  const trimmed = result.trim()
  if (!trimmed) return null

  // 1. Prefer the last valid fenced JSON question block
  const matches = Array.from(trimmed.matchAll(FENCED_JSON_RE))
  for (let i = matches.length - 1; i >= 0; i--) {
    const candidate = matches[i]?.[1]
    if (candidate) {
      const parsed = parseQuestionJson(candidate)
      if (parsed) return parsed
    }
  }

  // 2. Whole text is a JSON object
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const parsed = parseQuestionJson(trimmed)
    if (parsed) return parsed
  }

  // 3. Trailing raw JSON object
  const idx = trimmed.lastIndexOf('{"type"')
  if (idx >= 0) {
    const candidate = trimmed.slice(idx)
    const end = findMatchingBrace(candidate)
    if (end > 0) {
      const parsed = parseQuestionJson(candidate.slice(0, end + 1))
      if (parsed) return parsed
    }
  }

  return null
}

function parseQuestionJson(raw: string): ParsedQuestion | null {
  try {
    const obj = JSON.parse(raw) as {
      type?: unknown
      question?: unknown
      options?: unknown
      allow_custom_input?: unknown
      custom_input_placeholder?: unknown
    }
    if (typeof obj.type !== 'string' || obj.type.trim().toLowerCase() !== 'question') return null
    if (typeof obj.question !== 'string' || !obj.question.trim()) return null
    const parsed: ParsedQuestion = {
      question: obj.question.trim(),
      options: normalizeOptions(obj.options),
    }
    if (typeof obj.allow_custom_input === 'boolean')
      parsed.allowCustomInput = obj.allow_custom_input
    if (typeof obj.custom_input_placeholder === 'string' && obj.custom_input_placeholder.trim())
      parsed.customInputPlaceholder = obj.custom_input_placeholder.trim()
    return parsed
  } catch {
    return null
  }
}

export function normalizeOptions(raw: unknown): QuestionOption[] {
  if (!Array.isArray(raw)) return []
  const out: QuestionOption[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      const s = item.trim()
      if (s) out.push({ label: s, value: s })
      continue
    }
    if (item && typeof item === 'object') {
      const rec = item as { label?: unknown; value?: unknown }
      const label = typeof rec.label === 'string' ? rec.label.trim() : ''
      const value = typeof rec.value === 'string' ? rec.value.trim() : ''
      const finalLabel = label || value
      const finalValue = value || label
      if (finalLabel) out.push({ label: finalLabel, value: finalValue })
    }
  }
  return out
}

function findMatchingBrace(s: string): number {
  let depth = 0
  let inStr = false
  let escaped = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') {
      inStr = true
    } else if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}
