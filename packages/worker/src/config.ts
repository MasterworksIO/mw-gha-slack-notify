import { parse as parseYaml } from 'yaml'
import { fetchFileContent, getInstallationToken } from './github.ts'
import type { Env } from './types.ts'

export interface ParsedConfig {
  channel: string
  renderer_code: string | null
  job_order: string[]
  cached_at: number
}

export async function getWorkflowConfig(
  storage: DurableObjectStorage,
  env: Env,
  installationId: number,
  repo: string,
  workflowPath: string,
  sha: string,
): Promise<ParsedConfig | null> {
  const cacheKey = `config:${repo}:${workflowPath}:${sha}`
  const cached = await storage.get<ParsedConfig>(cacheKey)
  if (cached) return cached

  const token = await getInstallationToken(
    storage,
    env.GITHUB_APP_ID,
    env.GITHUB_PRIVATE_KEY,
    installationId,
  )

  const yamlContent = await fetchFileContent(token, repo, workflowPath, sha)
  if (!yamlContent) return null

  const doc = parseYaml(yamlContent, { schema: 'failsafe' }) as {
    env?: Record<string, string>
    jobs?: Record<string, { name?: string }>
  } | null
  const channel = doc?.env?.['SLACK_NOTIFY_CHANNEL']
  if (!channel) return null

  const rendererPath = doc?.env?.['SLACK_NOTIFY_RENDERER']?.replace(/^\.\//, '') ?? null
  if (rendererPath?.includes('..')) return null
  const renderer_code = rendererPath ? await fetchFileContent(token, repo, rendererPath, sha) : null

  const jobs = doc?.jobs ?? {}
  const job_order = Object.keys(jobs).map((key) => {
    const name = jobs[key]?.name ?? key
    const parts = name.split(/\$\{\{[^}]*\}\}/)
    const escaped = parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    return `^${escaped.join('.+')}( \\(.*\\))?$`
  })

  const result: ParsedConfig = { channel, renderer_code, job_order, cached_at: Date.now() }
  await storage.put(cacheKey, result)
  return result
}
