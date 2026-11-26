import { existsSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { z } from 'zod'
import type { AgentRuntime, LocalSettingSource, McpServerSpec } from './cursor/types.ts'

export interface RepoConfig {
  url: string
  path?: string
  defaultBranch?: string
  allowedUsers: string[]
}

export interface McpServerConfigEntry {
  type?: 'http' | 'sse' | 'stdio'
  url?: string
  headers?: Record<string, string>
  command?: string
  args?: string[]
  env?: Record<string, string>
  enabled?: boolean
}

export interface LarkBotConfig {
  id: string
  name: string
  appId: string
  appSecret: string
  domain: 'feishu' | 'lark'
  verificationToken: string
  encryptKey: string
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  // Optional per-bot overrides (inherit global defaults when undefined)
  requireMention?: boolean
  runtime?: AgentRuntime
  cwd?: string
  dirs?: string[]
  sandbox?: boolean
  autoReview?: boolean
  settingSources?: LocalSettingSource[]
  cursorApiKey?: string
  defaultModel?: string
  presetPrompt?: string
  defaultMode?: 'agent' | 'plan'
  autoCreatePR?: boolean
  workOnCurrentBranch?: boolean
  skipReviewerRequest?: boolean
  defaultRepo?: string
  allowUnlistedRepos?: boolean
  allowNoRepo?: boolean
  allowedUsers?: string[]
  repoAliases?: Record<string, RepoConfig>
  mcpServers?: Record<string, McpServerConfigEntry>
}

export interface GatewayConfig {
  bots: LarkBotConfig[]
  cursor: {
    runtime: AgentRuntime
    apiKey: string
    baseUrl: string
    defaultModel: string
    defaultMode: 'agent' | 'plan'
    autoCreatePR: boolean
    workOnCurrentBranch: boolean
    skipReviewerRequest: boolean
    enableSteer: boolean
    useSSE: boolean
    pollIntervalMs: number
    requestTimeoutMs: number
    local: {
      cwd: string
      dirs: string[]
      sandbox?: boolean
      autoReview?: boolean
      settingSources: LocalSettingSource[]
    }
  }
  server: {
    port: number
    hostname: string
  }
  mcp: {
    publicUrl: string
    authToken: string
    serverName: string
    servers: Record<string, McpServerConfigEntry>
  }
  hitl: {
    enablePromptFallback: boolean
    allowAnyChatMemberAnswer: boolean
  }
  auth: {
    allowedUsers: string[]
  }
  repos: {
    defaultRepo: string
    allowUnlistedRepos: boolean
    allowNoRepo: boolean
    aliases: Record<string, RepoConfig>
  }
}

const runtimeSchema = z.enum(['cloud', 'local'])
const settingSourceSchema = z.enum(['project', 'user', 'team', 'mdm', 'plugins', 'all'])

const repoAliasSchema = z.object({
  url: z.string().optional(),
  path: z.string().optional(),
  default_branch: z.string().optional(),
  allowed_users: z.array(z.string()).optional(),
})

const mcpServerEntrySchema = z
  .object({
    type: z.enum(['http', 'sse', 'stdio']).optional(),
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()

const rawBotSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    app_id: z.string().optional(),
    app_secret: z.string().optional(),
    domain: z.enum(['feishu', 'lark']).optional(),
    verification_token: z.string().optional(),
    encrypt_key: z.string().optional(),
    log_level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
    require_mention: z.boolean().optional(),
    runtime: runtimeSchema.optional(),
    cwd: z.string().optional(),
    dirs: z.array(z.string()).optional(),
    sandbox: z.boolean().optional(),
    auto_review: z.boolean().optional(),
    setting_sources: z.array(settingSourceSchema).optional(),
    cursor_api_key: z.string().optional(),
    default_model: z.string().optional(),
    preset_prompt: z.string().optional(),
    default_mode: z.enum(['agent', 'plan']).optional(),
    auto_create_pr: z.boolean().optional(),
    work_on_current_branch: z.boolean().optional(),
    skip_reviewer_request: z.boolean().optional(),
    default_repo: z.string().optional(),
    allow_unlisted_repos: z.boolean().optional(),
    allow_no_repo: z.boolean().optional(),
    allowed_users: z.array(z.string()).optional(),
    repos: z
      .object({
        aliases: z.record(z.string(), repoAliasSchema).optional(),
      })
      .optional(),
    mcp_servers: z.record(z.string(), mcpServerEntrySchema).optional(),
  })
  .strict()

const rawConfigSchema = z
  .object({
    bots: z.array(rawBotSchema).optional(),
    cursor: z
      .object({
        runtime: runtimeSchema.optional(),
        api_key: z.string().optional(),
        base_url: z.string().optional(),
        default_model: z.string().optional(),
        default_mode: z.enum(['agent', 'plan']).optional(),
        auto_create_pr: z.boolean().optional(),
        work_on_current_branch: z.boolean().optional(),
        skip_reviewer_request: z.boolean().optional(),
        enable_steer: z.boolean().optional(),
        use_sse: z.boolean().optional(),
        poll_interval: z.union([z.string(), z.number()]).optional(),
        request_timeout: z.union([z.string(), z.number()]).optional(),
        local: z
          .object({
            cwd: z.string().optional(),
            dirs: z.array(z.string()).optional(),
            sandbox: z.boolean().optional(),
            auto_review: z.boolean().optional(),
            setting_sources: z.array(settingSourceSchema).optional(),
          })
          .optional(),
      })
      .optional(),
    server: z
      .object({
        addr: z.string().optional(),
        port: z.number().optional(),
        hostname: z.string().optional(),
      })
      .optional(),
    mcp: z
      .object({
        public_url: z.string().optional(),
        auth_token: z.string().optional(),
        server_name: z.string().optional(),
        servers: z.record(z.string(), mcpServerEntrySchema).optional(),
      })
      .optional(),
    hitl: z
      .object({
        enable_prompt_fallback: z.boolean().optional(),
        allow_any_chat_member_answer: z.boolean().optional(),
      })
      .optional(),
    auth: z
      .object({
        allowed_users: z.array(z.string()).optional(),
      })
      .optional(),
    repos: z
      .object({
        default_repo: z.string().optional(),
        allow_unlisted_repos: z.boolean().optional(),
        allow_no_repo: z.boolean().optional(),
        aliases: z.record(z.string(), repoAliasSchema).optional(),
      })
      .optional(),
  })
  .strict()

export function createDefaultConfig(): GatewayConfig {
  return {
    bots: [],
    cursor: {
      runtime: 'cloud',
      apiKey: '',
      baseUrl: 'https://api.cursor.com',
      defaultModel: '',
      defaultMode: 'agent',
      autoCreatePR: false,
      workOnCurrentBranch: false,
      skipReviewerRequest: false,
      enableSteer: true,
      useSSE: true,
      pollIntervalMs: 10_000,
      requestTimeoutMs: 30_000,
      local: {
        cwd: '',
        dirs: [],
        settingSources: [],
      },
    },
    server: {
      port: 8080,
      hostname: '0.0.0.0',
    },
    mcp: {
      publicUrl: '',
      authToken: '',
      serverName: 'lark-hitl',
      servers: {},
    },
    hitl: {
      enablePromptFallback: true,
      allowAnyChatMemberAnswer: false,
    },
    auth: {
      allowedUsers: [],
    },
    repos: {
      defaultRepo: '',
      allowUnlistedRepos: true,
      allowNoRepo: true,
      aliases: {},
    },
  }
}

export type RawGatewayConfig = z.input<typeof rawConfigSchema>

export interface ParseConfigOptions {
  /** Environment variables used for `${ENV_VAR}` placeholder expansion (defaults to `process.env`). */
  env?: Record<string, string | undefined>
  /**
   * Whether to apply `LARK_*` / `CURSOR_*` / `SERVER_*` / `MCP_*` / `HITL_*` env var overrides
   * after applying the raw config. Defaults to `false` for in-memory parsing so external
   * config sources are not silently overwritten by host environment variables.
   */
  applyEnvOverrides?: boolean
}

export function parseConfigFromObject(
  rawObj: unknown,
  options: ParseConfigOptions = {},
): GatewayConfig {
  const cfg = createDefaultConfig()
  const env = options.env ?? process.env
  const expanded = expandEnvVars(rawObj ?? {}, env)
  const parsed = rawConfigSchema.parse(expanded)
  applyConfigFile(cfg, parsed)
  if (options.applyEnvOverrides) applyEnv(cfg, env)
  validateConfig(cfg)
  return cfg
}

export function parseConfigFromToml(
  tomlText: string,
  options: ParseConfigOptions = {},
): GatewayConfig {
  const rawObj = Bun.TOML.parse(tomlText) ?? {}
  return parseConfigFromObject(rawObj, options)
}

export function loadConfig(
  configPath?: string,
  env: Record<string, string | undefined> = process.env,
): GatewayConfig {
  const cfg = createDefaultConfig()

  const resolvedPath =
    configPath || env.CONFIG_PATH || (existsSync('config.toml') ? 'config.toml' : '')

  if (resolvedPath) {
    const rawText = readFileSync(resolvedPath, 'utf8')
    const rawObj = parseConfigFile(resolvedPath, rawText)
    const expanded = expandEnvVars(rawObj, env)
    const parsed = rawConfigSchema.parse(expanded)
    applyConfigFile(cfg, parsed)
  }

  applyEnv(cfg, env)
  validateConfig(cfg)
  return cfg
}

function parseConfigFile(filePath: string, rawText: string): unknown {
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.toml')) return Bun.TOML.parse(rawText) ?? {}
  throw new Error(`Unsupported config format "${filePath}": expected .toml`)
}

const ENV_PLACEHOLDER_RE = /\$\{(\w+)\}/g

function expandEnvVars(value: unknown, env: Record<string, string | undefined>): unknown {
  if (typeof value === 'string') {
    return value.replace(ENV_PLACEHOLDER_RE, (_, name: string) => env[name] ?? '')
  }
  if (Array.isArray(value)) return value.map((item) => expandEnvVars(item, env))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[k] = expandEnvVars(v, env)
    return out
  }
  return value
}

function normalizeAliases(
  raw?: Record<string, z.infer<typeof repoAliasSchema>>,
): Record<string, RepoConfig> {
  const out: Record<string, RepoConfig> = {}
  if (!raw) return out
  for (const [alias, rc] of Object.entries(raw)) {
    out[alias] = {
      url: rc.url?.trim() ?? '',
      path: rc.path?.trim() || undefined,
      defaultBranch: rc.default_branch,
      allowedUsers: rc.allowed_users ?? [],
    }
  }
  return out
}

function normalizeMcpServers(
  raw?: Record<string, z.infer<typeof mcpServerEntrySchema>>,
): Record<string, McpServerConfigEntry> {
  const out: Record<string, McpServerConfigEntry> = {}
  if (!raw) return out
  for (const [name, entry] of Object.entries(raw)) {
    out[name.trim()] = {
      type: entry.type,
      url: entry.url?.trim() || undefined,
      headers: entry.headers,
      command: entry.command?.trim() || undefined,
      args: entry.args,
      env: entry.env,
      enabled: entry.enabled,
    }
  }
  return out
}

function applyConfigFile(cfg: GatewayConfig, t: z.infer<typeof rawConfigSchema>): void {
  if (t.bots && t.bots.length > 0) {
    cfg.bots = t.bots.map((b) => ({
      id: b.id.trim(),
      name: b.name?.trim() || b.id.trim(),
      appId: b.app_id?.trim() ?? '',
      appSecret: b.app_secret?.trim() ?? '',
      domain: b.domain ?? 'lark',
      verificationToken: b.verification_token?.trim() ?? '',
      encryptKey: b.encrypt_key?.trim() ?? '',
      logLevel: b.log_level ?? 'info',
      requireMention: b.require_mention,
      runtime: b.runtime,
      cwd: b.cwd?.trim() || undefined,
      dirs: b.dirs,
      sandbox: b.sandbox,
      autoReview: b.auto_review,
      settingSources: b.setting_sources,
      cursorApiKey: b.cursor_api_key?.trim() || undefined,
      defaultModel: b.default_model?.trim() || undefined,
      presetPrompt: b.preset_prompt?.trim(),
      defaultMode: b.default_mode,
      autoCreatePR: b.auto_create_pr,
      workOnCurrentBranch: b.work_on_current_branch,
      skipReviewerRequest: b.skip_reviewer_request,
      defaultRepo: b.default_repo?.trim(),
      allowUnlistedRepos: b.allow_unlisted_repos,
      allowNoRepo: b.allow_no_repo,
      allowedUsers: b.allowed_users,
      repoAliases: b.repos?.aliases ? normalizeAliases(b.repos.aliases) : undefined,
      mcpServers: b.mcp_servers ? normalizeMcpServers(b.mcp_servers) : undefined,
    }))
  }

  if (t.cursor) {
    if (t.cursor.runtime) cfg.cursor.runtime = t.cursor.runtime
    if (t.cursor.api_key) cfg.cursor.apiKey = t.cursor.api_key
    if (t.cursor.base_url) cfg.cursor.baseUrl = t.cursor.base_url
    if (t.cursor.default_model) cfg.cursor.defaultModel = t.cursor.default_model
    if (t.cursor.default_mode) cfg.cursor.defaultMode = t.cursor.default_mode
    if (t.cursor.auto_create_pr !== undefined) cfg.cursor.autoCreatePR = t.cursor.auto_create_pr
    if (t.cursor.work_on_current_branch !== undefined)
      cfg.cursor.workOnCurrentBranch = t.cursor.work_on_current_branch
    if (t.cursor.skip_reviewer_request !== undefined)
      cfg.cursor.skipReviewerRequest = t.cursor.skip_reviewer_request
    if (t.cursor.enable_steer !== undefined) cfg.cursor.enableSteer = t.cursor.enable_steer
    if (t.cursor.use_sse !== undefined) cfg.cursor.useSSE = t.cursor.use_sse
    if (t.cursor.poll_interval !== undefined)
      cfg.cursor.pollIntervalMs = parseDurationMs(t.cursor.poll_interval, cfg.cursor.pollIntervalMs)
    if (t.cursor.request_timeout !== undefined)
      cfg.cursor.requestTimeoutMs = parseDurationMs(
        t.cursor.request_timeout,
        cfg.cursor.requestTimeoutMs,
      )
    if (t.cursor.local) {
      if (t.cursor.local.cwd) cfg.cursor.local.cwd = t.cursor.local.cwd.trim()
      if (t.cursor.local.dirs) cfg.cursor.local.dirs = t.cursor.local.dirs
      if (t.cursor.local.sandbox !== undefined) cfg.cursor.local.sandbox = t.cursor.local.sandbox
      if (t.cursor.local.auto_review !== undefined)
        cfg.cursor.local.autoReview = t.cursor.local.auto_review
      if (t.cursor.local.setting_sources)
        cfg.cursor.local.settingSources = t.cursor.local.setting_sources
    }
  }
  if (t.server) {
    if (t.server.addr) applyServerAddr(cfg, t.server.addr)
    if (t.server.port !== undefined) cfg.server.port = t.server.port
    if (t.server.hostname) cfg.server.hostname = t.server.hostname
  }
  if (t.mcp) {
    if (t.mcp.public_url) cfg.mcp.publicUrl = t.mcp.public_url
    if (t.mcp.auth_token) cfg.mcp.authToken = t.mcp.auth_token
    if (t.mcp.server_name) cfg.mcp.serverName = t.mcp.server_name
    if (t.mcp.servers) cfg.mcp.servers = normalizeMcpServers(t.mcp.servers)
  }
  if (t.hitl) {
    if (t.hitl.enable_prompt_fallback !== undefined)
      cfg.hitl.enablePromptFallback = t.hitl.enable_prompt_fallback
    if (t.hitl.allow_any_chat_member_answer !== undefined)
      cfg.hitl.allowAnyChatMemberAnswer = t.hitl.allow_any_chat_member_answer
  }
  if (t.auth?.allowed_users) cfg.auth.allowedUsers = t.auth.allowed_users
  if (t.repos) {
    if (t.repos.default_repo !== undefined) cfg.repos.defaultRepo = t.repos.default_repo
    if (t.repos.allow_unlisted_repos !== undefined)
      cfg.repos.allowUnlistedRepos = t.repos.allow_unlisted_repos
    if (t.repos.allow_no_repo !== undefined) cfg.repos.allowNoRepo = t.repos.allow_no_repo
    if (t.repos.aliases) cfg.repos.aliases = normalizeAliases(t.repos.aliases)
  }
}

function applyEnv(cfg: GatewayConfig, env: Record<string, string | undefined>): void {
  const str = (key: string): string | undefined => {
    const v = env[key]?.trim()
    return v || undefined
  }
  const bool = (key: string): boolean | undefined => {
    const v = env[key]?.trim().toLowerCase()
    if (v === 'true' || v === '1' || v === 'yes') return true
    if (v === 'false' || v === '0' || v === 'no') return false
    return undefined
  }

  if (cfg.bots.length === 0) {
    const appId = str('LARK_APP_ID') ?? ''
    const appSecret = str('LARK_APP_SECRET') ?? ''
    if (appId || appSecret) {
      const domain = str('LARK_DOMAIN')?.toLowerCase()
      const logLevel = str('LARK_LOG_LEVEL')?.toLowerCase()
      cfg.bots.push({
        id: str('LARK_BOT_ID') ?? 'default',
        name: str('LARK_BOT_NAME') ?? 'Cursor Agent',
        appId,
        appSecret,
        domain: domain === 'feishu' ? 'feishu' : 'lark',
        verificationToken: str('LARK_VERIFICATION_TOKEN') ?? '',
        encryptKey: str('LARK_ENCRYPT_KEY') ?? '',
        logLevel:
          logLevel === 'debug' || logLevel === 'info' || logLevel === 'warn' || logLevel === 'error'
            ? logLevel
            : 'info',
        requireMention: bool('LARK_REQUIRE_MENTION'),
      })
    }
  }

  const runtime = str('CURSOR_RUNTIME')?.toLowerCase()
  if (runtime === 'cloud' || runtime === 'local') cfg.cursor.runtime = runtime
  cfg.cursor.apiKey = str('CURSOR_API_KEY') ?? cfg.cursor.apiKey
  cfg.cursor.baseUrl = str('CURSOR_API_BASE_URL') ?? cfg.cursor.baseUrl
  cfg.cursor.defaultModel = str('CURSOR_DEFAULT_MODEL') ?? cfg.cursor.defaultModel
  const mode = str('CURSOR_DEFAULT_MODE')?.toLowerCase()
  if (mode === 'agent' || mode === 'plan') cfg.cursor.defaultMode = mode
  cfg.cursor.autoCreatePR = bool('CURSOR_AUTO_CREATE_PR') ?? cfg.cursor.autoCreatePR
  cfg.cursor.workOnCurrentBranch =
    bool('CURSOR_WORK_ON_CURRENT_BRANCH') ?? cfg.cursor.workOnCurrentBranch
  cfg.cursor.skipReviewerRequest =
    bool('CURSOR_SKIP_REVIEWER_REQUEST') ?? cfg.cursor.skipReviewerRequest
  cfg.cursor.enableSteer = bool('CURSOR_ENABLE_STEER') ?? cfg.cursor.enableSteer
  cfg.cursor.useSSE = bool('CURSOR_USE_SSE') ?? cfg.cursor.useSSE
  if (str('CURSOR_POLL_INTERVAL'))
    cfg.cursor.pollIntervalMs = parseDurationMs(
      str('CURSOR_POLL_INTERVAL')!,
      cfg.cursor.pollIntervalMs,
    )
  if (str('CURSOR_REQUEST_TIMEOUT'))
    cfg.cursor.requestTimeoutMs = parseDurationMs(
      str('CURSOR_REQUEST_TIMEOUT')!,
      cfg.cursor.requestTimeoutMs,
    )
  cfg.cursor.local.cwd = str('CURSOR_LOCAL_CWD') ?? cfg.cursor.local.cwd
  cfg.cursor.local.sandbox = bool('CURSOR_LOCAL_SANDBOX') ?? cfg.cursor.local.sandbox
  cfg.cursor.local.autoReview = bool('CURSOR_LOCAL_AUTO_REVIEW') ?? cfg.cursor.local.autoReview

  if (str('SERVER_ADDR')) applyServerAddr(cfg, str('SERVER_ADDR')!)
  if (str('PORT')) {
    const port = Number(str('PORT'))
    if (Number.isInteger(port) && port > 0) cfg.server.port = port
  }

  cfg.mcp.publicUrl = str('MCP_PUBLIC_URL') ?? cfg.mcp.publicUrl
  cfg.mcp.authToken = str('MCP_AUTH_TOKEN') ?? cfg.mcp.authToken
  cfg.mcp.serverName = str('MCP_SERVER_NAME') ?? cfg.mcp.serverName

  cfg.hitl.enablePromptFallback =
    bool('HITL_ENABLE_PROMPT_FALLBACK') ?? cfg.hitl.enablePromptFallback
  cfg.hitl.allowAnyChatMemberAnswer =
    bool('HITL_ALLOW_ANY_CHAT_MEMBER_ANSWER') ?? cfg.hitl.allowAnyChatMemberAnswer

  if (str('ALLOWED_USERS')) {
    cfg.auth.allowedUsers = str('ALLOWED_USERS')!
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  cfg.repos.defaultRepo = str('DEFAULT_REPO') ?? cfg.repos.defaultRepo
  cfg.repos.allowUnlistedRepos = bool('ALLOW_UNLISTED_REPOS') ?? cfg.repos.allowUnlistedRepos
  cfg.repos.allowNoRepo = bool('ALLOW_NO_REPO') ?? cfg.repos.allowNoRepo
}

export function validateConfig(cfg: GatewayConfig): void {
  if (cfg.bots.length === 0)
    throw new Error(
      'At least one Lark bot must be configured via bots in config.toml or LARK_APP_ID/LARK_APP_SECRET',
    )

  validateMcpServerMap('mcp.servers', cfg.mcp.servers)

  const seenIds = new Set<string>()
  const seenAppIds = new Set<string>()
  for (const bot of cfg.bots) {
    if (!bot.id.trim()) throw new Error('bot.id is required')
    if (seenIds.has(bot.id)) throw new Error(`Duplicate bot id "${bot.id}" in config`)
    seenIds.add(bot.id)

    if (!bot.appId.trim()) throw new Error(`bots[${bot.id}].app_id is required`)
    if (!bot.appSecret.trim()) throw new Error(`bots[${bot.id}].app_secret is required`)
    if (seenAppIds.has(bot.appId)) throw new Error(`Duplicate app_id "${bot.appId}" across bots`)
    seenAppIds.add(bot.appId)

    const effectiveKey = bot.cursorApiKey?.trim() || cfg.cursor.apiKey.trim()
    if (!effectiveKey)
      throw new Error(
        `bots[${bot.id}] requires cursor_api_key or global cursor.api_key (CURSOR_API_KEY)`,
      )

    if (bot.mcpServers) validateMcpServerMap(`bots[${bot.id}].mcp_servers`, bot.mcpServers)
  }

  cfg.cursor.baseUrl = cfg.cursor.baseUrl.replace(/\/+$/, '') || 'https://api.cursor.com'
  cfg.mcp.publicUrl = cfg.mcp.publicUrl.trim().replace(/\/+$/, '')
  cfg.mcp.serverName = cfg.mcp.serverName.trim() || 'lark-hitl'
}

function validateMcpServerMap(scope: string, servers: Record<string, McpServerConfigEntry>): void {
  for (const [name, entry] of Object.entries(servers)) {
    if (!name.trim()) throw new Error(`${scope}: MCP server name cannot be empty`)
    if (entry.enabled === false) continue
    const inferredType = entry.type ?? (entry.command ? 'stdio' : 'http')
    if (inferredType === 'stdio') {
      if (!entry.command?.trim())
        throw new Error(`${scope}.${name}: stdio MCP server requires "command"`)
    } else {
      if (!entry.url?.trim())
        throw new Error(`${scope}.${name}: ${inferredType} MCP server requires "url"`)
    }
  }
}

export function getMcpEndpointUrl(cfg: GatewayConfig): string {
  if (!cfg.mcp.publicUrl) return ''
  return cfg.mcp.publicUrl.endsWith('/mcp') ? cfg.mcp.publicUrl : `${cfg.mcp.publicUrl}/mcp`
}

export interface EffectiveBotPolicy {
  requireMention: boolean
  presetPrompt: string
  runtime: AgentRuntime
  localCwd: string
  localDirs: string[]
  localSandbox?: boolean
  localAutoReview?: boolean
  localSettingSources: LocalSettingSource[]
  cursorApiKey: string
  defaultModel: string
  defaultMode: 'agent' | 'plan'
  autoCreatePR: boolean
  workOnCurrentBranch: boolean
  skipReviewerRequest: boolean
  defaultRepo: string
  allowUnlistedRepos: boolean
  allowNoRepo: boolean
  allowedUsers: string[]
  repoAliases: Record<string, RepoConfig>
  mcpServers: McpServerSpec[]
}

export function resolveBotPolicy(cfg: GatewayConfig, bot?: LarkBotConfig): EffectiveBotPolicy {
  const mergedMcpMap: Record<string, McpServerConfigEntry> = {
    ...cfg.mcp.servers,
    ...(bot?.mcpServers ?? {}),
  }

  return {
    requireMention: bot?.requireMention ?? true,
    runtime: bot?.runtime ?? cfg.cursor.runtime,
    localCwd: bot?.cwd ?? cfg.cursor.local.cwd,
    localDirs: bot?.dirs ?? cfg.cursor.local.dirs,
    localSandbox: bot?.sandbox ?? cfg.cursor.local.sandbox,
    localAutoReview: bot?.autoReview ?? cfg.cursor.local.autoReview,
    localSettingSources: bot?.settingSources ?? cfg.cursor.local.settingSources,
    cursorApiKey: bot?.cursorApiKey ?? cfg.cursor.apiKey,
    defaultModel: bot?.defaultModel ?? cfg.cursor.defaultModel,
    presetPrompt: bot?.presetPrompt ?? '',
    defaultMode: bot?.defaultMode ?? cfg.cursor.defaultMode,
    autoCreatePR: bot?.autoCreatePR ?? cfg.cursor.autoCreatePR,
    workOnCurrentBranch: bot?.workOnCurrentBranch ?? cfg.cursor.workOnCurrentBranch,
    skipReviewerRequest: bot?.skipReviewerRequest ?? cfg.cursor.skipReviewerRequest,
    defaultRepo: bot?.defaultRepo ?? cfg.repos.defaultRepo,
    allowUnlistedRepos: bot?.allowUnlistedRepos ?? cfg.repos.allowUnlistedRepos,
    allowNoRepo: bot?.allowNoRepo ?? cfg.repos.allowNoRepo,
    allowedUsers: bot?.allowedUsers ?? cfg.auth.allowedUsers,
    repoAliases: bot?.repoAliases
      ? {
          ...cfg.repos.aliases,
          ...bot.repoAliases,
        }
      : cfg.repos.aliases,
    mcpServers: toMcpServerSpecs(mergedMcpMap),
  }
}

function toMcpServerSpecs(entries: Record<string, McpServerConfigEntry>): McpServerSpec[] {
  const specs: McpServerSpec[] = []
  for (const [name, entry] of Object.entries(entries)) {
    if (entry.enabled === false) continue
    const type = entry.type ?? (entry.command ? 'stdio' : 'http')
    if (type === 'stdio' && entry.command) {
      specs.push({
        name,
        type: 'stdio',
        command: entry.command,
        args: entry.args,
        env: entry.env,
      })
    } else if ((type === 'http' || type === 'sse') && entry.url) {
      specs.push({
        name,
        type,
        url: entry.url,
        headers: entry.headers,
      })
    }
  }
  return specs
}

export function isUserAllowed(cfg: GatewayConfig, userId: string, bot?: LarkBotConfig): boolean {
  const policy = resolveBotPolicy(cfg, bot)
  return isInListOrEmpty(userId, policy.allowedUsers)
}

export interface ResolvedRepo {
  repoUrl: string
  defaultBranch: string
}

export function resolveRepo(
  cfg: GatewayConfig,
  input: string,
  userId: string,
  bot?: LarkBotConfig,
): ResolvedRepo {
  const policy = resolveBotPolicy(cfg, bot)
  if (!isInListOrEmpty(userId, policy.allowedUsers))
    throw new Error(`User ${userId} is not allowed to create tasks`)

  const key = input.trim() || policy.defaultRepo.trim()
  if (!key) {
    if (policy.allowNoRepo) {
      return {
        repoUrl: '',
        defaultBranch: '',
      }
    }
    throw new Error(
      'No repository specified. Pass `repo: <alias-or-url>` to select a target repository.',
    )
  }

  for (const [alias, rc] of Object.entries(policy.repoAliases)) {
    const sameAlias = alias.toLowerCase() === key.toLowerCase()
    const sameUrl =
      Boolean(rc.url) &&
      rc.url.replace(/\/+$/, '').toLowerCase() === key.replace(/\/+$/, '').toLowerCase()
    if (sameAlias || sameUrl) {
      if (!isInListOrEmpty(userId, rc.allowedUsers))
        throw new Error(`You do not have permission to access repository \`${alias}\``)
      if (!rc.url)
        throw new Error(
          `Repository alias \`${alias}\` has no remote \`url\` configured for cloud runtime.`,
        )
      return {
        repoUrl: rc.url,
        defaultBranch: rc.defaultBranch ?? '',
      }
    }
  }

  if (!policy.allowUnlistedRepos)
    throw new Error(
      `Repository \`${key}\` is not in the allowlist. Use \`/repos\` to view configured aliases.`,
    )

  if (!key.startsWith('http://') && !key.startsWith('https://'))
    throw new Error(
      `Repository alias \`${key}\` was not found. Provide a full repository URL (e.g. https://github.com/org/repo) or run \`/repos\`.`,
    )

  return {
    repoUrl: key,
    defaultBranch: '',
  }
}

export interface ResolvedLocalWorkspace {
  cwd: string
  label: string
}

export function resolveLocalWorkspace(
  cfg: GatewayConfig,
  input: string,
  userId: string,
  bot?: LarkBotConfig,
): ResolvedLocalWorkspace {
  const policy = resolveBotPolicy(cfg, bot)
  if (!isInListOrEmpty(userId, policy.allowedUsers))
    throw new Error(`User ${userId} is not allowed to create tasks`)

  const explicit = input.trim()
  const key = explicit || policy.defaultRepo.trim()

  if (key) {
    for (const [alias, rc] of Object.entries(policy.repoAliases)) {
      const sameAlias = alias.toLowerCase() === key.toLowerCase()
      const samePath = Boolean(rc.path) && rc.path!.replace(/\/+$/, '') === key.replace(/\/+$/, '')
      if (sameAlias || samePath) {
        if (!isInListOrEmpty(userId, rc.allowedUsers))
          throw new Error(`You do not have permission to access workspace \`${alias}\``)
        if (!rc.path) {
          if (!explicit && policy.localCwd) break
          throw new Error(
            `Repository alias \`${alias}\` has no local \`path\` configured for local runtime.`,
          )
        }
        return {
          cwd: rc.path,
          label: alias,
        }
      }
    }
  }

  if (!explicit && policy.localCwd) {
    return {
      cwd: policy.localCwd,
      label: policy.localCwd,
    }
  }

  if (explicit && isLocalPath(explicit)) {
    if (!policy.allowUnlistedRepos)
      throw new Error(
        `Workspace \`${explicit}\` is not in the allowlist. Use \`/repos\` to view configured aliases.`,
      )
    return {
      cwd: explicit,
      label: explicit,
    }
  }

  if (explicit)
    throw new Error(
      `Workspace alias \`${explicit}\` was not found. Configure \`path\` in repos.aliases or run \`/repos\`.`,
    )

  throw new Error(
    'No local workspace configured. Set `cwd` (or `CURSOR_LOCAL_CWD`) or configure a `path` on a repository alias.',
  )
}

function isLocalPath(value: string): boolean {
  return (
    value.startsWith('/') ||
    value.startsWith('./') ||
    value.startsWith('../') ||
    value.startsWith('~/')
  )
}

function isInListOrEmpty(target: string, list: string[]): boolean {
  if (list.length === 0) return true
  return list.some((item) => item.trim() === target)
}

function applyServerAddr(cfg: GatewayConfig, addr: string): void {
  const trimmed = addr.trim()
  if (!trimmed) return
  if (trimmed.startsWith(':')) {
    const p = Number(trimmed.slice(1))
    if (Number.isInteger(p) && p > 0) cfg.server.port = p
    return
  }
  const idx = trimmed.lastIndexOf(':')
  if (idx > 0) {
    cfg.server.hostname = trimmed.slice(0, idx)
    const p = Number(trimmed.slice(idx + 1))
    if (Number.isInteger(p) && p > 0) cfg.server.port = p
  }
}

export function parseDurationMs(input: string | number, fallbackMs: number): number {
  if (typeof input === 'number') {
    return input > 0 ? input : fallbackMs
  }
  const trimmed = input.trim().toLowerCase()
  const match = /^(\d+(?:\.\d+)?)(ms|[smh])?$/.exec(trimmed)
  if (!match) return fallbackMs
  const val = Number(match[1])
  const unit = match[2] ?? 'ms'
  const mult = unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : unit === 's' ? 1_000 : 1
  const total = Math.round(val * mult)
  return total > 0 ? total : fallbackMs
}
