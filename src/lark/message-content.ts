export function extractMessageText(
  msgType: string | undefined,
  content: string | undefined,
): string {
  if (!content) return ''
  try {
    const parsed = JSON.parse(content) as unknown
    if (msgType === 'text') {
      const rec = parsed as { text?: unknown }
      return typeof rec?.text === 'string' ? rec.text.trim() : ''
    }
    if (msgType === 'post') {
      return extractPostText(parsed)
    }
    if (msgType === 'interactive') {
      return extractInteractiveCardText(parsed)
    }
  } catch {
    return ''
  }
  return ''
}

function extractPostText(parsed: unknown): string {
  if (!parsed || typeof parsed !== 'object') return ''
  const rec = parsed as Record<string, unknown>

  // `im.v1.message.get` may wrap post content in a locale key (e.g. `zh_cn`, `en_us`).
  const body =
    Array.isArray(rec.content) || typeof rec.title === 'string'
      ? rec
      : (Object.values(rec).find(
          (v) => v && typeof v === 'object' && Array.isArray((v as { content?: unknown }).content),
        ) as Record<string, unknown> | undefined)
  if (!body) return ''

  const lines: string[] = []
  if (typeof body.title === 'string' && body.title.trim()) lines.push(body.title.trim())
  const paragraphs = Array.isArray(body.content) ? body.content : []
  for (const para of paragraphs) {
    if (!Array.isArray(para)) continue
    const line = para
      .filter(
        (el): el is { tag?: string; text?: string } =>
          Boolean(el) &&
          typeof el === 'object' &&
          ((el as { tag?: string }).tag === 'text' || (el as { tag?: string }).tag === 'a'),
      )
      .map((el) => el.text ?? '')
      .join('')
      .trim()
    if (line) lines.push(line)
  }
  return lines.join('\n')
}

function extractInteractiveCardText(parsed: unknown): string {
  if (!parsed || typeof parsed !== 'object') return ''
  const rec = parsed as Record<string, unknown>
  const lines: string[] = []

  if (typeof rec.title === 'string' && rec.title.trim()) {
    lines.push(rec.title.trim())
  }
  if (rec.header && typeof rec.header === 'object') {
    const header = rec.header as {
      title?: { content?: unknown }
      subtitle?: { content?: unknown }
    }
    if (typeof header.title?.content === 'string' && header.title.content.trim()) {
      lines.push(header.title.content.trim())
    }
    if (typeof header.subtitle?.content === 'string' && header.subtitle.content.trim()) {
      lines.push(header.subtitle.content.trim())
    }
  }

  const bodyElements =
    rec.body && typeof rec.body === 'object'
      ? (rec.body as { elements?: unknown }).elements
      : rec.elements
  collectCardElements(bodyElements, lines)

  return lines.join('\n').trim()
}

function collectCardElements(node: unknown, out: string[]): void {
  if (!node) return
  if (Array.isArray(node)) {
    // Lark `im.v1.message.get` represents interactive card paragraphs as nested inline arrays:
    // `[[{ tag: "text", text: "..." }, { tag: "a", text: "..." }]]`
    if (
      node.length > 0 &&
      node.every(
        (el) =>
          el &&
          typeof el === 'object' &&
          !Array.isArray(el) &&
          typeof (el as { text?: unknown }).text === 'string',
      )
    ) {
      const line = (node as Array<{ tag?: string; text?: string }>)
        .filter((el) => el.tag !== 'button')
        .map((el) => el.text ?? '')
        .join('')
        .trim()
      if (line) out.push(line)
      return
    }
    for (const item of node) collectCardElements(item, out)
    return
  }

  if (typeof node !== 'object') return
  const rec = node as Record<string, unknown>
  const tag = typeof rec.tag === 'string' ? rec.tag : ''
  if (tag === 'button' || tag === 'action' || tag === 'hr' || tag === 'img') return

  if (typeof rec.content === 'string' && rec.content.trim()) {
    out.push(rec.content.trim())
  }
  if (typeof rec.text === 'string' && rec.text.trim()) {
    out.push(rec.text.trim())
  } else if (rec.text && typeof rec.text === 'object') {
    const content = (rec.text as { content?: unknown }).content
    if (typeof content === 'string' && content.trim()) out.push(content.trim())
  }

  if (Array.isArray(rec.fields)) {
    for (const field of rec.fields) collectCardElements(field, out)
  }
  if (Array.isArray(rec.elements)) {
    collectCardElements(rec.elements, out)
  }
  if (Array.isArray(rec.columns)) {
    for (const col of rec.columns) collectCardElements(col, out)
  }
}
