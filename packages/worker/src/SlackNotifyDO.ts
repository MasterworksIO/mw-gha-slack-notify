import { DurableObject } from 'cloudflare:workers'
import type { RendererOutput } from '@masterworks/mw-gha-slack-notify'
import { getWorkflowConfig } from './config.ts'
import { fetchWorkflowJobs, fetchWorkflowRun, getInstallationToken } from './github.ts'
import { buildRendererInput, renderCustom, renderDefault } from './render.ts'
import { postThreadReply, sendMessage } from './slack.ts'
import type { Env, RunState, WebhookEvent } from './types.ts'

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000
const MAX_RUN_AGE_MS = 24 * 60 * 60 * 1000
const DEBOUNCE_MS = 1500

interface QueuedEvent {
  event: WebhookEvent
  installationId: number
}

export class SlackNotifyDO extends DurableObject<Env> {
  #pendingEvents: QueuedEvent[] = []
  #flushTimeout: ReturnType<typeof setTimeout> | null = null

  async handleWebhook(event: WebhookEvent, installationId: number): Promise<void> {
    this.#pendingEvents.push({ event, installationId })

    if (this.#pendingEvents.length === 1) {
      this.#warmConfigCache(event, installationId).catch(() => {})
    }

    // setTimeout is safe here: the DO stays alive for the duration of the handleWebhook
    // RPC call (via ctx.waitUntil in the worker entrypoint), and the 1.5s window is short.
    if (!this.#flushTimeout) {
      this.#flushTimeout = setTimeout(() => {
        this.#flushTimeout = null
        this.#flush().catch((err) => console.error('Flush error:', err))
      }, DEBOUNCE_MS)
    }
  }

  async #warmConfigCache(event: WebhookEvent, installationId: number): Promise<void> {
    const repo = event.payload.repository?.full_name
    if (!repo) return

    if (event.type === 'workflow_run') {
      const { path, head_sha } = event.payload.workflow_run
      await getWorkflowConfig(this.ctx.storage, this.env, installationId, repo, path, head_sha)
    } else if (event.type === 'workflow_job') {
      const token = await this.#getToken(installationId)
      const run = await fetchWorkflowRun(token, repo, event.payload.workflow_job.run_id)
      await getWorkflowConfig(
        this.ctx.storage,
        this.env,
        installationId,
        repo,
        run.path,
        run.head_sha,
      )
    }
    // deployment_status events don't warm the cache — state must already exist
  }

  // Events arriving during flush will re-arm #flushTimeout via handleWebhook
  // (since #flushTimeout is null after the timeout fires), so no events are lost.
  async #flush(): Promise<void> {
    const events = this.#pendingEvents
    this.#pendingEvents = []
    if (events.length === 0) return

    const byRun = new Map<number, QueuedEvent[]>()
    for (const entry of events) {
      let runId: number | undefined
      if (entry.event.type === 'workflow_run') {
        runId = entry.event.payload.workflow_run.id
      } else if (entry.event.type === 'workflow_job') {
        runId = entry.event.payload.workflow_job.run_id
      } else {
        runId = entry.event.payload.workflow_run?.id
      }
      if (!runId) continue
      const list = byRun.get(runId) ?? []
      list.push(entry)
      byRun.set(runId, list)
    }

    for (const [runId, runEvents] of byRun) {
      await this.#processRunEvents(runId, runEvents)
    }
  }

  async #processRunEvents(runId: number, events: QueuedEvent[]): Promise<void> {
    const stateKey = `run:${runId}`
    let state = (await this.ctx.storage.get<RunState>(stateKey)) ?? null

    const completedEvent = events.find(
      (e) => e.event.type === 'workflow_run' && e.event.payload.action === 'completed',
    )

    // When a completed event is in the batch, we discard other job events for this run.
    // This is safe because #handleWorkflowCompleted re-fetches all jobs from the API.
    // But we still process deployment_status events — those carry URLs not in the jobs API.
    if (completedEvent) {
      const deploymentEvents = events.filter((e) => e.event.type === 'deployment_status')
      await this.#handleWorkflowCompleted(completedEvent, deploymentEvents, runId, state, stateKey)
      return
    }

    // Find a non-deployment event to init state from (deployment_status lacks workflow path info)
    const initEvent = events.find((e) => e.event.type !== 'deployment_status') ?? events[0]!
    const { installationId } = initEvent
    const repo = initEvent.event.payload.repository?.full_name
    if (!repo) return

    if (!state) {
      // Can't init state from deployment_status alone — need workflow_run or workflow_job first
      if (initEvent.event.type === 'deployment_status') return
      state = await this.#initRunState(initEvent.event, installationId, repo, runId)
      if (!state) return
    }

    // Detect current run_attempt from any event in the batch
    let currentAttempt = state.last_notified_attempt ?? 1
    for (const { event } of events) {
      if (event.type === 'workflow_run') {
        currentAttempt = Math.max(currentAttempt, event.payload.workflow_run.run_attempt)
      } else if (event.type === 'workflow_job') {
        currentAttempt = Math.max(currentAttempt, event.payload.workflow_job.run_attempt)
      }
    }

    for (const { event } of events) {
      if (event.type === 'workflow_run') {
        state.workflow_run = event.payload.workflow_run
      } else if (event.type === 'workflow_job') {
        state.jobs[String(event.payload.workflow_job.id)] = event.payload.workflow_job
      } else if (event.type === 'deployment_status') {
        const { deployment_status, check_run } = event.payload
        if (check_run?.id && deployment_status.environment_url) {
          state.deployments[String(check_run.id)] = {
            url: deployment_status.environment_url,
            environment: deployment_status.environment,
          }
          const hostname = new URL(deployment_status.environment_url).hostname
          this.#threadReply(state, `🚀 Deployed to ${hostname}`)
        }
      }
    }

    // Post re-run thread reply when we see a new attempt for the first time
    if (currentAttempt > (state.last_notified_attempt ?? 1)) {
      state.last_notified_attempt = currentAttempt
      const run = state.workflow_run
      this.#threadReply(
        state,
        `🔄 Re-run started by ${run.triggering_actor.login} (attempt ${currentAttempt}) · <${run.html_url}|build log>`,
      )
    }

    await this.#renderAndPost(state)
    await this.ctx.storage.put(stateKey, state)

    if (!(await this.ctx.storage.getAlarm())) {
      await this.ctx.storage.setAlarm(Date.now() + CLEANUP_INTERVAL_MS)
    }
  }

  async #handleWorkflowCompleted(
    entry: QueuedEvent,
    deploymentEvents: QueuedEvent[],
    runId: number,
    state: RunState | null,
    stateKey: string,
  ): Promise<void> {
    const { event, installationId } = entry
    const repo = event.payload.repository?.full_name
    if (!repo) return

    if (!state) {
      state = await this.#initRunState(event, installationId, repo, runId)
      if (!state) return
    }

    const token = await this.#getToken(installationId)
    const jobs = await fetchWorkflowJobs(token, repo, runId)

    state.jobs = {}
    for (const job of jobs) {
      state.jobs[String(job.id)] = job
    }

    // Process any deployment_status events that arrived in the same batch
    for (const { event: depEvent } of deploymentEvents) {
      if (depEvent.type === 'deployment_status') {
        const { deployment_status, check_run } = depEvent.payload
        if (check_run?.id && deployment_status.environment_url) {
          state.deployments[String(check_run.id)] = {
            url: deployment_status.environment_url,
            environment: deployment_status.environment,
          }
        }
      }
    }

    await this.#renderAndPost(state)
    await this.ctx.storage.put(stateKey, state)

    // Thread reply for cancellation
    if (event.type === 'workflow_run' && event.payload.workflow_run.conclusion === 'cancelled') {
      const actor = event.payload.workflow_run.triggering_actor.login
      this.#threadReply(state, `🚫 Cancelled by ${actor}`)
    }
  }

  async #initRunState(
    event: WebhookEvent,
    installationId: number,
    repo: string,
    runId: number,
  ): Promise<RunState | null> {
    let workflow_run: RunState['workflow_run']
    const repository = event.payload.repository

    if (event.type === 'workflow_run') {
      workflow_run = event.payload.workflow_run
    } else {
      const token = await this.#getToken(installationId)
      workflow_run = await fetchWorkflowRun(token, repo, runId)
    }

    const config = await getWorkflowConfig(
      this.ctx.storage,
      this.env,
      installationId,
      repo,
      workflow_run.path,
      workflow_run.head_sha,
    )
    if (!config) return null

    return {
      message_ts: null,
      channel: config.channel,
      renderer_code: config.renderer_code,
      workflow_run,
      repository,
      jobs: {},
      deployments: {},
      last_notified_attempt: 1,
      created_at: Date.now(),
    }
  }

  async #renderAndPost(state: RunState): Promise<void> {
    const input = buildRendererInput(state)
    const output: RendererOutput = state.renderer_code
      ? await renderCustom(this.env, state.renderer_code, input)
      : renderDefault(input)

    state.message_ts = await sendMessage({
      token: this.env.SLACK_BOT_TOKEN,
      channel: state.channel,
      ts: state.message_ts ?? undefined,
      ...output,
    })
  }

  // Best-effort, fire-and-forget — thread replies shouldn't block main message updates
  #threadReply(state: RunState, text: string): void {
    if (!state.message_ts) return
    postThreadReply(this.env.SLACK_BOT_TOKEN, state.channel, state.message_ts, text).catch((err) =>
      console.error('Thread reply error:', err),
    )
  }

  async #getToken(installationId: number): Promise<string> {
    return getInstallationToken(
      this.ctx.storage,
      this.env.GITHUB_APP_ID,
      this.env.GITHUB_PRIVATE_KEY,
      installationId,
    )
  }

  async alarm(): Promise<void> {
    const now = Date.now()

    const keysToDelete: string[] = []

    const runs = await this.ctx.storage.list<RunState>({ prefix: 'run:' })
    for (const [key, state] of runs) {
      if (now - state.created_at > MAX_RUN_AGE_MS) keysToDelete.push(key)
    }

    const configs = await this.ctx.storage.list<{ cached_at: number }>({ prefix: 'config:' })
    for (const [key, entry] of configs) {
      if (now - entry.cached_at > MAX_RUN_AGE_MS) keysToDelete.push(key)
    }

    const tokens = await this.ctx.storage.list<{ token: string; expires_at: number }>({
      prefix: 'github_token:',
    })
    for (const [key, entry] of tokens) {
      if (entry.expires_at < now) keysToDelete.push(key)
    }

    if (keysToDelete.length > 0) {
      await this.ctx.storage.delete(keysToDelete)
    }

    // Reschedule if there are still active runs
    const remaining = await this.ctx.storage.list({ prefix: 'run:', limit: 1 })
    if (remaining.size > 0) {
      await this.ctx.storage.setAlarm(Date.now() + CLEANUP_INTERVAL_MS)
    }
  }
}
