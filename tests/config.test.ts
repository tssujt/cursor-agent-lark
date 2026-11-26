import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import {
  createDefaultConfig,
  getMcpEndpointUrl,
  loadConfig,
  parseConfigFromObject,
  parseConfigFromToml,
  resolveBotPolicy,
  resolveLocalWorkspace,
  resolveRepo,
  resolveRepos,
} from '../src/config.ts'

describe('config', () => {
  it('resolves repository aliases and enforces user/repo allowlists', () => {
    const cfg = createDefaultConfig()
    cfg.auth.allowedUsers = ['ou_alice', 'ou_bob']
    cfg.repos.allowUnlistedRepos = false
    cfg.repos.allowNoRepo = false
    cfg.repos.defaultRepo = 'backend'
    cfg.repos.aliases = {
      backend: {
        url: 'https://github.com/acme/backend',
        defaultBranch: 'main',
        allowedUsers: ['ou_alice'],
      },
      docs: {
        url: 'https://github.com/acme/docs',
        defaultBranch: 'develop',
        allowedUsers: [],
      },
    }

    expect(resolveRepo(cfg, '', 'ou_alice')).toEqual({
      repoUrl: 'https://github.com/acme/backend',
      defaultBranch: 'main',
    })
    expect(() => resolveRepo(cfg, 'backend', 'ou_bob')).toThrow()
    expect(resolveRepo(cfg, 'docs', 'ou_bob')).toEqual({
      repoUrl: 'https://github.com/acme/docs',
      defaultBranch: 'develop',
    })
    expect(() => resolveRepo(cfg, 'https://github.com/other/repo', 'ou_alice')).toThrow()
    expect(() => resolveRepo(cfg, 'docs', 'ou_mallory')).toThrow()
  })

  it('loads multi-bot TOML config with env expansion and per-bot overrides', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-lark-cfg-'))
    try {
      const tomlPath = join(dir, 'config.toml')
      writeFileSync(
        tomlPath,
        `
[cursor]
api_key = '\${CURSOR_API_KEY}'
default_mode = 'plan'
poll_interval = '15s'

[mcp]
public_url = 'https://gw.example.com/'

[repos]
allow_unlisted_repos = false

[repos.aliases.api]
url = 'https://github.com/org/api'
default_branch = 'main'

[repos.aliases.web]
url = 'https://github.com/org/web'
default_branch = 'main'

[[bots]]
id = 'backend-bot'
name = 'Backend Bot'
app_id = 'cli_backend'
app_secret = '\${LARK_BACKEND_SECRET}'
domain = 'feishu'
default_repo = 'api'
default_model = 'composer-2'
preset_prompt = '''
Answer in \${BOT_LANGUAGE}.
Prefer small changes.
'''

[[bots]]
id = 'frontend-bot'
name = 'Frontend Bot'
app_id = 'cli_frontend'
app_secret = '\${LARK_FRONTEND_SECRET}'
domain = 'lark'
default_repo = 'web'
require_mention = false
cursor_api_key = '\${CURSOR_FRONTEND_KEY}'
allowed_users = ['ou_fe_dev']
preset_prompt = 'Focus on frontend accessibility.'
`,
      )
      const cfg = loadConfig(tomlPath, {
        CURSOR_API_KEY: 'key_global',
        CURSOR_FRONTEND_KEY: 'key_frontend',
        LARK_BACKEND_SECRET: 'sec_be',
        LARK_FRONTEND_SECRET: 'sec_fe',
        BOT_LANGUAGE: 'Chinese',
      })

      expect(cfg.bots).toHaveLength(2)
      expect(cfg.bots[0]?.id).toBe('backend-bot')
      expect(cfg.bots[0]?.appSecret).toBe('sec_be')
      expect(cfg.bots[0]?.domain).toBe('feishu')
      expect(cfg.bots[1]?.id).toBe('frontend-bot')
      expect(cfg.bots[1]?.domain).toBe('lark')
      expect(cfg.cursor.defaultMode).toBe('plan')
      expect(cfg.cursor.pollIntervalMs).toBe(15_000)
      expect(getMcpEndpointUrl(cfg)).toBe('https://gw.example.com/mcp')

      const bePolicy = resolveBotPolicy(cfg, cfg.bots[0])
      expect(bePolicy.requireMention).toBe(true)
      expect(bePolicy.cursorApiKey).toBe('key_global')
      expect(bePolicy.defaultRepo).toBe('api')
      expect(bePolicy.defaultModel).toBe('composer-2')
      expect(bePolicy.presetPrompt).toBe('Answer in Chinese.\nPrefer small changes.')

      const fePolicy = resolveBotPolicy(cfg, cfg.bots[1])
      expect(fePolicy.requireMention).toBe(false)
      expect(fePolicy.cursorApiKey).toBe('key_frontend')
      expect(fePolicy.defaultRepo).toBe('web')
      expect(fePolicy.allowedUsers).toEqual(['ou_fe_dev'])
      expect(fePolicy.presetPrompt).toBe('Focus on frontend accessibility.')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('supports bots without repos by explicitly clearing a global default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-lark-no-repo-'))
    try {
      const configPath = join(dir, 'config.toml')
      writeFileSync(
        configPath,
        `
[cursor]
api_key = 'test-key'
[repos]
default_repo = 'api'
allow_no_repo = false
[repos.aliases.api]
url = 'https://github.com/org/api'
[[bots]]
id = 'assistant'
app_id = 'cli_assistant'
app_secret = 'test-secret'
default_repo = ''
allow_no_repo = true
preset_prompt = ''
[[bots]]
id = 'developer'
app_id = 'cli_developer'
app_secret = 'test-secret'
`,
      )
      const cfg = loadConfig(configPath, {})
      expect(resolveRepo(cfg, '', 'ou_alice', cfg.bots[0])).toEqual({
        repoUrl: '',
        defaultBranch: '',
      })
      expect(resolveBotPolicy(cfg, cfg.bots[0]).presetPrompt).toBe('')
      expect(resolveBotPolicy(cfg, cfg.bots[1]).presetPrompt).toBe('')
      expect(resolveBotPolicy(cfg, cfg.bots[1]).defaultRepo).toBe('api')
      expect(resolveRepo(cfg, 'api', 'ou_alice', cfg.bots[0]).repoUrl).toBe(
        'https://github.com/org/api',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.each(['yaml', 'yml'])('rejects explicitly selected .%s config files', (extension) => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-lark-yaml-'))
    try {
      const configPath = join(dir, `config.${extension}`)
      writeFileSync(configPath, 'bots: []\n')
      const message = `Unsupported config format "${configPath}": expected .toml`
      expect(() => loadConfig(configPath, {})).toThrow(message)
      expect(() => loadConfig(undefined, { CONFIG_PATH: configPath })).toThrow(message)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ignores YAML files during auto-discovery and still loads TOML', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-lark-discovery-'))
    const originalCwd = process.cwd()
    const env = {
      LARK_APP_ID: 'cli_single',
      LARK_APP_SECRET: 'test-secret',
      CURSOR_API_KEY: 'test-key',
    }
    try {
      process.chdir(dir)
      writeFileSync('config.yaml', 'invalid: [')
      writeFileSync('config.yml', 'invalid: [')
      expect(loadConfig(undefined, env).bots[0]?.appId).toBe('cli_single')

      writeFileSync('config.toml', '[cursor]\ndefault_mode = "plan"\n')
      expect(loadConfig(undefined, env).cursor.defaultMode).toBe('plan')
      expect(loadConfig(undefined, { ...env, CONFIG_PATH: 'config.toml' }).cursor.defaultMode).toBe(
        'plan',
      )
    } finally {
      process.chdir(originalCwd)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('merges global and per-bot MCP servers (http, sse, stdio) and honors enabled=false', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-lark-mcp-'))
    try {
      const tomlPath = join(dir, 'mcp.toml')
      writeFileSync(
        tomlPath,
        `
[cursor]
api_key = 'k'

[mcp.servers.linear]
type = 'http'
url = 'https://mcp.linear.app/sse'
headers = { Authorization = 'Bearer \${LINEAR_KEY}' }

[mcp.servers.github]
type = 'stdio'
command = 'npx'
args = ['-y', '@modelcontextprotocol/server-github']
env = { GITHUB_TOKEN = '\${GH_TOKEN}' }

[[bots]]
id = 'be'
app_id = 'cli_1'
app_secret = 'sec_1'

[bots.mcp_servers.sentry]
type = 'sse'
url = 'https://mcp.sentry.dev/sse'

[[bots]]
id = 'fe'
app_id = 'cli_2'
app_secret = 'sec_2'

[bots.mcp_servers.github]
enabled = false
`,
      )
      const cfg = loadConfig(tomlPath, {
        LINEAR_KEY: 'lin_123',
        GH_TOKEN: 'ghp_456',
      })

      const beMcps = resolveBotPolicy(cfg, cfg.bots[0]).mcpServers
      expect(beMcps.map((m) => m.name).sort()).toEqual(['github', 'linear', 'sentry'])
      const linear = beMcps.find((m) => m.name === 'linear')
      expect(linear?.type === 'http' && linear.headers?.Authorization).toBe('Bearer lin_123')
      const github = beMcps.find((m) => m.name === 'github')
      expect(github?.type === 'stdio' && github.env?.GITHUB_TOKEN).toBe('ghp_456')

      const feMcps = resolveBotPolicy(cfg, cfg.bots[1]).mcpServers
      expect(feMcps.map((m) => m.name)).toEqual(['linear'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('supports single-bot fallback from LARK_* env vars and rejects duplicate bot ids', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-lark-dup-'))
    const originalCwd = process.cwd()
    try {
      process.chdir(dir)
      const envCfg = loadConfig(undefined, {
        LARK_APP_ID: 'cli_single',
        LARK_APP_SECRET: 'sec_single',
        LARK_DOMAIN: 'feishu',
        LARK_REQUIRE_MENTION: 'false',
        CURSOR_API_KEY: 'key_single',
      })
      expect(envCfg.bots).toHaveLength(1)
      expect(envCfg.bots[0]?.id).toBe('default')
      expect(envCfg.bots[0]?.domain).toBe('feishu')
      expect(resolveBotPolicy(envCfg, envCfg.bots[0]).requireMention).toBe(false)
      expect(envCfg.cursor.autoCreatePR).toBe(false)

      const dupPath = join(dir, 'dup.toml')
      writeFileSync(
        dupPath,
        `
[cursor]
api_key = 'k'

[[bots]]
id = 'same'
app_id = 'cli_1'
app_secret = 'sec_1'

[[bots]]
id = 'same'
app_id = 'cli_2'
app_secret = 'sec_2'
`,
      )
      expect(() => loadConfig(dupPath, {})).toThrow(/Duplicate bot id/)
    } finally {
      process.chdir(originalCwd)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('loads local runtime config and resolves local workspaces from cwd and repo alias paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-lark-local-'))
    try {
      const tomlPath = join(dir, 'local.toml')
      writeFileSync(
        tomlPath,
        `
[cursor]
runtime = 'local'
api_key = 'key_local'
default_model = 'composer-2'

[cursor.local]
cwd = '/workspace/default'
sandbox = true
auto_review = false
setting_sources = ['project', 'user']

[repos]
allow_unlisted_repos = false

[repos.aliases.backend]
url = 'https://github.com/org/backend'
path = '/workspace/backend'
allowed_users = ['ou_alice']

[[bots]]
id = 'local-bot'
app_id = 'cli_local'
app_secret = 'sec_local'
cwd = '/workspace/override'
`,
      )
      const cfg = loadConfig(tomlPath, {})
      const policy = resolveBotPolicy(cfg, cfg.bots[0])
      expect(policy.runtime).toBe('local')
      expect(policy.localCwd).toBe('/workspace/override')
      expect(policy.localSandbox).toBe(true)
      expect(policy.localAutoReview).toBe(false)
      expect(policy.localSettingSources).toEqual(['project', 'user'])

      expect(resolveLocalWorkspace(cfg, '', 'ou_alice', cfg.bots[0])).toEqual({
        cwd: '/workspace/override',
        label: '/workspace/override',
      })
      expect(resolveLocalWorkspace(cfg, 'backend', 'ou_alice', cfg.bots[0])).toEqual({
        cwd: '/workspace/backend',
        label: 'backend',
      })
      expect(() => resolveLocalWorkspace(cfg, 'backend', 'ou_bob', cfg.bots[0])).toThrow()
      expect(() => resolveLocalWorkspace(cfg, '/etc/passwd', 'ou_alice', cfg.bots[0])).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('parses in-memory TOML and JS objects without silent host env overrides by default', () => {
    const hostEnv = {
      CURSOR_API_KEY: 'key_from_host_env',
      CURSOR_DEFAULT_MODE: 'plan',
      BOT_SECRET: 'sec_from_env',
      REMOTE_KEY: 'key_from_remote',
    }

    const fromObj = parseConfigFromObject(
      {
        cursor: {
          api_key: `\${REMOTE_KEY}`,
          default_mode: 'agent',
        },
        repos: {
          allow_no_repo: true,
        },
        bots: [
          {
            id: 'remote-bot',
            app_id: 'cli_remote',
            app_secret: `\${BOT_SECRET}`,
            require_mention: false,
          },
        ],
      },
      { env: hostEnv },
    )
    expect(fromObj.cursor.apiKey).toBe('key_from_remote')
    expect(fromObj.cursor.defaultMode).toBe('agent')
    expect(fromObj.bots[0]?.appSecret).toBe('sec_from_env')
    expect(resolveBotPolicy(fromObj, fromObj.bots[0]).requireMention).toBe(false)

    const withEnvOverrides = parseConfigFromToml(
      `
[cursor]
api_key = 'key_from_toml'
default_mode = 'agent'

[[bots]]
id = 'toml-bot'
app_id = 'cli_toml'
app_secret = 'sec_toml'
`,
      { env: hostEnv, applyEnvOverrides: true },
    )
    expect(withEnvOverrides.cursor.apiKey).toBe('key_from_host_env')
    expect(withEnvOverrides.cursor.defaultMode).toBe('plan')
  })

  it('resolves multiple default_repos and comma-separated repo inputs for cloud runtime', () => {
    const cfg = parseConfigFromToml(
      `
[cursor]
api_key = 'k'

[repos]
default_repos = ['backend', 'shared']
allow_unlisted_repos = false

[repos.aliases.backend]
url = 'https://github.com/org/backend'
default_branch = 'main'

[repos.aliases.web]
url = 'https://github.com/org/web'
default_branch = 'develop'

[repos.aliases.shared]
url = 'https://github.com/org/shared'
default_branch = 'main'

[[bots]]
id = 'multi-bot'
app_id = 'cli_multi'
app_secret = 'sec_multi'
default_repos = ['backend', 'web']

[[bots]]
id = 'inherit-bot'
app_id = 'cli_inherit'
app_secret = 'sec_inherit'

[[bots]]
id = 'no-repo-bot'
app_id = 'cli_none'
app_secret = 'sec_none'
default_repos = []
allow_no_repo = true
`,
      { env: {} },
    )

    expect(resolveRepos(cfg, '', 'ou_alice', cfg.bots[0])).toEqual([
      { repoUrl: 'https://github.com/org/backend', defaultBranch: 'main' },
      { repoUrl: 'https://github.com/org/web', defaultBranch: 'develop' },
    ])
    expect(resolveRepos(cfg, '', 'ou_alice', cfg.bots[1])).toEqual([
      { repoUrl: 'https://github.com/org/backend', defaultBranch: 'main' },
      { repoUrl: 'https://github.com/org/shared', defaultBranch: 'main' },
    ])
    expect(resolveRepos(cfg, '', 'ou_alice', cfg.bots[2])).toEqual([])
    expect(resolveRepos(cfg, 'web, shared, web', 'ou_alice', cfg.bots[0])).toEqual([
      { repoUrl: 'https://github.com/org/web', defaultBranch: 'develop' },
      { repoUrl: 'https://github.com/org/shared', defaultBranch: 'main' },
    ])
  })
})
