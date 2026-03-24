import tsBlankSpace from 'ts-blank-space'
import * as v from 'valibot'
import type { RendererInput, RendererOutput } from '@masterworks/mw-gha-slack-notify'
import type { Env, RunState } from './types.ts'

export { renderDefault } from './default-renderer.ts'

const RendererOutputSchema = v.object({
  text: v.string(),
  blocks: v.optional(v.array(v.record(v.string(), v.unknown()))),
  attachments: v.optional(v.array(v.record(v.string(), v.unknown()))),
  username: v.optional(v.string()),
  icon_emoji: v.optional(v.string()),
  icon_url: v.optional(v.pipe(v.string(), v.url())),
  unfurl_links: v.optional(v.boolean()),
  unfurl_media: v.optional(v.boolean()),
  mrkdwn: v.optional(v.boolean()),
})

export function buildRendererInput(state: RunState): RendererInput {
  // Deduplicate jobs by name, keeping only the latest attempt (re-runs create new IDs)
  const byName = new Map<string, (typeof state.jobs)[string]>()
  for (const job of Object.values(state.jobs)) {
    const existing = byName.get(job.name)
    if (!existing || (job.run_attempt ?? 0) > (existing.run_attempt ?? 0)) {
      byName.set(job.name, job)
    }
  }

  return {
    workflow_run: state.workflow_run,
    repository: state.repository,
    jobs: [...byName.values()].sort((a, b) => a.created_at.localeCompare(b.created_at)),
    deployments: state.deployments ?? {},
  }
}

export async function renderCustom(
  env: Env,
  rendererCode: string,
  input: RendererInput,
): Promise<RendererOutput> {
  const entrypoint = `
import { WorkerEntrypoint } from "cloudflare:workers"
import render from "./renderer.js"

export default class extends WorkerEntrypoint {
  async render(input) {
    return render(input)
  }
}
`

  const rendererJs = tsBlankSpace(rendererCode)

  const worker = env.LOADER.load({
    mainModule: 'entrypoint.js',
    modules: {
      'entrypoint.js': entrypoint,
      'renderer.js': rendererJs,
    },
    compatibilityDate: '2026-03-01',
    env: {},
    globalOutbound: null,
  })

  const raw = await worker.getEntrypoint().render(input)
  return v.parse(RendererOutputSchema, raw) as RendererOutput
}
