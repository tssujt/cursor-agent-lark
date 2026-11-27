import { randomUUID } from 'node:crypto'
import type { ParsedCommand } from '../command/parser.ts'
import type { GatewayConfig, LarkBotConfig } from '../config.ts'
import type {
  AgentRuntime,
  AgentSummary,
  CloudRepoInput,
  CreatedAgentRun,
  CursorClient,
  LocalAskUserCallback,
  McpServerSpec,
  RunSnapshot,
} from '../cursor/types.ts'
import type { AskUserRequest, AskUserResult } from '../hitl/mcp-server.ts'
import type { LarkCardEvent, LarkCardReply, LarkMessageEvent } from '../lark/bot.ts'
import type { Messenger } from '../lark/messenger.ts'
import type { Logger } from '../logger.ts'
import type { QuestionView, SessionContext, TaskStatus, TaskView } from '../store/types.ts'
import { parseCommand, stripMentions } from '../command/parser.ts'
import {
  getMcpEndpointUrl,
  isUserAllowed,
  resolveBotPolicy,
  resolveLocalWorkspace,
  resolveRepos,
} from '../config.ts'
import { buildPresetPrompt } from '../cursor/prompt.ts'
import {
  CursorAgentBusyError,
  CursorAgentConflictError,
  isCloudAgentId,
  isTerminalRunStatus,
} from '../cursor/types.ts'
import { buildAnswerFollowUp, buildHitlPrompt, extractQuestionFromResult } from '../hitl/parser.ts'
import {
  buildHelpCard,
  buildModelsCard,
  buildQuestionAnsweredCard,
  buildQuestionCard,
  buildTaskCard,
  buildTaskListCard,
} from '../lark/cards.ts'
import { noopLogger } from '../logger.ts'
import { deriveAgentId, encodeMcpContext, EphemeralCache } from '../store/store.ts'

export interface BotRuntime {
  config: LarkBotConfig
  messenger: Messenger
  cursor: CursorClient
}

/**
 * TaskManager coordinating Lark threads (1 thread = 1 Cursor Agent session) across Cloud and Local runtimes.
 * Cloud sessions are fully stateless (`agentId` + `cloud.metadata` + signed card/MCP payloads).
 */
export class TaskManager {
  private readonly bots = new Map<string, BotRuntime>()
  private readonly cache = new EphemeralCache()
  private readonly watchers = new Map<string, AbortController>()
  private readonly backgroundTasks = new Set<Promise<void>>()
  private stopped = false

  constructor(
    private readonly cfg: GatewayConfig,
    bots: BotRuntime[],
    private readonly logger: Logger = noopLogger,
  ) {
    for (const bot of bots) this.bots.set(bot.config.id, bot)
  }

  /**
   * Stateless startup recovery: queries Cursor Cloud for any running agents owned by configured bots
   * and resumes monitoring them without requiring a local database.
   */
  async start(): Promise<void> {
    const visitedCloudClients = new Set<CursorClient>()
    for (const bot of this.bots.values()) {
      const policy = resolveBotPolicy(this.cfg, bot.config)
      if (policy.runtime !== 'cloud') continue
      if (visitedCloudClients.has(bot.cursor)) continue
      visitedCloudClients.add(bot.cursor)

      let agents: AgentSummary[]
      try {
        agents = await bot.cursor.listAgents(50, { runtime: 'cloud' })
      } catch (err) {
        this.logger.warn('Failed to list cloud agents on startup', {
          error: errorMessage(err),
        })
        continue
      }

      for (const agent of agents) {
        if (agent.status !== 'running') continue
        const session = metadataToSession(agent)
        if (!session) continue
        const ownerBot = this.getBotRuntime(session.botId)
        if (!ownerBot) continue

        const latestRun = await ownerBot.cursor
          .getLatestRun(agent.agentId, { runtime: 'cloud' })
          .catch(() => null)
        if (!latestRun || isTerminalRunStatus(latestRun.status)) continue

        this.cache.sessions.set(agent.agentId, session)
        const view = buildViewFromSummary(agent, latestRun, session)
        this.logger.info('Resuming active cloud agent monitor', {
          botId: session.botId,
          agentId: agent.agentId,
          runId: latestRun.id,
        })
        this.startRunWatcher(ownerBot, view)
      }
    }
  }

  /**
   * Cancels all background watchers and waits for in-flight tasks to settle cleanly.
   */
  async stop(): Promise<void> {
    this.stopped = true
    for (const ctrl of this.watchers.values()) ctrl.abort()
    this.watchers.clear()
    await Promise.allSettled(Array.from(this.backgroundTasks))
  }

  async handleMessage(msg: LarkMessageEvent): Promise<void> {
    const bot = this.getBotRuntime(msg.botId)
    if (!bot) {
      this.logger.warn('Received message for unknown bot', { botId: msg.botId })
      return
    }

    const dedupeKey = msg.eventId
      ? `${msg.botId}:${msg.eventId}`
      : `${msg.botId}:msg:${msg.messageId}`
    if (!this.cache.processedEvents.addIfAbsent(dedupeKey)) {
      this.logger.debug('Skipping duplicate Lark event', { dedupeKey })
      return
    }

    const inThread = shouldReplyInThread(msg)

    // 1. Direct reply to a pending HITL question card -> answer that question.
    const pendingByMsg = this.findPendingQuestionForReply(msg.parentId, msg.rootId)
    if (pendingByMsg && pendingByMsg.botId === msg.botId) {
      if (!isUserAllowed(this.cfg, msg.senderId, bot.config)) {
        await bot.messenger.replyText(
          msg.messageId,
          'You do not have permission to use this Cursor Agent bot.',
          inThread,
        )
        return
      }
      const answerText = stripMentions(msg.text)
      if (!answerText) {
        await bot.messenger.replyText(
          msg.messageId,
          'Answer cannot be empty. Please reply again or click a card button.',
          inThread,
        )
        return
      }
      await this.submitTextAnswer(bot, msg, pendingByMsg, answerText, inThread)
      return
    }

    const strippedText = stripMentions(msg.text)
    const startsWithSlash = strippedText.startsWith('/')
    const parsed = parseCommand(msg.text)
    const isExplicitNew = /^\/(?:new|create|run)\b/i.test(strippedText)

    // 2. One thread = one Agent session: resolve existing session for messages inside a thread or reply.
    const existingSession =
      msg.threadId || msg.rootId || msg.parentId
        ? await this.resolveSessionFromReply(bot, msg)
        : null

    if (existingSession && !isExplicitNew && (!startsWithSlash || parsed.action === 'create')) {
      if (!isUserAllowed(this.cfg, msg.senderId, bot.config)) {
        await bot.messenger.replyText(
          msg.messageId,
          'You do not have permission to use this Cursor Agent bot.',
          inThread,
        )
        return
      }
      const followText = parsed.action === 'create' ? parsed.prompt || strippedText : strippedText
      const pendingQ = this.cache.pendingQuestions.get(existingSession.agentId)
      if (pendingQ) {
        await this.submitTextAnswer(bot, msg, pendingQ, followText, inThread)
        return
      }
      await this.followUpSession(bot, msg, existingSession, followText, false)
      return
    }

    const policy = resolveBotPolicy(this.cfg, bot.config)
    const isTopLevelMessage = !msg.rootId && !msg.parentId
    const canAutoCreateInGroup = !policy.requireMention && isTopLevelMessage

    // In group chats, ignore messages that neither mention the bot, belong to an active bot session thread,
    // nor qualify for automatic top-level thread creation when require_mention is disabled.
    if (msg.chatType === 'group' && !msg.mentioned && !existingSession && !canAutoCreateInGroup) {
      this.logger.info('Ignoring Lark group message', {
        botId: bot.config.id,
        messageId: msg.messageId,
        chatId: msg.chatId,
        mentioned: msg.mentioned,
        requireMention: policy.requireMention,
        isTopLevel: isTopLevelMessage,
      })
      return
    }

    if (!isUserAllowed(this.cfg, msg.senderId, bot.config)) {
      this.logger.warn('Rejected unauthorized Lark user', {
        botId: bot.config.id,
        messageId: msg.messageId,
        chatId: msg.chatId,
        senderId: msg.senderId,
      })
      await bot.messenger.replyText(
        msg.messageId,
        'You do not have permission to use this Cursor Agent bot.',
        inThread,
      )
      return
    }

    // If the user replied to / quoted a message (e.g. an alert card) and mentioned the bot to start a new session,
    // fetch the quoted message content and include it in the user message.
    const quotedMsgId = !existingSession ? msg.parentId || msg.rootId : ''
    let effectiveParsed = parsed
    if (
      quotedMsgId &&
      (parsed.action === 'create' || (parsed.action === 'help' && !strippedText))
    ) {
      const quotedText = await this.fetchQuotedMessageText(bot, quotedMsgId)
      if (quotedText) {
        const combinedPrompt = parsed.prompt
          ? `[Quoted Message]\n${quotedText}\n\n${parsed.prompt}`
          : quotedText
        effectiveParsed = {
          ...parsed,
          action: 'create',
          prompt: combinedPrompt,
        }
      }
    }

    switch (effectiveParsed.action) {
      case 'help':
        await bot.messenger.replyCard(
          msg.messageId,
          buildHelpCard(Boolean(getMcpEndpointUrl(this.cfg)), bot.config.name),
          inThread,
        )
        return
      case 'list':
        await this.handleListCommand(bot, msg, inThread)
        return
      case 'repos':
        await this.replyReposList(bot, msg.messageId, inThread)
        return
      case 'models':
        await this.replyModelsList(bot, msg.messageId, inThread)
        return
      case 'status':
        await this.handleStatusCommand(bot, msg, effectiveParsed.taskId, inThread)
        return
      case 'cancel':
        await this.handleCancelCommand(bot, msg, effectiveParsed.taskId, inThread)
        return
      case 'followup':
        if (!effectiveParsed.prompt) {
          await bot.messenger.replyText(
            msg.messageId,
            'Please provide follow-up instructions, e.g. `/followup Add unit tests`.',
            inThread,
          )
          return
        }
        await this.handleFollowUpCommand(
          bot,
          msg,
          effectiveParsed.taskId,
          effectiveParsed.prompt,
          false,
          inThread,
        )
        return
      case 'steer':
        if (!effectiveParsed.prompt) {
          await bot.messenger.replyText(
            msg.messageId,
            'Please provide steer instructions, e.g. `/steer Also add metrics`.',
            inThread,
          )
          return
        }
        await this.handleFollowUpCommand(
          bot,
          msg,
          effectiveParsed.taskId,
          effectiveParsed.prompt,
          true,
          inThread,
        )
        return
      case 'create':
        if (!effectiveParsed.prompt) {
          await bot.messenger.replyCard(
            msg.messageId,
            buildHelpCard(Boolean(getMcpEndpointUrl(this.cfg)), bot.config.name),
            inThread,
          )
          return
        }
        await this.createSession(bot, msg, effectiveParsed, inThread)
    }
  }

  async createSession(
    bot: BotRuntime,
    msg: LarkMessageEvent,
    parsed: ParsedCommand,
    inThread: boolean,
  ): Promise<void> {
    const policy = resolveBotPolicy(this.cfg, bot.config)
    const runtime: AgentRuntime = policy.runtime
    const modelId = parsed.model || policy.defaultModel
    const mode = parsed.mode ?? policy.defaultMode
    const rootMsgId = msg.rootId || msg.messageId
    const agentId = deriveAgentId(bot.config.id, rootMsgId, runtime)

    let repoUrl = ''
    let repoUrls: string[] = []
    let cloudRepos: CloudRepoInput[] = []
    let branch = ''
    let cwd = ''

    if (runtime === 'local') {
      try {
        const ws = resolveLocalWorkspace(this.cfg, parsed.repo, msg.senderId, bot.config)
        cwd = ws.cwd
      } catch (err) {
        await bot.messenger.replyText(
          msg.messageId,
          `Failed to create session: ${errorMessage(err)}`,
          inThread,
        )
        return
      }
      if (!modelId) {
        await bot.messenger.replyText(
          msg.messageId,
          'Failed to create session: Local runtime requires a model. Set `default_model` in config or pass `model: <id>`.',
          inThread,
        )
        return
      }
    } else {
      try {
        const resolvedRepos = resolveRepos(this.cfg, parsed.repo, msg.senderId, bot.config)
        cloudRepos = resolvedRepos.map((r) => ({
          url: r.repoUrl,
          startingRef: parsed.branch || r.defaultBranch || undefined,
        }))
        repoUrls = cloudRepos.map((r) => r.url)
        repoUrl = repoUrls[0] ?? ''
        branch = cloudRepos[0]?.startingRef ?? ''
      } catch (err) {
        await bot.messenger.replyText(
          msg.messageId,
          `Failed to create session: ${errorMessage(err)}`,
          inThread,
        )
        return
      }
    }

    const autoCreatePR = parsed.autoCreatePR ?? policy.autoCreatePR
    const session: SessionContext = {
      botId: bot.config.id,
      chatId: msg.chatId,
      chatType: msg.chatType || 'group',
      rootMsgId,
      userId: msg.senderId,
      agentId,
      runtime,
      cwd: cwd || undefined,
    }

    const mcpServers = this.buildMcpServersForSession(bot, session)
    const fullPrompt = buildHitlPrompt(
      buildPresetPrompt(parsed.prompt, policy.presetPrompt),
      agentId,
      {
        useMcp: runtime === 'local' || Boolean(getMcpEndpointUrl(this.cfg)),
        enablePromptFallback: this.cfg.hitl.enablePromptFallback,
      },
    )

    let created: CreatedAgentRun
    try {
      created = await bot.cursor.createAgentAndRun(
        runtime === 'local'
          ? {
              runtime: 'local',
              agentId,
              name: deriveTaskName(parsed.name, parsed.prompt),
              prompt: fullPrompt,
              cwd,
              dirs: policy.localDirs.length > 0 ? policy.localDirs : undefined,
              sandbox: policy.localSandbox,
              autoReview: policy.localAutoReview,
              settingSources:
                policy.localSettingSources.length > 0 ? policy.localSettingSources : undefined,
              modelId,
              mode,
              mcpServers: mcpServers.length > 0 ? mcpServers : undefined,
              onLocalAskUser: this.createLocalAskUserCallback(session),
            }
          : {
              runtime: 'cloud',
              agentId,
              name: deriveTaskName(parsed.name, parsed.prompt),
              prompt: fullPrompt,
              repoUrl: repoUrl || undefined,
              startingRef: branch || undefined,
              repos: cloudRepos.length > 0 ? cloudRepos : undefined,
              modelId: modelId || undefined,
              mode,
              autoCreatePR,
              workOnCurrentBranch: policy.workOnCurrentBranch,
              skipReviewerRequest: policy.skipReviewerRequest,
              mcpServers: mcpServers.length > 0 ? mcpServers : undefined,
              metadata: sessionToMetadata(session, repoUrls, branch),
            },
      )
    } catch (err) {
      // Deterministic agentId protects against duplicate Lark event deliveries even across restarts.
      if (err instanceof CursorAgentConflictError) {
        this.logger.info('Ignoring duplicate agent creation (409 conflict)', {
          botId: bot.config.id,
          agentId,
        })
        return
      }
      this.logger.error('Failed to create Cursor Agent', {
        botId: bot.config.id,
        runtime,
        agentId,
        error: errorMessage(err),
      })
      await bot.messenger.replyText(
        msg.messageId,
        `Failed to create Cursor Agent: ${errorMessage(err)}`,
        inThread,
      )
      return
    }

    this.cache.sessions.set(created.agentId, { ...session, agentId: created.agentId })

    const view: TaskView = {
      agentId: created.agentId,
      runtime: created.runtime,
      agentUrl: created.agentUrl,
      botId: bot.config.id,
      runId: created.run.id,
      runStatus: created.run.status,
      taskStatus: mapRunStatusToTaskStatus(created.run.status),
      name: created.name,
      prompt: parsed.prompt,
      repoUrl,
      repoUrls: repoUrls.length > 0 ? repoUrls : undefined,
      cwd: cwd || undefined,
      branch,
      model: modelId,
      larkChatId: session.chatId,
      larkChatType: session.chatType,
      larkUserId: session.userId,
      larkRootMsgId: session.rootMsgId,
      larkCardMsgId: '',
      lastResult: '',
      prUrl: '',
      pushedBranch: '',
      durationMs: 0,
      errorMessage: '',
    }

    try {
      const reply = await bot.messenger.replyCard(msg.messageId, buildTaskCard(view), inThread)
      view.larkCardMsgId = reply.messageId
      if (reply.messageId) this.cache.cardMsgIds.set(view.agentId, reply.messageId)
    } catch (err) {
      this.logger.error('Failed to send Lark task card', {
        botId: bot.config.id,
        agentId: view.agentId,
        error: errorMessage(err),
      })
    }

    this.startRunWatcher(bot, view)
  }

  /**
   * Called by the built-in MCP `ask_user` server or Prompt-JSON parser to pause for user confirmation.
   */
  async handleAskUser(req: AskUserRequest): Promise<AskUserResult> {
    const session =
      req.context ??
      this.cache.sessions.get(req.agentId) ??
      (await this.findSessionInCloud(req.agentId))
    if (!session) throw new Error(`Session context for agent "${req.agentId}" not found`)

    const bot = this.getBotRuntime(session.botId)
    if (!bot)
      throw new Error(`Bot "${session.botId}" for agent "${session.agentId}" is not configured`)

    this.cache.sessions.set(session.agentId, session)

    const question: QuestionView = {
      questionId: `q-${randomUUID().slice(0, 8)}`,
      agentId: session.agentId,
      runtime: session.runtime,
      cwd: session.cwd,
      botId: session.botId,
      larkChatId: session.chatId,
      larkChatType: session.chatType,
      larkRootMsgId: session.rootMsgId,
      larkUserId: session.userId,
      larkMsgId: '',
      question: req.question,
      options: req.options,
      allowCustomInput: req.allowCustomInput,
      customInputPlaceholder: req.customInputPlaceholder,
    }

    const view = this.createMinimalView(session, 'WAITING_USER')
    await this.refreshCardIfKnown(
      bot,
      view,
      `Agent asked a question (\`${question.questionId}\`). Please confirm below.`,
    )

    const card = buildQuestionCard(view, question)
    const inThread = isThreadSession(session.chatType)
    const replyTarget = session.rootMsgId || this.cache.cardMsgIds.get(session.agentId) || ''
    if (replyTarget) {
      const reply = await bot.messenger.replyCard(replyTarget, card, inThread)
      question.larkMsgId = reply.messageId
    } else {
      question.larkMsgId = await bot.messenger.sendCard(session.chatId, card)
    }

    this.cache.setPendingQuestion(question)

    return {
      questionId: question.questionId,
      agentId: session.agentId,
      status: 'WAITING_USER',
    }
  }

  /**
   * Stateless synchronous handler for Lark `card.action.trigger` callbacks (must respond within 3s).
   * All required routing fields are carried directly in the card callback payload.
   */
  async handleCardAction(ev: LarkCardEvent): Promise<LarkCardReply> {
    const bot = this.getBotRuntime(ev.botId)
    if (!bot) return { toastType: 'error', toastText: 'Bot is not configured' }

    const action = stringVal(ev.actionValue.action)
    switch (action) {
      case 'answer_question':
      case 'answer_question_custom':
        return this.handleAnswerCardAction(bot, ev, action === 'answer_question_custom')
      case 'cancel_task':
        return this.handleCancelCardAction(bot, ev)
      case 'refresh_task':
        return this.handleRefreshCardAction(bot, ev)
      default:
        return { toastType: 'info', toastText: 'Unknown action' }
    }
  }

  private async handleAnswerCardAction(
    bot: BotRuntime,
    ev: LarkCardEvent,
    isCustom: boolean,
  ): Promise<LarkCardReply> {
    const questionId = stringVal(ev.actionValue.question_id)
    const agentId = stringVal(ev.actionValue.agent_id)
    const ownerId = stringVal(ev.actionValue.owner_id)
    const questionText = stringVal(ev.actionValue.question)
    const rootMsgId = stringVal(ev.actionValue.root_msg_id)
    const chatType = stringVal(ev.actionValue.chat_type) || 'group'

    if (!questionId || !agentId)
      return { toastType: 'error', toastText: 'Invalid question payload' }

    if (!this.cfg.hitl.allowAnyChatMemberAnswer && ownerId && ownerId !== ev.operatorOpenId)
      return {
        toastType: 'warning',
        toastText: 'Only the session creator can confirm this question',
      }

    const answer = (
      isCustom
        ? stringVal(ev.formValue.custom_answer) || stringVal(ev.inputValue)
        : stringVal(ev.actionValue.answer)
    ).trim()
    const display = (isCustom ? answer : stringVal(ev.actionValue.label).trim()) || answer
    if (!answer)
      return { toastType: 'warning', toastText: 'Please enter an answer before submitting' }

    if (!this.cache.answeredQuestions.addIfAbsent(questionId))
      return { toastType: 'warning', toastText: 'This question has already been answered' }

    this.cache.clearPendingQuestion(agentId, questionId)

    const policy = resolveBotPolicy(this.cfg, bot.config)
    const runtime: AgentRuntime =
      ev.actionValue.runtime === 'local'
        ? 'local'
        : isCloudAgentId(agentId)
          ? 'cloud'
          : policy.runtime
    const cwd = stringVal(ev.actionValue.cwd) || (runtime === 'local' ? policy.localCwd : '')

    const session: SessionContext = this.cache.sessions.get(agentId) ?? {
      botId: bot.config.id,
      chatId: ev.chatId,
      chatType,
      rootMsgId,
      userId: ownerId || ev.operatorOpenId,
      agentId,
      runtime,
      cwd: cwd || undefined,
    }
    this.cache.sessions.set(agentId, session)

    const agentUrl = runtime === 'cloud' ? `https://cursor.com/agents/${agentId}` : ''

    // Resume Cursor Agent asynchronously so Lark receives the card callback response immediately.
    this.trackBackground(
      this.resumeAfterAnswer(bot, session, questionId, questionText, answer, display, ev.messageId),
    )

    return {
      toastType: 'success',
      toastText: 'Answer confirmed. Resuming Agent...',
      card: buildQuestionAnsweredCard(
        agentId,
        agentUrl,
        questionId,
        questionText,
        display,
        'Your confirmed answer has been sent to Cursor Agent.',
      ),
    }
  }

  private async resumeAfterAnswer(
    bot: BotRuntime,
    session: SessionContext,
    questionId: string,
    questionText: string,
    answer: string,
    display: string,
    questionMsgId: string,
  ): Promise<void> {
    const prompt = buildAnswerFollowUp(questionId, questionText, answer)
    try {
      const note = await this.dispatchFollowUpOrSteer(bot, session, prompt, false)
      this.logger.info('Resumed agent after user answer', {
        botId: bot.config.id,
        agentId: session.agentId,
        questionId,
        note,
      })
      if (questionMsgId) {
        const agentUrl =
          session.runtime === 'local' ? '' : `https://cursor.com/agents/${session.agentId}`
        await bot.messenger.updateCard(
          questionMsgId,
          buildQuestionAnsweredCard(
            session.agentId,
            agentUrl,
            questionId,
            questionText,
            display,
            note,
          ),
        )
      }
    } catch (err) {
      this.logger.error('Failed to resume agent after answer', {
        botId: bot.config.id,
        agentId: session.agentId,
        questionId,
        error: errorMessage(err),
      })
      const errText = `Failed to resume session \`${session.agentId}\`: ${errorMessage(err)}`
      if (session.rootMsgId)
        await bot.messenger.replyText(session.rootMsgId, errText, isThreadSession(session.chatType))
      else if (session.chatId) await bot.messenger.sendText(session.chatId, errText)
    }
  }

  private async handleFollowUpCommand(
    bot: BotRuntime,
    msg: LarkMessageEvent,
    explicitAgentId: string,
    promptText: string,
    preferSteer: boolean,
    inThread: boolean,
  ): Promise<void> {
    const session = await this.resolveSessionForCommand(bot, msg, explicitAgentId)
    if (!session) {
      await bot.messenger.replyText(
        msg.messageId,
        'Session not found. Reply inside the session thread or quote a session card.',
        inThread,
      )
      return
    }
    await this.followUpSession(bot, msg, session, promptText, preferSteer)
  }

  private async followUpSession(
    bot: BotRuntime,
    msg: LarkMessageEvent,
    session: SessionContext,
    promptText: string,
    preferSteer: boolean,
  ): Promise<void> {
    const inThread = shouldReplyInThread(msg)
    if (
      !this.cfg.hitl.allowAnyChatMemberAnswer &&
      session.userId &&
      session.userId !== msg.senderId
    ) {
      await bot.messenger.replyText(
        msg.messageId,
        'Only the session creator can send follow-up instructions to this Agent.',
        inThread,
      )
      return
    }

    try {
      const note = await this.dispatchFollowUpOrSteer(bot, session, promptText, preferSteer)
      await bot.messenger.replyText(msg.messageId, note, inThread)
    } catch (err) {
      await bot.messenger.replyText(
        msg.messageId,
        `Failed to send follow-up: ${errorMessage(err)}`,
        inThread,
      )
    }
  }

  private async dispatchFollowUpOrSteer(
    bot: BotRuntime,
    session: SessionContext,
    promptText: string,
    preferSteer: boolean,
  ): Promise<string> {
    const policy = resolveBotPolicy(this.cfg, bot.config)
    const runtime: AgentRuntime =
      session.runtime ?? (isCloudAgentId(session.agentId) ? 'cloud' : policy.runtime)
    const cwd = session.cwd || (runtime === 'local' ? policy.localCwd : '')
    const lookup = {
      runtime,
      cwd: cwd || undefined,
    }

    const latestRun = await bot.cursor.getLatestRun(session.agentId, lookup).catch(() => null)
    const isActive = Boolean(latestRun && !isTerminalRunStatus(latestRun.status))

    const trySteer = async (): Promise<string | null> => {
      if (!this.cfg.cursor.enableSteer) return null
      const res = await bot.cursor.steerRun(session.agentId, promptText, lookup)
      if (res.delivery === 'unavailable') return null
      if (res.delivery === 'steered') {
        const activeRunId = res.runId || latestRun?.id || ''
        const view = this.createMinimalView(session, 'RUNNING', activeRunId, 'running')
        await this.refreshCardIfKnown(bot, view, 'Steer instruction delivered to active run.')
        if (activeRunId) this.startRunWatcher(bot, view)
        return `Steered active session \`${session.agentId}\`.`
      }
      const view = this.createMinimalView(
        session,
        'RUNNING',
        res.runId || latestRun?.id || '',
        'running',
      )
      await this.refreshCardIfKnown(bot, view, 'Follow-up queued for the Agent.')
      if (res.runId && res.runId !== latestRun?.id) this.startRunWatcher(bot, view)
      else this.discoverAndWatchLatestRun(bot, session, latestRun?.id || '')
      return `Instruction queued for session \`${session.agentId}\`.`
    }

    if (preferSteer || isActive) {
      const steeredMsg = await trySteer()
      if (steeredMsg) return steeredMsg

      if (isActive) {
        this.cache.enqueueFollowUp(session.agentId, promptText)
        return `Session \`${session.agentId}\` is currently running. Your instruction has been queued and will be sent automatically once the active run finishes.`
      }
    }

    const mcpServers = this.buildMcpServersForSession(bot, session)
    try {
      const nextRun = await bot.cursor.sendFollowUp(
        runtime === 'local'
          ? {
              agentId: session.agentId,
              runtime: 'local',
              prompt: promptText,
              modelId: policy.defaultModel || undefined,
              cwd: cwd || undefined,
              dirs: policy.localDirs.length > 0 ? policy.localDirs : undefined,
              sandbox: policy.localSandbox,
              autoReview: policy.localAutoReview,
              settingSources:
                policy.localSettingSources.length > 0 ? policy.localSettingSources : undefined,
              mcpServers: mcpServers.length > 0 ? mcpServers : undefined,
              onLocalAskUser: this.createLocalAskUserCallback(session),
            }
          : {
              agentId: session.agentId,
              runtime: 'cloud',
              prompt: promptText,
              mcpServers: mcpServers.length > 0 ? mcpServers : undefined,
            },
      )
      const view = this.createMinimalView(session, 'RUNNING', nextRun.id, nextRun.status)
      await this.refreshCardIfKnown(bot, view, 'Follow-up run started.')
      this.startRunWatcher(bot, view)
      return `Sent follow-up to session \`${session.agentId}\` (run \`${nextRun.id}\`).`
    } catch (err) {
      if (err instanceof CursorAgentBusyError) {
        const steeredMsg = await trySteer().catch(() => null)
        if (steeredMsg) return steeredMsg
        this.cache.enqueueFollowUp(session.agentId, promptText)
        return `Session \`${session.agentId}\` is busy. Your instruction has been queued and will be dispatched once the active run ends.`
      }
      throw err
    }
  }

  private async handleCancelCardAction(bot: BotRuntime, ev: LarkCardEvent): Promise<LarkCardReply> {
    const agentId = stringVal(ev.actionValue.agent_id)
    const ownerId = stringVal(ev.actionValue.owner_id)
    const rootMsgId = stringVal(ev.actionValue.root_msg_id)
    const chatType = stringVal(ev.actionValue.chat_type) || 'group'
    if (!agentId) return { toastType: 'error', toastText: 'Missing agent ID' }

    if (!this.cfg.hitl.allowAnyChatMemberAnswer && ownerId && ownerId !== ev.operatorOpenId)
      return { toastType: 'warning', toastText: 'Only the session creator can cancel this session' }

    const policy = resolveBotPolicy(this.cfg, bot.config)
    const runtime: AgentRuntime =
      ev.actionValue.runtime === 'local'
        ? 'local'
        : isCloudAgentId(agentId)
          ? 'cloud'
          : policy.runtime
    const cwd = stringVal(ev.actionValue.cwd) || (runtime === 'local' ? policy.localCwd : '')

    const session: SessionContext = this.cache.sessions.get(agentId) ?? {
      botId: bot.config.id,
      chatId: ev.chatId,
      chatType,
      rootMsgId,
      userId: ownerId,
      agentId,
      runtime,
      cwd: cwd || undefined,
    }

    try {
      const view = await this.cancelSessionInternal(bot, session)
      return {
        toastType: 'success',
        toastText: 'Session cancelled',
        card: buildTaskCard(view, 'Session cancelled by user.'),
      }
    } catch (err) {
      return { toastType: 'error', toastText: `Cancel failed: ${errorMessage(err)}` }
    }
  }

  private async handleRefreshCardAction(
    bot: BotRuntime,
    ev: LarkCardEvent,
  ): Promise<LarkCardReply> {
    const agentId = stringVal(ev.actionValue.agent_id)
    if (!agentId) return { toastType: 'error', toastText: 'Missing agent ID' }

    const policy = resolveBotPolicy(this.cfg, bot.config)
    const runtime: AgentRuntime =
      ev.actionValue.runtime === 'local'
        ? 'local'
        : isCloudAgentId(agentId)
          ? 'cloud'
          : policy.runtime
    const cwd = stringVal(ev.actionValue.cwd) || (runtime === 'local' ? policy.localCwd : '')

    try {
      const view = await this.loadLiveTaskView(bot, agentId, ev.chatId, {
        runtime,
        cwd: cwd || undefined,
      })
      if (!view) return { toastType: 'error', toastText: 'Session not found' }
      return {
        toastType: 'success',
        toastText: 'Status refreshed',
        card: buildTaskCard(view),
      }
    } catch (err) {
      return { toastType: 'error', toastText: `Refresh failed: ${errorMessage(err)}` }
    }
  }

  private async handleListCommand(
    bot: BotRuntime,
    msg: LarkMessageEvent,
    inThread: boolean,
  ): Promise<void> {
    const policy = resolveBotPolicy(this.cfg, bot.config)
    try {
      if (policy.runtime === 'local') {
        const agents = await bot.cursor.listAgents(20, {
          runtime: 'local',
          cwd: policy.localCwd || undefined,
        })
        const matching = agents
          .slice(0, 10)
          .map((a) =>
            buildViewFromSummary(
              a,
              null,
              fallbackSession(
                bot.config.id,
                msg.chatId,
                a.agentId,
                msg.chatType,
                'local',
                a.cwd || policy.localCwd,
              ),
            ),
          )
        await bot.messenger.replyCard(msg.messageId, buildTaskListCard(matching), inThread)
        return
      }

      const agents = await bot.cursor.listAgents(50, { runtime: 'cloud' })
      const matching = agents
        .filter(
          (a) => a.metadata.lark_bot_id === bot.config.id && a.metadata.lark_chat_id === msg.chatId,
        )
        .slice(0, 10)
        .map((a) =>
          buildViewFromSummary(
            a,
            null,
            metadataToSession(a) ?? fallbackSession(bot.config.id, msg.chatId, a.agentId),
          ),
        )
      await bot.messenger.replyCard(msg.messageId, buildTaskListCard(matching), inThread)
    } catch (err) {
      await bot.messenger.replyText(
        msg.messageId,
        `Failed to list sessions: ${errorMessage(err)}`,
        inThread,
      )
    }
  }

  private async handleStatusCommand(
    bot: BotRuntime,
    msg: LarkMessageEvent,
    explicitAgentId: string,
    inThread: boolean,
  ): Promise<void> {
    const session = await this.resolveSessionForCommand(bot, msg, explicitAgentId)
    if (!session) {
      await bot.messenger.replyText(
        msg.messageId,
        'No session found. Use `/list` to view recent sessions.',
        inThread,
      )
      return
    }
    const view = await this.loadLiveTaskView(bot, session.agentId, msg.chatId, {
      runtime: session.runtime,
      cwd: session.cwd,
    })
    if (!view) {
      await bot.messenger.replyText(msg.messageId, 'Session not found.', inThread)
      return
    }
    await bot.messenger.replyCard(msg.messageId, buildTaskCard(view), inThread)
  }

  private async handleCancelCommand(
    bot: BotRuntime,
    msg: LarkMessageEvent,
    explicitAgentId: string,
    inThread: boolean,
  ): Promise<void> {
    const session = await this.resolveSessionForCommand(bot, msg, explicitAgentId)
    if (!session) {
      await bot.messenger.replyText(msg.messageId, 'No session found to cancel.', inThread)
      return
    }
    if (
      !this.cfg.hitl.allowAnyChatMemberAnswer &&
      session.userId &&
      session.userId !== msg.senderId
    ) {
      await bot.messenger.replyText(
        msg.messageId,
        'Only the session creator can cancel this session.',
        inThread,
      )
      return
    }
    try {
      await this.cancelSessionInternal(bot, session)
      await bot.messenger.replyText(
        msg.messageId,
        `Session \`${session.agentId}\` cancelled.`,
        inThread,
      )
    } catch (err) {
      await bot.messenger.replyText(
        msg.messageId,
        `Failed to cancel session: ${errorMessage(err)}`,
        inThread,
      )
    }
  }

  private async cancelSessionInternal(bot: BotRuntime, session: SessionContext): Promise<TaskView> {
    const lookup = {
      runtime: session.runtime,
      cwd: session.cwd,
    }
    const latestRun = await bot.cursor.getLatestRun(session.agentId, lookup).catch(() => null)
    if (latestRun) {
      this.stopRunWatcher(session.agentId, latestRun.id)
      if (!isTerminalRunStatus(latestRun.status))
        await bot.cursor.cancelRun(session.agentId, latestRun.id, lookup)
    }
    this.cache.drainFollowUps(session.agentId)
    this.cache.clearPendingQuestion(session.agentId)

    const view = this.createMinimalView(session, 'CANCELLED', latestRun?.id ?? '', 'cancelled')
    await this.refreshCardIfKnown(bot, view, 'Session cancelled.')
    return view
  }

  private startRunWatcher(bot: BotRuntime, initialView: TaskView): void {
    const { agentId, runId } = initialView
    if (this.stopped || !agentId || !runId) return
    const key = `${agentId}:${runId}`
    if (this.watchers.has(key)) return

    const ctrl = new AbortController()
    this.watchers.set(key, ctrl)

    const view: TaskView = { ...initialView }
    const job = (async () => {
      try {
        const finalSnap = await bot.cursor.waitForRun(agentId, runId, {
          signal: ctrl.signal,
          useSSE: this.cfg.cursor.useSSE,
          pollIntervalMs: this.cfg.cursor.pollIntervalMs,
          runtime: view.runtime,
          cwd: view.cwd,
          onStatus: (status) => {
            if (view.runStatus !== status) {
              view.runStatus = status
              if (view.taskStatus === 'CREATING' && status === 'running')
                view.taskStatus = 'RUNNING'
              if (!isTerminalRunStatus(status)) void this.refreshCardIfKnown(bot, view)
            }
          },
        })
        if (ctrl.signal.aborted) return

        applyRunSnapshot(view, finalSnap)
        await this.finalizeRun(bot, view, finalSnap)
      } catch (err) {
        if (!ctrl.signal.aborted && !this.stopped) {
          this.logger.warn('Run watcher ended with error', {
            botId: bot.config.id,
            agentId,
            runId,
            error: errorMessage(err),
          })
        }
      } finally {
        this.watchers.delete(key)
      }
    })()

    this.trackBackground(job)
  }

  private stopRunWatcher(agentId: string, runId: string): void {
    const key = `${agentId}:${runId}`
    const ctrl = this.watchers.get(key)
    if (ctrl) {
      ctrl.abort()
      this.watchers.delete(key)
    }
  }

  private discoverAndWatchLatestRun(
    bot: BotRuntime,
    session: SessionContext,
    prevRunId: string,
  ): void {
    const job = (async () => {
      const deadline = Date.now() + 60_000
      while (!this.stopped && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2_000))
        if (this.stopped) return
        const latest = await bot.cursor
          .getLatestRun(session.agentId, {
            runtime: session.runtime,
            cwd: session.cwd,
          })
          .catch(() => null)
        if (latest && latest.id !== prevRunId) {
          const view = this.createMinimalView(session, 'RUNNING', latest.id, latest.status)
          this.startRunWatcher(bot, view)
          return
        }
      }
    })()
    this.trackBackground(job)
  }

  private async finalizeRun(bot: BotRuntime, view: TaskView, snap: RunSnapshot): Promise<void> {
    const session: SessionContext = this.cache.sessions.get(view.agentId) ?? {
      botId: bot.config.id,
      chatId: view.larkChatId,
      chatType: view.larkChatType || 'group',
      rootMsgId: view.larkRootMsgId,
      userId: view.larkUserId,
      agentId: view.agentId,
      runtime: view.runtime,
      cwd: view.cwd,
    }

    // 1. Auto-dispatch queued follow-up/answer if Steer was unavailable.
    const queued = this.cache.drainFollowUps(view.agentId)
    if (queued && snap.status !== 'cancelled') {
      try {
        await this.dispatchFollowUpOrSteer(bot, session, queued, false)
        return
      } catch (err) {
        this.logger.error('Failed to dispatch queued follow-up', {
          botId: bot.config.id,
          agentId: view.agentId,
          error: errorMessage(err),
        })
      }
    }

    // 2. If MCP `ask_user` opened a PENDING question during the run, keep WAITING_USER.
    const pendingQ = this.cache.pendingQuestions.get(view.agentId)
    if (pendingQ) {
      view.taskStatus = 'WAITING_USER'
      await this.refreshCardIfKnown(
        bot,
        view,
        `Run ended. Waiting for your answer to \`${pendingQ.questionId}\` before continuing.`,
      )
      return
    }

    // 3. Prompt-JSON HITL fallback when MCP ask_user was not called.
    if (snap.status === 'finished' && this.cfg.hitl.enablePromptFallback && snap.result) {
      const parsedQ = extractQuestionFromResult(snap.result)
      if (parsedQ) {
        await this.handleAskUser({
          context: session,
          agentId: view.agentId,
          question: parsedQ.question,
          options: parsedQ.options,
          allowCustomInput: parsedQ.allowCustomInput,
          customInputPlaceholder: parsedQ.customInputPlaceholder,
        })
        return
      }
    }

    // 4. Normal terminal transition.
    if (snap.status === 'finished') {
      view.taskStatus = 'COMPLETED'
      view.errorMessage = ''
    } else if (snap.status === 'cancelled') {
      view.taskStatus = 'CANCELLED'
    } else {
      view.taskStatus = 'FAILED'
      if (!view.errorMessage)
        view.errorMessage = snap.errorMessage || `Cursor run ended with status ${snap.status}`
    }

    const updatedInPlace = await this.refreshCardIfKnown(bot, view)
    await this.sendCompletionNotification(bot, view, !updatedInPlace)
  }

  private async sendCompletionNotification(
    bot: BotRuntime,
    view: TaskView,
    postFullCard: boolean,
  ): Promise<void> {
    const inThread = isThreadSession(view.larkChatType)
    const replyTarget = view.larkRootMsgId || this.cache.cardMsgIds.get(view.agentId) || ''

    // If the process restarted mid-run and lost the original cardMsgId, post the final status card directly.
    if (postFullCard) {
      if (replyTarget) await bot.messenger.replyCard(replyTarget, buildTaskCard(view), inThread)
      else if (view.larkChatId) await bot.messenger.sendCard(view.larkChatId, buildTaskCard(view))
      return
    }

    let text = ''
    if (view.taskStatus === 'COMPLETED') {
      text = `Session \`${view.agentId}\` completed.`
      if (view.prUrl) text += `\nPR: ${view.prUrl}`
    } else if (view.taskStatus === 'FAILED') {
      text = `Session \`${view.agentId}\` failed (${view.runStatus}).`
    } else {
      return
    }

    if (replyTarget) await bot.messenger.replyText(replyTarget, text, inThread)
    else if (view.larkChatId) await bot.messenger.sendText(view.larkChatId, text)
  }

  private async refreshCardIfKnown(bot: BotRuntime, view: TaskView, note = ''): Promise<boolean> {
    const cardMsgId = view.larkCardMsgId || this.cache.cardMsgIds.get(view.agentId) || ''
    if (!cardMsgId) return false
    try {
      await bot.messenger.updateCard(cardMsgId, buildTaskCard(view, note))
      return true
    } catch (err) {
      this.logger.warn('Failed to update Lark task card', {
        botId: bot.config.id,
        agentId: view.agentId,
        msgId: cardMsgId,
        error: errorMessage(err),
      })
      return false
    }
  }

  private async submitTextAnswer(
    bot: BotRuntime,
    msg: LarkMessageEvent,
    q: QuestionView,
    answerText: string,
    inThread: boolean,
  ): Promise<void> {
    const res = await this.handleCardAction({
      botId: msg.botId,
      operatorOpenId: msg.senderId,
      chatId: msg.chatId,
      messageId: q.larkMsgId,
      actionValue: {
        action: 'answer_question',
        question_id: q.questionId,
        agent_id: q.agentId,
        runtime: q.runtime ?? 'cloud',
        cwd: q.cwd ?? '',
        owner_id: q.larkUserId,
        root_msg_id: q.larkRootMsgId,
        chat_type: q.larkChatType,
        question: q.question,
        answer: answerText,
        label: answerText,
      },
      formValue: {},
    })
    if (res.card && q.larkMsgId) await bot.messenger.updateCard(q.larkMsgId, res.card)
    if (res.toastText) await bot.messenger.replyText(msg.messageId, res.toastText, inThread)
  }

  private async resolveSessionFromReply(
    bot: BotRuntime,
    msg: LarkMessageEvent,
  ): Promise<SessionContext | null> {
    const policy = resolveBotPolicy(this.cfg, bot.config)
    const candidateRoots = [msg.rootId, msg.parentId].filter(Boolean)
    for (const rootId of candidateRoots) {
      const derivedId = deriveAgentId(bot.config.id, rootId, policy.runtime)
      const cached = this.cache.sessions.get(derivedId)
      if (cached) return cached

      const remote = await bot.cursor
        .getAgent(derivedId, {
          runtime: policy.runtime,
          cwd: policy.runtime === 'local' ? policy.localCwd || undefined : undefined,
        })
        .catch(() => null)
      if (
        remote &&
        (!remote.metadata.lark_bot_id || remote.metadata.lark_bot_id === bot.config.id)
      ) {
        const session = metadataToSession(remote) ?? {
          botId: bot.config.id,
          chatId: msg.chatId,
          chatType: msg.chatType || 'group',
          rootMsgId: rootId,
          userId: remote.metadata.lark_user_id ?? '',
          agentId: remote.agentId,
          runtime: remote.runtime,
          cwd:
            remote.cwd || (policy.runtime === 'local' ? policy.localCwd || undefined : undefined),
        }
        this.cache.sessions.set(session.agentId, session)
        return session
      }
    }

    // In p2p chats, a user may reply directly to the bot's card message ID.
    if (msg.parentId) {
      for (const [agentId, cardMsgId] of this.cache.cardMsgIds) {
        if (cardMsgId === msg.parentId) {
          const cached = this.cache.sessions.get(agentId)
          if (cached && cached.botId === bot.config.id) return cached
        }
      }
    }
    return null
  }

  private async resolveSessionForCommand(
    bot: BotRuntime,
    msg: LarkMessageEvent,
    explicitAgentId: string,
  ): Promise<SessionContext | null> {
    const policy = resolveBotPolicy(this.cfg, bot.config)
    if (explicitAgentId) {
      const cached = this.cache.sessions.get(explicitAgentId)
      if (cached && cached.botId === bot.config.id) return cached
      const explicitRuntime: AgentRuntime = isCloudAgentId(explicitAgentId)
        ? 'cloud'
        : policy.runtime
      const remote = await bot.cursor
        .getAgent(explicitAgentId, {
          runtime: explicitRuntime,
          cwd: explicitRuntime === 'local' ? policy.localCwd || undefined : undefined,
        })
        .catch(() => null)
      if (
        remote &&
        (!remote.metadata.lark_bot_id || remote.metadata.lark_bot_id === bot.config.id)
      ) {
        const session =
          metadataToSession(remote) ??
          fallbackSession(
            bot.config.id,
            msg.chatId,
            remote.agentId,
            msg.chatType,
            remote.runtime,
            remote.cwd || policy.localCwd,
          )
        this.cache.sessions.set(session.agentId, session)
        return session
      }
      return null
    }

    const fromReply = await this.resolveSessionFromReply(bot, msg)
    if (fromReply) return fromReply

    if (policy.runtime === 'local') {
      const agents = await bot.cursor
        .listAgents(20, {
          runtime: 'local',
          cwd: policy.localCwd || undefined,
        })
        .catch(() => [])
      const latest = agents[0]
      if (!latest) return null
      const session = fallbackSession(
        bot.config.id,
        msg.chatId,
        latest.agentId,
        msg.chatType,
        'local',
        latest.cwd || policy.localCwd,
      )
      this.cache.sessions.set(session.agentId, session)
      return session
    }

    const agents = await bot.cursor.listAgents(30, { runtime: 'cloud' }).catch(() => [])
    const latest = agents.find(
      (a) => a.metadata.lark_bot_id === bot.config.id && a.metadata.lark_chat_id === msg.chatId,
    )
    if (!latest) return null
    const session =
      metadataToSession(latest) ??
      fallbackSession(bot.config.id, msg.chatId, latest.agentId, msg.chatType)
    this.cache.sessions.set(session.agentId, session)
    return session
  }

  private async findSessionInCloud(agentId: string): Promise<SessionContext | null> {
    const visited = new Set<CursorClient>()
    for (const bot of this.bots.values()) {
      if (visited.has(bot.cursor)) continue
      visited.add(bot.cursor)
      const info = await bot.cursor.getAgent(agentId, { runtime: 'cloud' }).catch(() => null)
      if (info) {
        const session = metadataToSession(info)
        if (session) return session
      }
    }
    return null
  }

  private async loadLiveTaskView(
    bot: BotRuntime,
    agentId: string,
    fallbackChatId: string,
    lookup?: { runtime?: AgentRuntime; cwd?: string },
  ): Promise<TaskView | null> {
    const [agent, latestRun] = await Promise.all([
      bot.cursor.getAgent(agentId, lookup).catch(() => null),
      bot.cursor.getLatestRun(agentId, lookup).catch(() => null),
    ])
    if (!agent && !latestRun) return null

    const remoteSession = agent ? metadataToSession(agent) : null
    const session =
      remoteSession ??
      this.cache.sessions.get(agentId) ??
      fallbackSession(bot.config.id, fallbackChatId, agentId, 'group', lookup?.runtime, lookup?.cwd)
    const view = agent
      ? buildViewFromSummary(agent, latestRun, session)
      : this.createMinimalView(
          session,
          mapRunStatusToTaskStatus(latestRun!.status),
          latestRun!.id,
          latestRun!.status,
        )

    if (latestRun) applyRunSnapshot(view, latestRun)
    if (this.cache.pendingQuestions.has(agentId)) view.taskStatus = 'WAITING_USER'
    view.larkCardMsgId = this.cache.cardMsgIds.get(agentId) ?? ''
    return view
  }

  private createMinimalView(
    session: SessionContext,
    taskStatus: TaskStatus,
    runId = '',
    runStatus = '',
  ): TaskView {
    const runtime: AgentRuntime =
      session.runtime ?? (isCloudAgentId(session.agentId) ? 'cloud' : 'local')
    return {
      agentId: session.agentId,
      runtime,
      agentUrl: runtime === 'cloud' ? `https://cursor.com/agents/${session.agentId}` : '',
      botId: session.botId,
      runId,
      runStatus,
      taskStatus,
      name: '',
      prompt: '',
      repoUrl: '',
      cwd: session.cwd,
      branch: '',
      model: '',
      larkChatId: session.chatId,
      larkChatType: session.chatType,
      larkUserId: session.userId,
      larkRootMsgId: session.rootMsgId,
      larkCardMsgId: this.cache.cardMsgIds.get(session.agentId) ?? '',
      lastResult: '',
      prUrl: '',
      pushedBranch: '',
      durationMs: 0,
      errorMessage: '',
    }
  }

  private buildMcpServersForSession(bot: BotRuntime, session: SessionContext): McpServerSpec[] {
    const policy = resolveBotPolicy(this.cfg, bot.config)
    const servers: McpServerSpec[] = [...policy.mcpServers]

    // Local runtime uses in-process customTools.ask_user, so no remote HTTP /mcp server is required.
    if (session.runtime === 'local') return servers

    const baseUrl = getMcpEndpointUrl(this.cfg)
    if (baseUrl) {
      const url = new URL(baseUrl)
      url.searchParams.set('ctx', encodeMcpContext(session, this.cfg.mcp.authToken))
      servers.push({
        name: this.cfg.mcp.serverName,
        type: 'http',
        url: url.toString(),
        headers: this.cfg.mcp.authToken
          ? { Authorization: `Bearer ${this.cfg.mcp.authToken}` }
          : undefined,
      })
    }
    return servers
  }

  private createLocalAskUserCallback(session: SessionContext): LocalAskUserCallback {
    return (args) =>
      this.handleAskUser({
        context: session,
        agentId: session.agentId,
        question: args.question,
        options: args.options,
        allowCustomInput: args.allowCustomInput,
        customInputPlaceholder: args.customInputPlaceholder,
      })
  }

  private findPendingQuestionForReply(parentId: string, rootId: string): QuestionView | null {
    if (parentId) {
      const q = this.cache.pendingQuestionsByMsgId.get(parentId)
      if (q) return q
    }
    if (rootId && rootId !== parentId) return this.cache.pendingQuestionsByMsgId.get(rootId) ?? null
    return null
  }

  private async replyReposList(bot: BotRuntime, msgId: string, inThread: boolean): Promise<void> {
    const policy = resolveBotPolicy(this.cfg, bot.config)
    const entries = Object.entries(policy.repoAliases).sort(([a], [b]) => a.localeCompare(b))
    const lines = [`Configured repositories / workspaces (runtime: ${policy.runtime}):`]
    if (entries.length === 0) {
      lines.push(
        policy.allowUnlistedRepos
          ? '- None configured (direct URLs / paths are allowed)'
          : '- None configured',
      )
    } else {
      for (const [alias, rc] of entries) {
        const parts: string[] = []
        if (rc.url) {
          const branchNote = rc.defaultBranch ? ` (branch: ${rc.defaultBranch})` : ''
          parts.push(`${rc.url}${branchNote}`)
        }
        if (rc.path) parts.push(`local: ${rc.path}`)
        lines.push(`- ${alias} -> ${parts.join(' | ') || '(empty)'}`)
      }
    }
    if (policy.defaultRepos.length > 1)
      lines.push('', `Default repositories: ${policy.defaultRepos.join(', ')}`)
    else if (policy.defaultRepo) lines.push('', `Default repository: ${policy.defaultRepo}`)
    if (policy.runtime === 'local' && policy.localCwd)
      lines.push(`Default local workspace: ${policy.localCwd}`)
    await bot.messenger.replyText(msgId, lines.join('\n'), inThread)
  }

  private async replyModelsList(bot: BotRuntime, msgId: string, inThread: boolean): Promise<void> {
    const policy = resolveBotPolicy(this.cfg, bot.config)
    try {
      const models = await bot.cursor.listModels()
      await bot.messenger.replyCard(msgId, buildModelsCard(models, policy.defaultModel), inThread)
    } catch (err) {
      await bot.messenger.replyText(
        msgId,
        `Failed to list Cursor models: ${errorMessage(err)}`,
        inThread,
      )
    }
  }

  private async fetchQuotedMessageText(bot: BotRuntime, messageId: string): Promise<string> {
    if (!messageId || !bot.messenger.getMessageText) return ''
    try {
      const text = await bot.messenger.getMessageText(messageId)
      return text ? stripMentions(text) : ''
    } catch (err) {
      this.logger.warn('Failed to fetch quoted Lark message', {
        botId: bot.config.id,
        messageId,
        error: errorMessage(err),
      })
      return ''
    }
  }

  private getBotRuntime(botId: string): BotRuntime | undefined {
    return this.bots.get(botId)
  }

  private trackBackground(p: Promise<void>): void {
    this.backgroundTasks.add(p)
    void p.finally(() => {
      this.backgroundTasks.delete(p)
    })
  }
}

function sessionToMetadata(
  session: SessionContext,
  repoUrls: string[],
  branch: string,
): Record<string, string> {
  const meta: Record<string, string> = {
    lark_bot_id: session.botId,
    lark_chat_id: session.chatId,
    lark_chat_type: session.chatType,
    lark_root_msg_id: session.rootMsgId,
    lark_user_id: session.userId,
  }
  if (repoUrls[0]) meta.lark_repo = repoUrls[0]
  if (repoUrls.length > 1) meta.lark_repos = repoUrls.join(',')
  if (branch) meta.lark_branch = branch
  return meta
}

function metadataToSession(agent: AgentSummary): SessionContext | null {
  const botId = agent.metadata.lark_bot_id
  const chatId = agent.metadata.lark_chat_id
  if (!botId || !chatId) return null
  return {
    botId,
    chatId,
    chatType: agent.metadata.lark_chat_type || 'group',
    rootMsgId: agent.metadata.lark_root_msg_id || '',
    userId: agent.metadata.lark_user_id || '',
    agentId: agent.agentId,
    runtime: agent.runtime,
    cwd: agent.cwd,
  }
}

function fallbackSession(
  botId: string,
  chatId: string,
  agentId: string,
  chatType = 'group',
  runtime?: AgentRuntime,
  cwd?: string,
): SessionContext {
  return {
    botId,
    chatId,
    chatType,
    rootMsgId: '',
    userId: '',
    agentId,
    runtime: runtime ?? (isCloudAgentId(agentId) ? 'cloud' : 'local'),
    cwd: cwd || undefined,
  }
}

function buildViewFromSummary(
  agent: AgentSummary,
  run: RunSnapshot | null,
  session: SessionContext,
): TaskView {
  const repoUrls =
    agent.repos.length > 0
      ? agent.repos
      : agent.metadata.lark_repos
        ? agent.metadata.lark_repos
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : agent.metadata.lark_repo
          ? [agent.metadata.lark_repo]
          : []
  const view: TaskView = {
    agentId: agent.agentId,
    runtime: agent.runtime,
    agentUrl: agent.agentUrl,
    botId: session.botId,
    runId: run?.id ?? '',
    runStatus: run?.status ?? agent.status ?? '',
    taskStatus: mapRunStatusToTaskStatus(run?.status ?? agent.status ?? 'finished'),
    name: agent.name,
    prompt: '',
    repoUrl: repoUrls[0] ?? '',
    repoUrls: repoUrls.length > 0 ? repoUrls : undefined,
    cwd: agent.cwd ?? session.cwd,
    branch: agent.metadata.lark_branch ?? '',
    model: '',
    larkChatId: session.chatId,
    larkChatType: session.chatType,
    larkUserId: session.userId,
    larkRootMsgId: session.rootMsgId,
    larkCardMsgId: '',
    lastResult: run?.result ?? agent.summary,
    prUrl: '',
    pushedBranch: '',
    durationMs: run?.durationMs ?? 0,
    errorMessage: run?.errorMessage ?? '',
  }
  if (run) applyRunSnapshot(view, run)
  return view
}

function shouldReplyInThread(msg: LarkMessageEvent): boolean {
  return msg.chatType === 'group' || Boolean(msg.threadId)
}

function isThreadSession(chatType: string): boolean {
  return chatType !== 'p2p'
}

function applyRunSnapshot(task: TaskView, snap: RunSnapshot): void {
  task.runStatus = snap.status
  if (snap.durationMs && snap.durationMs > 0) task.durationMs = snap.durationMs
  if (snap.result) task.lastResult = snap.result
  if (snap.errorMessage) task.errorMessage = snap.errorMessage
  for (const b of snap.branches) {
    if (b.branch) task.pushedBranch = b.branch
    if (b.prUrl) task.prUrl = b.prUrl
  }
}

function mapRunStatusToTaskStatus(status: string): TaskStatus {
  switch (status.toLowerCase()) {
    case 'creating':
      return 'CREATING'
    case 'running':
      return 'RUNNING'
    case 'finished':
      return 'COMPLETED'
    case 'cancelled':
      return 'CANCELLED'
    case 'error':
    case 'expired':
      return 'FAILED'
    default:
      return 'RUNNING'
  }
}

function deriveTaskName(explicitName: string, prompt: string): string {
  const base = explicitName.trim() || prompt.trim().split('\n')[0]?.trim() || 'Cursor Task'
  return Array.from(base).slice(0, 96).join('')
}

function stringVal(v: unknown): string {
  if (v === undefined || v === null) return ''
  return typeof v === 'string' ? v : String(v)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
