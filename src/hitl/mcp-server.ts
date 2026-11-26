import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { QuestionOption, SessionContext } from '../store/types.ts'
import { decodeMcpContext } from '../store/store.ts'
import { normalizeOptions } from './parser.ts'

export interface AskUserRequest {
  context?: SessionContext
  agentId: string
  question: string
  options: QuestionOption[]
  allowCustomInput?: boolean
  customInputPlaceholder?: string
}

export interface AskUserResult {
  questionId: string
  agentId: string
  status: string
}

export type AskUserHandler = (req: AskUserRequest) => Promise<AskUserResult>

const optionItemSchema = z.union([
  z.string(),
  z.object({
    label: z.string(),
    value: z.string().optional(),
  }),
])

/**
 * Stateless Web-Standard Streamable HTTP MCP handler exposing `ask_user` for Cursor Cloud Agents.
 * Extracts Lark routing context from the signed `?ctx=` query parameter so no database is required.
 */
export function createMcpRequestHandler(options: {
  authToken?: string
  onAskUser: AskUserHandler
}): (req: Request) => Promise<Response> {
  const expectedToken = options.authToken?.trim() ?? ''

  return async (req: Request): Promise<Response> => {
    if (!verifyBearerToken(req, expectedToken)) {
      return new Response('Unauthorized', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Bearer realm="mcp"' },
      })
    }

    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 })
    }

    const url = new URL(req.url)
    const ctxParam = url.searchParams.get('ctx')?.trim() ?? ''
    const decodedCtx = ctxParam ? decodeMcpContext(ctxParam, expectedToken) : null
    const fallbackAgentId = decodedCtx?.agentId || url.searchParams.get('agent_id')?.trim() || ''

    const server = new McpServer({
      name: 'cursor-agent-lark',
      version: '0.1.0',
    })

    server.registerTool(
      'ask_user',
      {
        title: 'Ask Lark User',
        description:
          'Submit a question to the Lark user for confirmation or decision. A custom free-text input option ("Other") is automatically appended as the last item in the Lark card, so do not add an "Other" option yourself. Returns immediately without blocking; finish non-dependent work or end the current run and wait for the follow-up message containing the user\'s answer.',
        inputSchema: {
          agent_id: z
            .string()
            .optional()
            .describe(
              'Optional Cursor agent ID (auto-populated from server context when omitted).',
            ),
          question: z.string().min(1).describe('Clear question for the Lark user.'),
          options: z
            .array(optionItemSchema)
            .optional()
            .describe(
              'Optional list of suggested choices (strings or {label, value} objects). A custom text input is appended automatically as the last item.',
            ),
          allow_custom_input: z
            .boolean()
            .optional()
            .describe(
              'Whether to append a custom text input as the last option (defaults to true).',
            ),
          custom_input_placeholder: z
            .string()
            .optional()
            .describe('Optional placeholder text for the custom answer input field.'),
        },
      },
      async (args) => {
        const agentId = args.agent_id?.trim() || fallbackAgentId
        const question = args.question.trim()
        if (!agentId || !question) {
          return {
            isError: true,
            content: [
              { type: 'text', text: 'Both agent context (or agent_id) and question are required' },
            ],
          }
        }

        try {
          const reqPayload: AskUserRequest = {
            context: decodedCtx ?? undefined,
            agentId,
            question,
            options: normalizeOptions(args.options),
          }
          if (args.allow_custom_input !== undefined)
            reqPayload.allowCustomInput = args.allow_custom_input
          if (args.custom_input_placeholder?.trim())
            reqPayload.customInputPlaceholder = args.custom_input_placeholder.trim()

          const res = await options.onAskUser(reqPayload)
          return {
            isError: false,
            content: [
              {
                type: 'text',
                text: `Question ${res.questionId} has been sent to the Lark user for agent ${res.agentId} (status: ${res.status}). Do NOT guess the answer. Finish any independent work if needed, then end the current run; the user's answer will arrive in a follow-up run.`,
              },
            ],
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          return {
            isError: true,
            content: [{ type: 'text', text: message }],
          }
        }
      },
    )

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })

    try {
      await server.connect(transport)
      return await transport.handleRequest(req)
    } finally {
      await transport.close()
      await server.close()
    }
  }
}

function verifyBearerToken(req: Request, expected: string): boolean {
  if (!expected) return true
  const header = req.headers.get('authorization')?.trim() ?? ''
  if (!header.startsWith('Bearer ')) return false
  const provided = header.slice('Bearer '.length).trim()
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
