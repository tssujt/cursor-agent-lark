import type { QuestionOption } from '../store/types.ts'

export type AgentRuntime = 'cloud' | 'local'

export type LocalSettingSource = 'project' | 'user' | 'team' | 'mdm' | 'plugins' | 'all'

export type NormalizedRunStatus = 'running' | 'finished' | 'error' | 'cancelled'

export interface GitBranchSnapshot {
  repoUrl: string
  branch?: string
  prUrl?: string
}

export interface RunSnapshot {
  id: string
  agentId: string
  status: NormalizedRunStatus
  result?: string
  errorMessage?: string
  durationMs?: number
  branches: GitBranchSnapshot[]
}

export interface AgentSummary {
  agentId: string
  runtime: AgentRuntime
  agentUrl: string
  name: string
  summary: string
  status?: 'running' | 'finished' | 'error'
  repos: string[]
  cwd?: string
  metadata: Record<string, string>
  createdAt?: number
  lastModified: number
}

export type McpServerSpec =
  | {
      name: string
      type: 'http' | 'sse'
      url: string
      headers?: Record<string, string>
    }
  | {
      name: string
      type: 'stdio'
      command: string
      args?: string[]
      env?: Record<string, string>
    }

export interface LocalAskUserArgs {
  question: string
  options: QuestionOption[]
  allowCustomInput?: boolean
  customInputPlaceholder?: string
}

export interface LocalAskUserResponse {
  questionId: string
  agentId: string
  status: string
}

export type LocalAskUserCallback = (args: LocalAskUserArgs) => Promise<LocalAskUserResponse>

export interface CreateAgentInput {
  runtime?: AgentRuntime
  agentId?: string
  name?: string
  prompt: string
  // Cloud runtime options
  repoUrl?: string
  startingRef?: string
  autoCreatePR?: boolean
  workOnCurrentBranch?: boolean
  skipReviewerRequest?: boolean
  metadata?: Record<string, string>
  // Local runtime options
  cwd?: string
  dirs?: string[]
  sandbox?: boolean
  autoReview?: boolean
  settingSources?: LocalSettingSource[]
  onLocalAskUser?: LocalAskUserCallback
  // Shared options
  modelId?: string
  mode?: 'agent' | 'plan'
  mcpServers?: McpServerSpec[]
}

export type CreateCloudAgentInput = CreateAgentInput

export interface CreatedAgentRun {
  agentId: string
  runtime: AgentRuntime
  agentUrl: string
  name: string
  run: RunSnapshot
}

export interface SendFollowUpInput {
  agentId: string
  runtime?: AgentRuntime
  prompt: string
  modelId?: string
  mode?: 'agent' | 'plan'
  mcpServers?: McpServerSpec[]
  // Local runtime options (must be re-supplied on Agent.resume)
  cwd?: string
  dirs?: string[]
  sandbox?: boolean
  autoReview?: boolean
  settingSources?: LocalSettingSource[]
  onLocalAskUser?: LocalAskUserCallback
}

export interface RuntimeLookupOptions {
  runtime?: AgentRuntime
  cwd?: string
}

export interface SteerResult {
  delivery: 'steered' | 'queued' | 'unavailable'
  runId?: string
}

export interface CursorModelSummary {
  id: string
  displayName: string
  description?: string
}

export interface CursorKeyIdentity {
  apiKeyName: string
  userEmail?: string
}

export class CursorAgentBusyError extends Error {
  constructor(message = 'Cursor agent has an active run') {
    super(message)
    this.name = 'CursorAgentBusyError'
  }
}

export class CursorAgentConflictError extends Error {
  constructor(message = 'Cursor agent ID already exists') {
    super(message)
    this.name = 'CursorAgentConflictError'
  }
}

export function isCloudAgentId(agentId: string): boolean {
  return agentId.startsWith('bc-')
}

export function isTerminalRunStatus(status: string): boolean {
  const s = status.toLowerCase()
  return s === 'finished' || s === 'error' || s === 'cancelled' || s === 'expired'
}

export interface CursorClient {
  getMe: () => Promise<CursorKeyIdentity>
  listModels: () => Promise<CursorModelSummary[]>
  getAgent: (agentId: string, options?: RuntimeLookupOptions) => Promise<AgentSummary | null>
  listAgents: (limit?: number, options?: RuntimeLookupOptions) => Promise<AgentSummary[]>
  createAgentAndRun: (input: CreateAgentInput) => Promise<CreatedAgentRun>
  sendFollowUp: (input: SendFollowUpInput) => Promise<RunSnapshot>
  steerRun: (
    agentId: string,
    prompt: string,
    options?: RuntimeLookupOptions,
  ) => Promise<SteerResult>
  getRun: (agentId: string, runId: string, options?: RuntimeLookupOptions) => Promise<RunSnapshot>
  getLatestRun: (agentId: string, options?: RuntimeLookupOptions) => Promise<RunSnapshot | null>
  waitForRun: (
    agentId: string,
    runId: string,
    options: {
      signal: AbortSignal
      useSSE: boolean
      pollIntervalMs: number
      runtime?: AgentRuntime
      cwd?: string
      onStatus?: (status: NormalizedRunStatus) => void
    },
  ) => Promise<RunSnapshot>
  cancelRun: (agentId: string, runId: string, options?: RuntimeLookupOptions) => Promise<void>
}
