import type { ContextBlock, MessageAttachment, SectionBlock } from '@slack/types'
import type { RendererInput, RendererOutput } from '@masterworks/mw-gha-slack-notify'

const STATUS_COLORS: Record<string, string> = {
  success: '#2eb886',
  failure: '#a30200',
  cancelled: '#959da5',
  timed_out: '#a30200',
  in_progress: '#f2c744',
  queued: '#af44f2',
}

export function renderDefault(input: RendererInput): RendererOutput {
  const { workflow_run: run, repository: repo, jobs, deployments } = input
  const sha_short = run.head_sha.slice(0, 7)
  const commitText = run.head_commit?.message?.split('\n')[0] ?? ''

  const header: SectionBlock = {
    type: 'section',
    text: { type: 'mrkdwn', text: `\u2003\n> ${commitText}` },
  }

  const context: ContextBlock = {
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `<${repo.html_url}/commit/${run.head_sha}|${sha_short}> on <${repo.html_url}/tree/${run.head_branch}|${run.head_branch}> by ${run.actor.login} · <${run.html_url}|build log>${run.run_attempt > 1 ? ` · attempt ${run.run_attempt}` : ''}\n\u2003`,
      },
    ],
  }

  const attachments: MessageAttachment[] = jobs.map((job) => {
    const color = STATUS_COLORS[job.conclusion ?? job.status] ?? '#dddddd'
    const parts: string[] = [`*${job.name}*`]

    if (job.status === 'completed' && job.started_at && job.completed_at) {
      parts.push(formatDuration(job.started_at, job.completed_at))
    }

    const deployment = deployments[String(job.id)]
    if (deployment?.url) {
      const hostname = new URL(deployment.url).hostname
      parts.push(`<${deployment.url}|${hostname}>`)
    }

    return {
      color,
      text: parts.join(' · '),
      mrkdwn_in: ['text'],
      fallback: `${job.name}: ${job.conclusion ?? job.status}`,
    }
  })

  const allCompleted = jobs.length > 0 && jobs.every((j) => j.status === 'completed')
  const anyFailed = jobs.some((j) => j.conclusion === 'failure')
  const statusEmoji = allCompleted ? (anyFailed ? '❌' : '✅') : '⏳'

  return {
    text: `${statusEmoji} ${run.name} on ${repo.full_name}`,
    blocks: [header, context],
    attachments,
    username: repo.full_name,
  }
}

function formatDuration(startedAt: string, completedAt: string): string {
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime()
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)

  if (hours > 0) return `${hours}h ${minutes % 60}m`
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`
  return `${seconds}s`
}
