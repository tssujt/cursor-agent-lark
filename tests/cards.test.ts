import { describe, expect, it } from 'bun:test'
import type { QuestionView, TaskView } from '../src/store/types.ts'
import { buildQuestionCard, buildTaskCard } from '../src/lark/cards.ts'

describe('Lark Card JSON 2.0 builders (stateless)', () => {
  it('renders task card and HITL question card with stateless callback payloads and custom form', () => {
    const task: TaskView = {
      agentId: 'bc-abcd',
      agentUrl: 'https://cursor.com/agents/bc-abcd',
      botId: 'backend-bot',
      runId: 'run-1',
      runStatus: 'finished',
      taskStatus: 'COMPLETED',
      name: 'Query Cache',
      prompt: 'Add query caching',
      repoUrl: 'https://github.com/acme/backend',
      branch: 'main',
      model: 'composer-2',
      larkChatId: 'oc_1',
      larkChatType: 'group',
      larkUserId: 'ou_1',
      larkRootMsgId: 'om_1',
      larkCardMsgId: 'om_2',
      lastResult: 'Added caching logic and unit tests.',
      prUrl: 'https://github.com/acme/backend/pull/42',
      pushedBranch: 'cursor/cache-opt',
      durationMs: 65_000,
      errorMessage: '',
    }

    const taskCardJson = JSON.stringify(buildTaskCard(task))
    expect(taskCardJson).toContain('"schema":"2.0"')
    expect(taskCardJson).toContain('bc-abcd')
    expect(taskCardJson).toContain('https://github.com/acme/backend/pull/42')
    expect(taskCardJson).toContain('1m5s')

    const question: QuestionView = {
      questionId: 'q-9999',
      agentId: 'bc-abcd',
      botId: 'backend-bot',
      larkChatId: 'oc_1',
      larkChatType: 'group',
      larkRootMsgId: 'om_1',
      larkUserId: 'ou_1',
      larkMsgId: '',
      question: 'What TTL should be used for the cache?',
      options: [
        { label: '5 minutes', value: '300' },
        { label: '10 minutes', value: '600' },
      ],
      customInputPlaceholder: 'Enter custom TTL...',
    }

    const qCardJson = JSON.stringify(buildQuestionCard(task, question))
    expect(qCardJson).toContain('q-9999')
    expect(qCardJson).toContain('1. 5 minutes')
    expect(qCardJson).toContain('2. 10 minutes')
    expect(qCardJson).toContain('3. Other (custom answer)')
    expect(qCardJson).toContain('Enter custom TTL...')
    expect(qCardJson).toContain('"agent_id":"bc-abcd"')
    expect(qCardJson).toContain('"owner_id":"ou_1"')
    expect(qCardJson).toContain('"root_msg_id":"om_1"')
    expect(qCardJson).toContain('"chat_type":"group"')
    expect(qCardJson).toContain('answer_question')
    expect(qCardJson).toContain('custom_answer_form')
    expect(qCardJson).toContain('answer_question_custom')

    // When no options are provided, custom input is still shown as the primary input
    const openQuestionCardJson = JSON.stringify(
      buildQuestionCard(task, {
        ...question,
        options: [],
        allowCustomInput: false,
      }),
    )
    expect(openQuestionCardJson).toContain('Your answer')
    expect(openQuestionCardJson).toContain('custom_answer_form')

    // Local runtime card renders workspace and omits empty cloud link button
    const localCardJson = JSON.stringify(
      buildTaskCard({
        ...task,
        agentId: '7b6f0f8a-8c3e-5d5a-9b1f-2c4e6f8a0b1c',
        runtime: 'local',
        agentUrl: '',
        repoUrl: '',
        cwd: '/workspace/backend',
        prUrl: '',
      }),
    )
    expect(localCardJson).toContain('`local`')
    expect(localCardJson).toContain('/workspace/backend')
    expect(localCardJson).not.toContain('Open Cursor Agent')
  })
})
