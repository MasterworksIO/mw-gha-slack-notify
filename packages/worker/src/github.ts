import type { WorkflowJob, WorkflowRun } from '@octokit/webhooks-types'
import { importPKCS8, SignJWT } from 'jose'

const encoder = new TextEncoder()

const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'mw-gha-slack-notify',
  'X-GitHub-Api-Version': '2022-11-28',
} as const

async function githubFetch<T>(token: string, url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { ...GITHUB_HEADERS, Authorization: `token ${token}` },
  })
  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status} ${url}`)
  }
  return response.json() as Promise<T>
}

export async function verifyWebhookSignature(
  secret: string,
  payload: string,
  signature: string,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload))
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  const expected = encoder.encode(`sha256=${hex}`)
  const actual = encoder.encode(signature)
  if (expected.byteLength !== actual.byteLength) return false
  // @ts-expect-error -- timingSafeEqual exists on Workers crypto.subtle at runtime
  return crypto.subtle.timingSafeEqual(expected, actual) as boolean
}

async function generateJWT(appId: string, privateKeyPem: string): Promise<string> {
  const privateKey = await importPKCS8(privateKeyPem, 'RS256')
  const now = Math.floor(Date.now() / 1000)

  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(appId)
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 600)
    .sign(privateKey)
}

export async function getInstallationToken(
  storage: DurableObjectStorage,
  appId: string,
  privateKey: string,
  installationId: number,
): Promise<string> {
  const cacheKey = `github_token:${installationId}`
  const cached = await storage.get<{ token: string; expires_at: number }>(cacheKey)
  if (cached && cached.expires_at > Date.now()) return cached.token

  const jwt = await generateJWT(appId, privateKey)
  const data = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${jwt}` },
    },
  ).then((r) => {
    if (!r.ok) throw new Error(`Failed to get installation token: ${r.status}`)
    return r.json() as Promise<{ token: string }>
  })

  await storage.put(cacheKey, { token: data.token, expires_at: Date.now() + 55 * 60 * 1000 })
  return data.token
}

export async function fetchFileContent(
  token: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | null> {
  const response = await fetch(`https://api.github.com/repos/${repo}/contents/${path}?ref=${ref}`, {
    headers: {
      ...GITHUB_HEADERS,
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github.raw+json',
    },
  })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`Failed to fetch ${path}: ${response.status}`)
  return response.text()
}

export async function fetchWorkflowJobs(
  token: string,
  repo: string,
  runId: number,
): Promise<WorkflowJob[]> {
  const data = await githubFetch<{ jobs: WorkflowJob[] }>(
    token,
    `https://api.github.com/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`,
  )
  return data.jobs
}

export async function fetchWorkflowRun(
  token: string,
  repo: string,
  runId: number,
): Promise<WorkflowRun> {
  return githubFetch<WorkflowRun>(
    token,
    `https://api.github.com/repos/${repo}/actions/runs/${runId}`,
  )
}
