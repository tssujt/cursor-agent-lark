import { describe, expect, it } from 'bun:test'
import { parseCommand } from '../src/command/parser.ts'

describe('command parser', () => {
  it('parses structured multi-line task creation messages', () => {
    const raw =
      '@_user_1 \nrepo: backend\nbranch: main\nmode: plan\npr: false\ntask: Add caching to the query endpoint\nand add unit tests.'
    const cmd = parseCommand(raw)

    expect(cmd.action).toBe('create')
    expect(cmd.isStructured).toBe(true)
    expect(cmd.repo).toBe('backend')
    expect(cmd.branch).toBe('main')
    expect(cmd.mode).toBe('plan')
    expect(cmd.autoCreatePR).toBe(false)
    expect(cmd.prompt).toBe('Add caching to the query endpoint\nand add unit tests.')
  })

  it('keeps URLs intact in repo field', () => {
    const cmd = parseCommand(
      'repo: https://github.com/acme/backend\ntask: Add health check endpoint',
    )
    expect(cmd.repo).toBe('https://github.com/acme/backend')
    expect(cmd.prompt).toBe('Add health check endpoint')
  })

  it('parses slash commands', () => {
    expect(parseCommand('@_user_1 /help').action).toBe('help')
    expect(parseCommand('/list').action).toBe('list')
    expect(parseCommand('/models').action).toBe('models')
    expect(parseCommand('/repos').action).toBe('repos')

    const st = parseCommand('/status task-12345678')
    expect(st.action).toBe('status')
    expect(st.taskId).toBe('task-12345678')

    const cancel = parseCommand('/cancel bc-abc')
    expect(cancel.action).toBe('cancel')
    expect(cancel.taskId).toBe('bc-abc')

    const fu = parseCommand('/followup task-12345678 Add Prometheus metrics')
    expect(fu.action).toBe('followup')
    expect(fu.taskId).toBe('task-12345678')
    expect(fu.prompt).toBe('Add Prometheus metrics')

    const steer = parseCommand('/steer Also cover error handling')
    expect(steer.action).toBe('steer')
    expect(steer.taskId).toBe('')
    expect(steer.prompt).toBe('Also cover error handling')
  })
})
