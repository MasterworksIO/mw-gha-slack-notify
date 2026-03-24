import type { RendererOutput } from '@masterworks/mw-gha-slack-notify'

export type MessageParams = RendererOutput & { token: string; channel: string; ts?: string }

/**
 * Posts a new message or updates an existing one (if `ts` is provided).
 * Returns the message timestamp.
 */
export async function sendMessage(params: MessageParams): Promise<string> {
  const method = params.ts ? 'chat.update' : 'chat.postMessage'
  const { token, ...body } = params

  const data = await slackApiCall(token, method, body)

  if (!data.ts) {
    throw new Error(`Slack ${method} did not return a message timestamp`)
  }
  return data.ts
}

/** Posts a threaded reply to an existing message. */
export async function postThreadReply(
  token: string,
  channel: string,
  thread_ts: string,
  text: string,
): Promise<void> {
  await slackApiCall(token, 'chat.postMessage', { channel, thread_ts, text })
}

async function slackApiCall(
  token: string,
  method: string,
  body: Record<string, unknown>,
  attempt = 1,
): Promise<{ ok: boolean; ts?: string; error?: string }> {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })

  if (response.status === 429 && attempt <= 3) {
    const retryAfter = Number(response.headers.get('Retry-After') ?? '5')
    await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000))
    return slackApiCall(token, method, body, attempt + 1)
  }

  const data = (await response.json()) as { ok: boolean; ts?: string; error?: string }

  if (!data.ok) {
    throw new Error(`Slack ${method} error: ${data.error}`)
  }

  return data
}
