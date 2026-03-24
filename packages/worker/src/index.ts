import type { SlackNotifyDO } from './SlackNotifyDO.ts'
import { verifyWebhookSignature } from './github.ts'
import type { Env, WebhookEvent } from './types.ts'

export { SlackNotifyDO } from './SlackNotifyDO.ts'

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/health') {
      return new Response('ok')
    }

    if (url.pathname !== '/webhook' || request.method !== 'POST') {
      return new Response('Not found', { status: 404 })
    }

    const signature = request.headers.get('X-Hub-Signature-256')
    if (!signature) {
      return new Response('Missing signature', { status: 401 })
    }

    const body = await request.text()
    const valid = await verifyWebhookSignature(env.GITHUB_WEBHOOK_SECRET, body, signature)
    if (!valid) {
      return new Response('Invalid signature', { status: 401 })
    }

    const eventType = request.headers.get('X-GitHub-Event')
    if (
      eventType !== 'workflow_run' &&
      eventType !== 'workflow_job' &&
      eventType !== 'deployment_status'
    ) {
      return new Response('ok')
    }

    const payload = JSON.parse(body) as Record<string, unknown>

    const installationId = (payload.installation as { id: number } | undefined)?.id
    if (!installationId) {
      return new Response('Missing installation ID', { status: 400 })
    }

    // deployment_status events without workflow_run can't be correlated — skip
    if (eventType === 'deployment_status') {
      const workflowRun = payload.workflow_run as { id: number } | undefined
      if (!workflowRun?.id) return new Response('ok')
    }

    const hasRequiredFields =
      eventType === 'deployment_status'
        ? typeof payload.deployment_status === 'object'
        : typeof (payload.repository as Record<string, unknown> | undefined)?.full_name ===
            'string' &&
          (eventType === 'workflow_run'
            ? typeof payload.workflow_run === 'object'
            : typeof payload.workflow_job === 'object')

    if (!hasRequiredFields) {
      return new Response('Malformed payload', { status: 400 })
    }

    const event = { type: eventType, payload } as unknown as WebhookEvent
    const org = (payload.organization as { login: string } | undefined)?.login ?? 'default'
    const doId = env.SLACK_NOTIFY.idFromName(`${org}:production`)
    const stub = env.SLACK_NOTIFY.get(doId) as unknown as SlackNotifyDO

    ctx.waitUntil(
      stub.handleWebhook(event, installationId).catch((err) => {
        console.error('Error handling webhook:', err)
      }),
    )

    return new Response('ok')
  },
} satisfies ExportedHandler<Env>
