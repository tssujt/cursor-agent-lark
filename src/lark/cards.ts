import type { CursorModelSummary } from '../cursor/types.ts'
import type { QuestionView, TaskStatus, TaskView } from '../store/types.ts'

export interface CardJSON {
  schema: '2.0'
  config: {
    wide_screen_mode: boolean
    update_multi?: boolean
  }
  header: {
    template: 'blue' | 'green' | 'orange' | 'red' | 'grey' | 'indigo'
    title: { tag: 'plain_text'; content: string }
    subtitle?: { tag: 'plain_text'; content: string }
  }
  body: {
    elements: Record<string, unknown>[]
  }
}

export function buildTaskCard(task: TaskView, note = ''): CardJSON {
  const { title, template, badge } = taskVisuals(task.taskStatus)

  const lines: string[] = []
  lines.push(`**Status**: ${badge}${task.runStatus ? ` (\`${task.runStatus}\`)` : ''}`)
  lines.push(`**Agent**: \`${task.agentId}\``)
  if (task.runtime === 'local') lines.push('**Runtime**: `local`')
  if (task.repoUrl)
    lines.push(
      `**Repository**: ${shortRepoName(task.repoUrl)}${task.branch ? ` (\`${task.branch}\`)` : ''}`,
    )
  if (task.cwd) lines.push(`**Workspace**: \`${task.cwd}\``)
  if (task.model) lines.push(`**Model**: \`${task.model}\``)
  if (task.pushedBranch) lines.push(`**Pushed Branch**: \`${task.pushedBranch}\``)
  if (task.prUrl) lines.push(`**Pull Request**: [View PR](${task.prUrl})`)
  if (task.durationMs > 0) lines.push(`**Duration**: ${formatDuration(task.durationMs)}`)

  if (task.prompt) lines.push('', '**Task Prompt**', truncate(task.prompt, 600))
  if (task.lastResult && task.taskStatus !== 'WAITING_USER')
    lines.push('', '**Summary**', truncate(task.lastResult, 1800))
  if (task.errorMessage) lines.push('', '**Error**', truncate(task.errorMessage, 600))
  if (note) lines.push('', note)

  const elements: Record<string, unknown>[] = [
    {
      tag: 'markdown',
      content: lines.join('\n'),
    },
  ]

  const buttons: Record<string, unknown>[] = []
  if (task.agentUrl) buttons.push(linkButton('Open Cursor Agent', task.agentUrl, 'default'))
  if (task.prUrl) buttons.push(linkButton('View PR', task.prUrl, 'primary'))
  if (
    task.taskStatus === 'CREATING' ||
    task.taskStatus === 'RUNNING' ||
    task.taskStatus === 'WAITING_USER'
  ) {
    buttons.push(
      callbackButton('Refresh', 'default', {
        action: 'refresh_task',
        agent_id: task.agentId,
        runtime: task.runtime ?? 'cloud',
        cwd: task.cwd ?? '',
        owner_id: task.larkUserId,
        root_msg_id: task.larkRootMsgId,
        chat_type: task.larkChatType,
      }),
    )
  }
  if (task.taskStatus === 'CREATING' || task.taskStatus === 'RUNNING') {
    buttons.push(
      callbackButton('Cancel', 'danger', {
        action: 'cancel_task',
        agent_id: task.agentId,
        runtime: task.runtime ?? 'cloud',
        cwd: task.cwd ?? '',
        owner_id: task.larkUserId,
        root_msg_id: task.larkRootMsgId,
        chat_type: task.larkChatType,
      }),
    )
  }

  if (buttons.length > 0) {
    elements.push({ tag: 'hr' })
    elements.push(buttonRow(buttons))
  }

  elements.push({
    tag: 'markdown',
    content:
      "<font color='grey'>Tip: Reply directly in this thread to continue the same Agent session, or run `/status` `/cancel`.</font>",
  })

  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template,
      title: { tag: 'plain_text', content: title },
      subtitle: {
        tag: 'plain_text',
        content: subtitleForTask(task),
      },
    },
    body: { elements },
  }
}

export function buildQuestionCard(task: TaskView, question: QuestionView): CardJSON {
  const headerMeta = [
    `**Agent**: \`${question.agentId}\``,
    task.repoUrl
      ? `**Repository**: ${shortRepoName(task.repoUrl)}`
      : task.cwd
        ? `**Workspace**: \`${task.cwd}\``
        : '',
  ]
    .filter(Boolean)
    .join('  |  ')

  const md = `${headerMeta}\n**Question ID**: \`${question.questionId}\`\n\n**Agent needs your confirmation:**\n${question.question}`

  const elements: Record<string, unknown>[] = [{ tag: 'markdown', content: md }]

  const baseValue = {
    question_id: question.questionId,
    agent_id: question.agentId,
    runtime: question.runtime ?? task.runtime ?? 'cloud',
    cwd: question.cwd ?? task.cwd ?? '',
    owner_id: question.larkUserId,
    root_msg_id: question.larkRootMsgId,
    chat_type: question.larkChatType,
    question: truncate(question.question, 300),
  }

  const showCustomInput = question.allowCustomInput !== false || question.options.length === 0

  if (question.options.length > 0 || showCustomInput) elements.push({ tag: 'hr' })

  if (question.options.length > 0) {
    for (const [idx, opt] of question.options.entries()) {
      elements.push({
        ...callbackButton(`${idx + 1}. ${opt.label}`, idx === 0 ? 'primary' : 'default', {
          ...baseValue,
          action: 'answer_question',
          answer: opt.value,
          label: opt.label,
        }),
        width: 'fill',
      })
    }
  }

  if (showCustomInput) {
    const customLabel =
      question.options.length > 0
        ? `${question.options.length + 1}. Other (custom answer)`
        : 'Your answer'
    const customPlaceholder = question.customInputPlaceholder?.trim() || 'Type your own answer...'
    const submitType = question.options.length === 0 ? 'primary' : 'default'

    elements.push({
      tag: 'form',
      name: 'custom_answer_form',
      direction: 'vertical',
      elements: [
        {
          tag: 'input',
          name: 'custom_answer',
          required: true,
          label: { tag: 'plain_text', content: customLabel },
          label_position: 'top',
          placeholder: { tag: 'plain_text', content: customPlaceholder },
          width: 'fill',
        },
        {
          tag: 'button',
          name: 'submit_custom_answer',
          type: submitType,
          form_action_type: 'submit',
          text: { tag: 'plain_text', content: 'Submit' },
          behaviors: [
            {
              type: 'callback',
              value: {
                ...baseValue,
                action: 'answer_question_custom',
              },
            },
          ],
        },
      ],
    })
  }

  elements.push({
    tag: 'markdown',
    content:
      "<font color='grey'>You can also reply directly in this thread to submit your answer.</font>",
  })

  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: 'Confirmation Needed (Waiting for Answer)' },
      subtitle: {
        tag: 'plain_text',
        content: subtitleForTask(task),
      },
    },
    body: { elements },
  }
}

export function buildQuestionAnsweredCard(
  agentId: string,
  agentUrl: string,
  questionId: string,
  questionText: string,
  answerDisplay: string,
  statusNote = '',
): CardJSON {
  const lines = [
    `**Agent**: \`${agentId}\`  |  **Question ID**: \`${questionId}\``,
    '',
    '**Question**:',
    questionText,
    '',
    `**Confirmed Answer**: ${answerDisplay}`,
  ]
  if (statusNote) lines.push('', statusNote)

  const elements: Record<string, unknown>[] = [
    {
      tag: 'markdown',
      content: lines.join('\n'),
    },
  ]
  if (agentUrl) {
    elements.push({ tag: 'hr' })
    elements.push(buttonRow([linkButton('Open Cursor Agent', agentUrl, 'default')]))
  }

  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: 'green',
      title: { tag: 'plain_text', content: 'Agent Resumed (Answer Confirmed)' },
      subtitle: { tag: 'plain_text', content: agentId },
    },
    body: { elements },
  }
}

export function buildTaskListCard(tasks: TaskView[]): CardJSON {
  const content =
    tasks.length === 0
      ? 'No tasks found in this chat yet.\n\nMention `@Bot` with a task description to create a Cursor Agent session.'
      : tasks
          .map((t) => {
            const { badge } = taskVisuals(t.taskStatus)
            const repo = shortRepoName(t.repoUrl) || t.cwd || 'no-repo'
            const prPart = t.prUrl ? ` · [PR](${t.prUrl})` : ''
            const title = truncate((t.name || t.prompt || t.agentId).replace(/\n+/g, ' '), 80)
            return `- **\`${t.agentId}\`** [${badge}] · ${repo}${prPart}\n  ${title}`
          })
          .join('\n')

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template: 'indigo',
      title: { tag: 'plain_text', content: 'Recent Sessions' },
    },
    body: {
      elements: [{ tag: 'markdown', content }],
    },
  }
}

export function buildModelsCard(models: CursorModelSummary[], defaultModel: string): CardJSON {
  const lines: string[] = [
    defaultModel
      ? `Default model: \`${defaultModel}\``
      : 'Default model: Cursor account / team default',
    '',
  ]
  if (models.length === 0) {
    lines.push('No models returned.')
  } else {
    for (const m of models) {
      const desc = m.description ? ` (${m.description})` : ''
      lines.push(`- **\`${m.id}\`** — ${m.displayName}${desc}`)
    }
  }

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template: 'indigo',
      title: { tag: 'plain_text', content: 'Available Cursor Models' },
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: lines.join('\n'),
        },
      ],
    },
  }
}

export function buildHelpCard(mcpEnabled: boolean, botName = 'Cursor Agent Bot'): CardJSON {
  const hitlMode = mcpEnabled
    ? 'MCP `ask_user` tool + Prompt-JSON fallback'
    : 'Prompt-JSON structured question'
  const content = `**1. Start a Session (Thread)**
Mention @Bot in a group chat (or DM directly) with structured fields or plain text:
\`\`\`
repo: backend
branch: main
mode: agent
task: Add caching to the query endpoint, add unit tests, and open a PR.
\`\`\`
Optional fields: \`repo\`, \`branch\`, \`model\`, \`mode (agent|plan)\`, \`pr (true|false)\`, \`name\`, \`task\`

**2. Follow-Up / Steer (One Thread = One Agent Session)**
- Starting a task in a group chat automatically opens a thread; send any message inside that thread to continue the same Agent (no need to @mention)
- \`/steer <instruction>\` — Steer the active run inside a thread (or latest session in a DM)
- \`/followup <instruction>\` — Send a follow-up inside a thread (or latest session in a DM)

**3. Answer Agent Questions (HITL)**
- Mode: ${hitlMode}
- Click an option button, submit the custom input at the bottom of the card, or reply directly in the thread

**4. Commands**
- \`/status\` — Refresh and show session status (inside a thread or latest in chat)
- \`/list\` — List recent sessions in this chat
- \`/cancel\` — Cancel the current session (or click Cancel on the card)
- \`/repos\` — List configured repository aliases
- \`/models\` — List available Cursor models
- \`/help\` — Show this help card`

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: botName },
    },
    body: {
      elements: [{ tag: 'markdown', content }],
    },
  }
}

function taskVisuals(status: TaskStatus): {
  title: string
  template: CardJSON['header']['template']
  badge: string
} {
  switch (status) {
    case 'CREATING':
      return { title: 'Session Created (Starting)', template: 'blue', badge: 'Creating' }
    case 'RUNNING':
      return { title: 'Session Running', template: 'blue', badge: 'Running' }
    case 'WAITING_USER':
      return { title: 'Waiting for Confirmation', template: 'orange', badge: 'Waiting' }
    case 'COMPLETED':
      return { title: 'Session Completed', template: 'green', badge: 'Completed' }
    case 'CANCELLED':
      return { title: 'Session Cancelled', template: 'grey', badge: 'Cancelled' }
    case 'FAILED':
      return { title: 'Session Failed', template: 'red', badge: 'Failed' }
  }
}

function subtitleForTask(task: TaskView | null): string {
  if (!task) return 'Cursor Agent'
  if (task.name) return truncate(task.name, 60)
  const repo = shortRepoName(task.repoUrl) || task.cwd || ''
  return repo || task.agentId
}

function callbackButton(
  label: string,
  type: 'primary' | 'default' | 'danger',
  value: Record<string, unknown>,
): Record<string, unknown> {
  return {
    tag: 'button',
    type,
    text: { tag: 'plain_text', content: label },
    behaviors: [{ type: 'callback', value }],
  }
}

function linkButton(
  label: string,
  url: string,
  type: 'primary' | 'default',
): Record<string, unknown> {
  return {
    tag: 'button',
    type,
    text: { tag: 'plain_text', content: label },
    behaviors: [{ type: 'open_url', default_url: url }],
  }
}

function buttonRow(buttons: Record<string, unknown>[]): Record<string, unknown> {
  return {
    tag: 'column_set',
    horizontal_spacing: '8px',
    columns: buttons.map((b) => ({
      tag: 'column',
      width: 'auto',
      elements: [b],
    })),
  }
}

function shortRepoName(repoUrl: string): string {
  return repoUrl
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\.git$/, '')
}

function truncate(s: string, maxChars: number): string {
  const chars = Array.from(s.trim())
  if (chars.length <= maxChars) return chars.join('')
  return `${chars.slice(0, maxChars).join('')}...`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}m${s}s`
}
