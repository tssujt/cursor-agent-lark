export type CommandAction =
  | 'help'
  | 'create'
  | 'status'
  | 'list'
  | 'cancel'
  | 'followup'
  | 'steer'
  | 'models'
  | 'repos'

export interface ParsedCommand {
  action: CommandAction
  taskId: string
  repo: string
  branch: string
  model: string
  mode?: 'agent' | 'plan'
  name: string
  autoCreatePR?: boolean
  prompt: string
  rawText: string
  isStructured: boolean
}

const MENTION_RE = /@_user_\d+\s*/g

export function stripMentions(text: string): string {
  return text.replace(MENTION_RE, '').trim()
}

export function parseCommand(rawText: string): ParsedCommand {
  const text = stripMentions(rawText)
  if (!text) return emptyCommand('help', text)

  const nlIdx = text.indexOf('\n')
  const firstLine = nlIdx >= 0 ? text.slice(0, nlIdx) : text
  const restLines = nlIdx >= 0 ? text.slice(nlIdx + 1) : ''
  const fields = firstLine.trim().split(/\s+/).filter(Boolean)
  const firstToken = fields[0]?.toLowerCase() ?? ''

  switch (firstToken) {
    case '/help':
    case 'help':
      return emptyCommand('help', text)
    case '/list':
    case '/tasks':
    case 'list':
      return emptyCommand('list', text)
    case '/models':
    case 'models':
      return emptyCommand('models', text)
    case '/repos':
    case 'repos':
      return emptyCommand('repos', text)
    case '/status':
    case 'status':
      return {
        ...emptyCommand('status', text),
        taskId: fields[1] ?? '',
      }
    case '/cancel':
    case '/stop':
    case 'cancel':
      return {
        ...emptyCommand('cancel', text),
        taskId: fields[1] ?? '',
      }
    case '/followup':
    case '/reply':
    case '/continue':
      return parseFollowUp('followup', fields.slice(1), restLines, text)
    case '/steer':
    case 'steer':
      return parseFollowUp('steer', fields.slice(1), restLines, text)
    case '/new':
    case '/create':
    case '/run': {
      const body = text.slice(fields[0]!.length).trim()
      return parseCreateBody(body, text)
    }
    default:
      return parseCreateBody(text, text)
  }
}

function emptyCommand(action: CommandAction, rawText: string): ParsedCommand {
  return {
    action,
    taskId: '',
    repo: '',
    branch: '',
    model: '',
    name: '',
    prompt: '',
    rawText,
    isStructured: false,
  }
}

function parseFollowUp(
  action: 'followup' | 'steer',
  firstLineArgs: string[],
  restLines: string,
  rawText: string,
): ParsedCommand {
  const cmd = emptyCommand(action, rawText)
  const parts: string[] = []
  const firstArg = firstLineArgs[0]
  if (firstArg && isTaskOrAgentId(firstArg)) {
    cmd.taskId = firstArg
    if (firstLineArgs.length > 1) parts.push(firstLineArgs.slice(1).join(' '))
  } else if (firstLineArgs.length > 0) {
    parts.push(firstLineArgs.join(' '))
  }
  if (restLines.trim()) parts.push(restLines.trim())
  cmd.prompt = parts.join('\n').trim()
  return cmd
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isTaskOrAgentId(token: string): boolean {
  const lower = token.toLowerCase()
  return lower.startsWith('task-') || lower.startsWith('bc-') || UUID_RE.test(lower)
}

function parseCreateBody(body: string, rawText: string): ParsedCommand {
  const cmd = emptyCommand('create', rawText)
  const lines = body.split('\n')
  const promptLines: string[] = []
  let inTaskSection = false
  let matchedHeaders = 0

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      if (inTaskSection && promptLines.length > 0) promptLines.push('')
      continue
    }

    if (!inTaskSection) {
      const kv = splitKeyValue(trimmed)
      if (kv) {
        const key = kv.key.toLowerCase()
        switch (key) {
          case 'repo':
          case 'repos':
          case 'repository':
          case 'repositories':
            cmd.repo = kv.val
            matchedHeaders++
            continue
          case 'branch':
          case 'ref':
            cmd.branch = kv.val
            matchedHeaders++
            continue
          case 'model':
            cmd.model = kv.val
            matchedHeaders++
            continue
          case 'mode': {
            const m = kv.val.toLowerCase()
            if (m === 'plan' || m === 'agent') cmd.mode = m
            matchedHeaders++
            continue
          }
          case 'name':
          case 'title':
            cmd.name = kv.val
            matchedHeaders++
            continue
          case 'pr':
          case 'autopr':
          case 'auto_pr': {
            const parsed = parseBool(kv.val)
            if (parsed !== undefined) cmd.autoCreatePR = parsed
            matchedHeaders++
            continue
          }
          case 'task':
          case 'prompt':
            inTaskSection = true
            matchedHeaders++
            if (kv.val) promptLines.push(kv.val)
            continue
        }
      }
    }

    promptLines.push(trimmed)
  }

  cmd.isStructured = matchedHeaders > 0
  cmd.prompt = promptLines.join('\n').trim()
  return cmd
}

function splitKeyValue(line: string): { key: string; val: string } | null {
  const idx = line.indexOf(':')
  if (idx <= 0) return null

  const key = line.slice(0, idx).trim()
  if (key.toLowerCase() === 'http' || key.toLowerCase() === 'https') return null
  if (key.length > 24 || /\s/.test(key)) return null

  return {
    key,
    val: line.slice(idx + 1).trim(),
  }
}

function parseBool(val: string): boolean | undefined {
  switch (val.trim().toLowerCase()) {
    case 'true':
    case 'yes':
    case 'y':
    case '1':
      return true
    case 'false':
    case 'no':
    case 'n':
    case '0':
      return false
    default:
      return undefined
  }
}
