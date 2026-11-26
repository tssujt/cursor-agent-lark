import { describe, expect, it } from 'bun:test'
import type { AskUserRequest } from '../src/hitl/mcp-server.ts'
import type { SessionContext } from '../src/store/types.ts'
import { createMcpRequestHandler } from '../src/hitl/mcp-server.ts'
import { deriveAgentId, encodeMcpContext } from '../src/store/store.ts'

describe('MCP ask_user Streamable HTTP server (stateless)', () => {
  it('enforces bearer auth, decodes signed ctx, and handles initialize, tools/list, and tools/call', async () => {
    let captured: AskUserRequest | undefined
    const handler = createMcpRequestHandler({
      authToken: 'secret-token',
      onAskUser: async (req) => {
        captured = req
        return {
          questionId: 'q-12345678',
          agentId: req.agentId,
          status: 'WAITING_USER',
        }
      },
    })

    // 1. Unauthorized request rejected
    const unauth = await handler(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
    )
    expect(unauth.status).toBe(401)

    const rpc = async (url: string, body: unknown): Promise<Record<string, unknown>> => {
      const res = await handler(
        new Request(url, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer secret-token',
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify(body),
        }),
      )
      expect(res.status).toBe(200)
      return (await res.json()) as Record<string, unknown>
    }

    // 2. initialize
    const initResp = await rpc('http://localhost/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
    })
    expect((initResp.result as { serverInfo: { name: string } }).serverInfo.name).toBe(
      'cursor-agent-lark',
    )

    // 3. tools/list
    const listResp = await rpc('http://localhost/mcp', {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    })
    const tools = (listResp.result as { tools: Array<{ name: string }> }).tools
    expect(tools.map((t) => t.name)).toContain('ask_user')

    // 4. tools/call ask_user with signed stateless ctx query param
    const sessionCtx: SessionContext = {
      botId: 'backend-bot',
      chatId: 'oc_chat1',
      chatType: 'group',
      rootMsgId: 'om_root1',
      userId: 'ou_alice',
      agentId: deriveAgentId('backend-bot', 'om_root1'),
    }
    const signedCtx = encodeMcpContext(sessionCtx, 'secret-token')

    const callResp = await rpc(`http://localhost/mcp?ctx=${encodeURIComponent(signedCtx)}`, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'ask_user',
        arguments: {
          question: 'What TTL should be used for the cache?',
          options: [
            { label: '5 minutes', value: '300' },
            { label: '10 minutes', value: '600' },
          ],
          custom_input_placeholder: 'Or enter custom TTL in seconds...',
        },
      },
    })
    expect(captured).toEqual({
      context: sessionCtx,
      agentId: sessionCtx.agentId,
      question: 'What TTL should be used for the cache?',
      options: [
        { label: '5 minutes', value: '300' },
        { label: '10 minutes', value: '600' },
      ],
      customInputPlaceholder: 'Or enter custom TTL in seconds...',
    })
    expect((callResp.result as { isError: boolean }).isError).toBe(false)

    // 5. Tampered ctx signature without fallback agent_id fails gracefully
    const badResp = await rpc(
      `http://localhost/mcp?ctx=${encodeURIComponent(`${signedCtx}tampered`)}`,
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'ask_user',
          arguments: {
            question: 'Should this fail?',
          },
        },
      },
    )
    expect((badResp.result as { isError: boolean }).isError).toBe(true)
  })
})
