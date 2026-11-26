import type { AgentRuntime } from '../cursor/types.ts'

export type TaskStatus =
  | 'CREATING'
  | 'RUNNING'
  | 'WAITING_USER'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'

export interface QuestionOption {
  label: string
  value: string
}

/**
 * Session routing context persisted in Cursor `cloud.metadata` (for cloud runtime),
 * signed MCP URLs, and Lark card callback payloads.
 */
export interface SessionContext {
  botId: string
  chatId: string
  chatType: string
  rootMsgId: string
  userId: string
  agentId: string
  runtime?: AgentRuntime
  cwd?: string
}

/**
 * View model rendered onto Lark task status cards.
 */
export interface TaskView {
  agentId: string
  runtime?: AgentRuntime
  agentUrl: string
  botId: string
  runId: string
  runStatus: string
  taskStatus: TaskStatus
  name: string
  prompt: string
  repoUrl: string
  cwd?: string
  branch: string
  model: string
  larkChatId: string
  larkChatType: string
  larkUserId: string
  larkRootMsgId: string
  larkCardMsgId: string
  lastResult: string
  prUrl: string
  pushedBranch: string
  durationMs: number
  errorMessage: string
}

/**
 * View model rendered onto Lark HITL question cards.
 */
export interface QuestionView {
  questionId: string
  agentId: string
  runtime?: AgentRuntime
  cwd?: string
  botId: string
  larkChatId: string
  larkChatType: string
  larkRootMsgId: string
  larkUserId: string
  larkMsgId: string
  question: string
  options: QuestionOption[]
  allowCustomInput?: boolean
  customInputPlaceholder?: string
}
