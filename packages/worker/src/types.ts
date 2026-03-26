import type { DurableObjectNamespace } from '@cloudflare/workers-types'
import type {
  DeploymentStatusEvent,
  Repository,
  WorkflowJob,
  WorkflowJobEvent,
  WorkflowRun,
  WorkflowRunEvent,
} from '@octokit/webhooks-types'

export interface Env {
  SLACK_NOTIFY: DurableObjectNamespace
  LOADER: {
    load(options: {
      mainModule: string
      modules: Record<string, string>
      compatibilityDate: string
      env: Record<string, unknown>
      globalOutbound: null
    }): { getEntrypoint(): { render(input: unknown): Promise<unknown> } }
  }

  GITHUB_APP_ID: string
  GITHUB_PRIVATE_KEY: string
  GITHUB_WEBHOOK_SECRET: string
  SLACK_BOT_TOKEN: string
}

export type WebhookEvent =
  | { type: 'workflow_run'; payload: WorkflowRunEvent }
  | { type: 'workflow_job'; payload: WorkflowJobEvent }
  | { type: 'deployment_status'; payload: DeploymentStatusEvent }

export interface RunState {
  message_ts: string | null
  channel: string
  renderer_code: string | null
  job_order: string[]
  workflow_run: WorkflowRun
  repository: Repository
  jobs: Record<string, WorkflowJob>
  deployments: Record<string, { url: string; environment: string }>
  last_notified_attempt: number
  created_at: number
}
