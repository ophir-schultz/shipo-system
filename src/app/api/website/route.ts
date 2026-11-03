import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/require-staff'
import { websiteProjectName } from '@/lib/website-project'

// The public site is shipousa.com. The repo names that site's Vercel project
// shipo-website1 (also the analytics link on the marketing page). Set
// WEBSITE_VERCEL_PROJECT when the domain is attached to a different project.
// The old route called /v1/web/insights/stats/*, which is not a Web Analytics
// endpoint, treated every non-200 as empty data, and still answered
// connected: true with zeros. The query API is
// /v1/query/web-analytics/visits/*. A failed lookup now stays disconnected
// and the log records the HTTP status, never the token.

const API = 'https://api.vercel.com'
const SITE_HOSTS = ['shipousa.com', 'www.shipousa.com']

type Upstream = { ok: true; body: unknown } | { ok: false; status: number; path: string }

function empty(now: string, message: string, project: string) {
  return {
    connected: false,
    message,
    project,
    visitors: { total: 0, today: 0, thisWeek: 0, thisMonth: 0 },
    pageviews: { total: 0, today: 0 },
    topPages: [] as { path: string; views: number; visitors: number }[],
    topSources: [] as { source: string; visitors: number }[],
    recentDeployments: [] as { url: string; state: string; createdAt: string; commitMessage: string }[],
    conversionEvents: { bookACall: 0, emailClicks: 0, pricingViews: 0 },
    lastUpdated: now,
  }
}

async function vercelGet(path: string, query: Record<string, string> = {}): Promise<Upstream> {
  const url = new URL(path, API)
  const team = process.env.VERCEL_TEAM_ID
  if (team) url.searchParams.set('teamId', team)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  const token = process.env.VERCEL_TOKEN
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    next: { revalidate: 300 },
  })
  if (!res.ok) {
    console.error('[website] Vercel request failed', { path, status: res.status })
    return { ok: false, status: res.status, path }
  }
  return { ok: true, body: await res.json() }
}

function record(body: unknown): Record<string, unknown> | null {
  return body !== null && typeof body === 'object' ? body as Record<string, unknown> : null
}

function rowsOf(body: unknown): Record<string, unknown>[] {
  const root = record(body)
  const data = root?.data
  if (!Array.isArray(data)) return []
  return data.filter((row): row is Record<string, unknown> => row !== null && typeof row === 'object')
}

function numberOf(row: Record<string, unknown>): number {
  for (const key of ['total', 'count', 'visits', 'pageviews', 'devices']) {
    const value = row[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return 0
}

export async function GET() {
  const denied = await requireStaff()
  if (denied) return denied

  const now = new Date().toISOString()
  const projectName = websiteProjectName()
  if (!process.env.VERCEL_TOKEN) {
    return NextResponse.json(empty(now, 'VERCEL_TOKEN is not set on this deployment.', projectName))
  }
  if (!process.env.VERCEL_TEAM_ID) {
    return NextResponse.json(empty(now, 'VERCEL_TEAM_ID is not set, so the website project cannot be looked up on the team.', projectName))
  }

  const project = await vercelGet(`/v9/projects/${encodeURIComponent(projectName)}`)
  if (!project.ok) {
    const why = project.status === 404
      ? `No Vercel project named ${projectName}.`
      : `Could not read Vercel project ${projectName} (HTTP ${project.status}).`
    return NextResponse.json(empty(now, why, projectName))
  }

  const domains = await vercelGet(`/v9/projects/${encodeURIComponent(projectName)}/domains`)
  const domainList = domains.ok && Array.isArray(record(domains.body)?.domains)
    ? record(domains.body)?.domains as { name?: string }[]
    : []
  const hosts = new Set(domainList.map((row) => row.name ?? '').filter(Boolean))
  const siteAttached = SITE_HOSTS.some((host) => hosts.has(host))

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const until = now
  const projectId = String(record(project.body)?.id ?? '')
  if (!projectId) {
    return NextResponse.json(empty(now, `Vercel project ${projectName} did not include an id.`, projectName))
  }

  const visits = await vercelGet('/v1/query/web-analytics/visits/count', {
    projectId, since, until,
  })
  if (!visits.ok) {
    const scope = visits.status === 401 || visits.status === 403
      ? ' The token cannot read Web Analytics for this team.'
      : ''
    return NextResponse.json(empty(
      now,
      `Web Analytics lookup failed for ${projectName} (HTTP ${visits.status}).${scope}`,
      projectName,
    ))
  }

  const pages = await vercelGet('/v1/query/web-analytics/visits/aggregate', {
    projectId,
    since,
    until,
    by: JSON.stringify(['requestPath']),
    limit: '10',
  })
  const sources = await vercelGet('/v1/query/web-analytics/visits/aggregate', {
    projectId,
    since,
    until,
    by: JSON.stringify(['referrerHostname']),
    limit: '5',
  })
  if (!pages.ok) {
    return NextResponse.json(empty(
      now,
      `Web Analytics breakdown failed for ${projectName} (HTTP ${pages.status}).`,
      projectName,
    ))
  }
  if (!sources.ok) {
    return NextResponse.json(empty(
      now,
      `Web Analytics breakdown failed for ${projectName} (HTTP ${sources.status}).`,
      projectName,
    ))
  }

  const visitBody = record(visits.body)
  const totalVisitors = typeof visitBody?.total === 'number'
    ? visitBody.total
    : typeof visitBody?.count === 'number'
      ? visitBody.count
      : numberOf(visitBody ?? {})

  const topPages = rowsOf(pages.body).map((row) => ({
    path: String(row.requestPath ?? row.key ?? ''),
    views: numberOf(row),
    visitors: typeof row.devices === 'number' ? row.devices : numberOf(row),
  })).filter((row) => row.path !== '')

  const topSources = rowsOf(sources.body).map((row) => ({
    source: String(row.referrerHostname ?? row.key ?? 'Direct') || 'Direct',
    visitors: numberOf(row),
  }))

  const deployments = await vercelGet('/v6/deployments', { projectId, limit: '5' })
  const recentDeployments = deployments.ok
    ? ((record(deployments.body)?.deployments as {
        url?: string
        state?: string
        createdAt?: number
        meta?: { githubCommitMessage?: string }
      }[] | undefined) ?? []).map((item) => ({
        url: item.url ?? '',
        state: item.state ?? '',
        createdAt: item.createdAt ? new Date(item.createdAt).toISOString() : '',
        commitMessage: item.meta?.githubCommitMessage || 'Manual deploy',
      }))
    : []

  let siteNote = ''
  if (!domains.ok) {
    siteNote = `Could not list domains for ${projectName} (HTTP ${domains.status}).`
  } else if (!siteAttached) {
    siteNote = `${projectName} does not have shipousa.com attached, so these figures are not that site's traffic.`
  }

  return NextResponse.json({
    connected: true,
    message: siteNote.trim(),
    project: projectName,
    visitors: { total: totalVisitors, today: 0, thisWeek: 0, thisMonth: totalVisitors },
    pageviews: { total: topPages.reduce((sum, page) => sum + page.views, 0), today: 0 },
    topPages,
    topSources,
    recentDeployments,
    conversionEvents: { bookACall: 0, emailClicks: 0, pricingViews: 0 },
    lastUpdated: now,
  })
}
