import type { Repository, WorkflowJob, WorkflowRun } from '@octokit/webhooks-types'
import type { Block, KnownBlock, MessageAttachment } from '@slack/types'

/**
 * Input passed to a custom renderer function.
 * Uses GitHub's official webhook types directly from `@octokit/webhooks-types`.
 */
export interface DeploymentInfo {
  url: string
  environment: string
}

export interface RendererInput {
  workflow_run: WorkflowRun
  repository: Repository
  jobs: WorkflowJob[]
  /** Deployment URLs keyed by job ID (from GitHub's check_run.id) */
  deployments: Record<string, DeploymentInfo>
}

/**
 * Slack message payload returned by a custom renderer.
 * Fields align with Slack's `chat.postMessage` arguments via `@slack/types`.
 *
 * @see {@link https://api.slack.com/methods/chat.postMessage chat.postMessage}
 */
export interface RendererOutput {
  text: string
  blocks?: (KnownBlock | Block)[]
  attachments?: MessageAttachment[]
  username?: string
  icon_emoji?: string
  icon_url?: string
  unfurl_links?: boolean
  unfurl_media?: boolean
  mrkdwn?: boolean
}

/**
 * A custom renderer function.
 *
 * @example
 * ```js
 * /** @type {import('@masterworks/mw-gha-slack-notify').Renderer} *\/
 * export default function render({ workflow_run, repository, jobs }) {
 *   return { text: `${workflow_run.name} on ${repository.full_name}` }
 * }
 * ```
 */
export type Renderer = (input: RendererInput) => RendererOutput
