import { NextResponse } from 'next/server'

const VERCEL_TOKEN = process.env.VERCEL_TOKEN
const VERCEL_PROJECT = 'shipo-website1'
const VERCEL_TEAM = process.env.VERCEL_TEAM_ID || ''

async function fetchVercelAnalytics(endpoint: string) {
  const base = 'https://vercel.com/api'
  const teamQuery = VERCEL_TEAM ? `&teamId=${VERCEL_TEAM}` : ''
  const res = await fetch(`${base}${endpoint}${teamQuery}`, {
    headers: {
      Authorization: `Bearer ${VERCEL_TOKEN}`,
      'Content-Type': 'application/json',
    },
    next: { revalidate: 300 },
  })
  if (!res.ok) return null
  return res.json()
}

export async function GET() {
  const now = new Date()
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
  const from = thirtyDaysAgo.toISOString().split('T')[0]
  const to = now.toISOString().split('T')[0]

  // If no token, return placeholder data
  if (!VERCEL_TOKEN) {
    return NextResponse.json({
      connected: false,
      message: 'Add VERCEL_TOKEN to environment variables to see live analytics',
      visitors: { total: 0, today: 0, thisWeek: 0, thisMonth: 0 },
      pageviews: { total: 0, today: 0 },
      topPages: [],
      topSources: [],
      recentDeployments: [],
      conversionEvents: { bookACall: 0, emailClicks: 0, pricingViews: 0 },
      lastUpdated: now.toISOString(),
    })
  }

  try {
    // Get project info
    const projectsRes = await fetchVercelAnalytics(`/v9/projects?search=${VERCEL_PROJECT}`)
    const project = projectsRes?.projects?.[0]
    const projectId = project?.id

    // Get recent deployments
    const deploymentsRes = projectId
      ? await fetchVercelAnalytics(`/v6/deployments?projectId=${projectId}&limit=5`)
      : null

    const deployments = deploymentsRes?.deployments?.map((d: { url: string; state: string; createdAt: number; meta?: { githubCommitMessage?: string } }) => ({
      url: d.url,
      state: d.state,
      createdAt: new Date(d.createdAt).toISOString(),
      commitMessage: d.meta?.githubCommitMessage || 'Manual deploy',
    })) || []

    // Get analytics — Vercel Analytics API v1
    const analyticsBase = projectId
      ? `/v1/web/insights/stats/path?projectId=${projectId}&from=${from}&to=${to}&limit=10`
      : null

    const topPagesRes = analyticsBase ? await fetchVercelAnalytics(analyticsBase) : null
    const topPages = topPagesRes?.data?.map((p: { key: string; total: number; devices?: number }) => ({
      path: p.key,
      views: p.total,
      visitors: p.devices || 0,
    })) || []

    // Visitors overview
    const visitorsRes = projectId
      ? await fetchVercelAnalytics(`/v1/web/insights/stats/visitors?projectId=${projectId}&from=${from}&to=${to}`)
      : null
    const totalVisitors = visitorsRes?.data?.reduce((sum: number, d: { total: number }) => sum + d.total, 0) || 0

    // Referrers
    const referrersRes = projectId
      ? await fetchVercelAnalytics(`/v1/web/insights/stats/referrer?projectId=${projectId}&from=${from}&to=${to}&limit=5`)
      : null
    const topSources = referrersRes?.data?.map((r: { key: string; total: number }) => ({
      source: r.key || 'Direct',
      visitors: r.total,
    })) || []

    return NextResponse.json({
      connected: true,
      visitors: {
        total: totalVisitors,
        today: 0,
        thisWeek: 0,
        thisMonth: totalVisitors,
      },
      pageviews: { total: topPages.reduce((s: number, p: { views: number }) => s + p.views, 0), today: 0 },
      topPages,
      topSources,
      recentDeployments: deployments,
      conversionEvents: { bookACall: 0, emailClicks: 0, pricingViews: 0 },
      lastUpdated: now.toISOString(),
    })
  } catch (e) {
    console.error('Vercel analytics error:', e)
    return NextResponse.json({
      connected: false,
      message: 'Error fetching analytics — check VERCEL_TOKEN',
      visitors: { total: 0, today: 0, thisWeek: 0, thisMonth: 0 },
      pageviews: { total: 0, today: 0 },
      topPages: [],
      topSources: [],
      recentDeployments: [],
      conversionEvents: { bookACall: 0, emailClicks: 0, pricingViews: 0 },
      lastUpdated: now.toISOString(),
    })
  }
}
