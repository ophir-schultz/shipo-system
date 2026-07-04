'use client'

import { useEffect, useState } from 'react'

interface MarketingState {
  lastUpdated: string
  linkedin: {
    postsGenerated: number
    postsSent: number
    thisWeek: number
    thisMonth: number
    nextPostScheduled: string
    topAngles: string[]
    recentPosts: { date: string; angle: string; hook: string; cta: string; engagement: number | null }[]
  }
  blog: {
    postsWritten: number
    postsPublished: number
    nextPostScheduled: string
    posts: { title: string; status: string; date: string }[]
  }
  canva: {
    visualsCreated: number
    savedToCanva: number
    visuals: { title: string; theme: string; url: string; date: string }[]
  }
  optimization: {
    weekNumber: number
    currentHookStyle: string
    nextOptimizationRun: string
    feedbackReceived: boolean
    topPerformingAngle: string | null
  }
  schedule: {
    linkedinDaily: string
    blogWeekly: string
    optimizationLoop: string
  }
  live?: {
    blogPostsOnDisk: number
    linkedinFilesOnDisk: number
    recentActivity: { type: string; title: string; date: string; status: string }[]
  }
}

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)
  if (mins < 60) return `${mins}m ago`
  if (hours < 24) return `${hours}h ago`
  return `${days}d ago`
}

function timeUntil(dateStr: string) {
  const diff = new Date(dateStr).getTime() - Date.now()
  if (diff < 0) return 'Due now'
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)
  if (hours < 24) return `in ${hours}h`
  return `in ${days}d`
}

function StatCard({ label, value, sub, color }: { label: string; value: string | number; sub?: string; color?: string }) {
  return (
    <div style={{ background: '#1a2540', borderRadius: 12, padding: '24px 28px', border: '1px solid #2a3a5c' }}>
      <div style={{ fontSize: 13, color: '#8899bb', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>{label}</div>
      <div style={{ fontSize: 36, fontWeight: 800, color: color || '#00AAFF' }}>{value}</div>
      {sub && <div style={{ fontSize: 13, color: '#667799', marginTop: 6 }}>{sub}</div>}
    </div>
  )
}

function Badge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    written: '#2a4a7f',
    published: '#1a5c3a',
    queued: '#3a3a2a',
    sent: '#1a5c3a',
  }
  const textColors: Record<string, string> = {
    written: '#4499ff',
    published: '#44dd88',
    queued: '#aaaa44',
    sent: '#44dd88',
  }
  return (
    <span style={{
      background: colors[status] || '#2a2a4a',
      color: textColors[status] || '#8888cc',
      fontSize: 11,
      fontWeight: 700,
      padding: '3px 10px',
      borderRadius: 20,
      textTransform: 'uppercase',
      letterSpacing: 0.5
    }}>
      {status}
    </span>
  )
}

export default function MarketingDashboard() {
  const [data, setData] = useState<MarketingState | null>(null)
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date())
  const [loading, setLoading] = useState(true)

  const fetchData = async () => {
    try {
      const res = await fetch('/api/marketing', { cache: 'no-store' })
      const json = await res.json()
      setData(json)
      setLastRefresh(new Date())
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 30000) // refresh every 30s
    return () => clearInterval(interval)
  }, [])

  if (loading) return (
    <div style={{ background: '#0a0f1a', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ color: '#00AAFF', fontSize: 18 }}>Loading marketing dashboard...</div>
    </div>
  )

  if (!data) return (
    <div style={{ background: '#0a0f1a', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ color: '#ff4444', fontSize: 18 }}>Could not load marketing data</div>
    </div>
  )

  return (
    <div style={{ background: '#0a0f1a', minHeight: '100vh', color: 'white', fontFamily: 'var(--font-geist-sans)' }}>

      {/* Header */}
      <div style={{ background: '#0d1420', borderBottom: '1px solid #1a2540', padding: '20px 40px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#00ff88', boxShadow: '0 0 8px #00ff88' }} />
            <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>Marketing Dashboard</h1>
            <span style={{ background: '#00AAFF22', color: '#00AAFF', fontSize: 11, padding: '3px 10px', borderRadius: 20, fontWeight: 700 }}>LIVE</span>
          </div>
          <div style={{ color: '#667799', fontSize: 13, marginTop: 4 }}>Auto-refreshes every 30 seconds · Last updated {timeAgo(lastRefresh.toISOString())}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ color: '#8899bb', fontSize: 12 }}>Optimization Week</div>
          <div style={{ color: '#00AAFF', fontSize: 28, fontWeight: 800 }}>#{data.optimization.weekNumber}</div>
        </div>
      </div>

      <div style={{ padding: '32px 40px', maxWidth: 1300, margin: '0 auto' }}>

        {/* Top Stats */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 20, marginBottom: 32 }}>
          <StatCard label="LinkedIn Posts Sent" value={data.linkedin.postsSent} sub={`${data.linkedin.thisWeek} this week`} />
          <StatCard label="Blog Posts Written" value={data.live?.blogPostsOnDisk ?? data.blog.postsWritten} sub={`${data.blog.postsPublished} published`} color="#44dd88" />
          <StatCard label="Canva Visuals" value={data.canva.savedToCanva} sub="saved to Canva account" color="#aa66ff" />
          <StatCard label="Posts Generated Total" value={data.linkedin.postsGenerated} sub="9 ready, Mon/Wed/Fri" color="#ffaa44" />
        </div>

        {/* Main Grid */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginBottom: 24 }}>

          {/* LinkedIn */}
          <div style={{ background: '#0d1420', border: '1px solid #1a2540', borderRadius: 16, padding: 28 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0, color: '#00AAFF' }}>💼 LinkedIn</h2>
              <div style={{ fontSize: 12, color: '#667799' }}>Next post {timeUntil(data.linkedin.nextPostScheduled)}</div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, color: '#8899bb', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 1 }}>Top Angles This Campaign</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {data.linkedin.topAngles.map(angle => (
                  <span key={angle} style={{ background: '#00AAFF22', color: '#00AAFF', fontSize: 12, padding: '4px 12px', borderRadius: 20 }}>
                    {angle.replace(/_/g, ' ')}
                  </span>
                ))}
              </div>
            </div>

            <div style={{ fontSize: 12, color: '#8899bb', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 1 }}>Recent Posts</div>
            {data.linkedin.recentPosts.map((post, i) => (
              <div key={i} style={{ background: '#1a2540', borderRadius: 10, padding: '14px 16px', marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ fontSize: 11, color: '#667799' }}>{post.date}</span>
                  <Badge status="sent" />
                </div>
                <div style={{ fontSize: 13, color: '#ccd6ee', lineHeight: 1.5 }}>"{post.hook.substring(0, 80)}..."</div>
                <div style={{ fontSize: 11, color: '#556688', marginTop: 6 }}>
                  Angle: <span style={{ color: '#00AAFF' }}>{post.angle.replace(/_/g, ' ')}</span> · CTA: {post.cta}
                  {post.engagement !== null && <span style={{ color: '#44dd88', marginLeft: 8 }}>👍 {post.engagement} engagements</span>}
                  {post.engagement === null && <span style={{ color: '#667799', marginLeft: 8 }}>Awaiting feedback</span>}
                </div>
              </div>
            ))}

            <div style={{ marginTop: 16, padding: '12px 16px', background: '#0a1020', borderRadius: 10, border: '1px dashed #2a3a5c' }}>
              <div style={{ fontSize: 12, color: '#8899bb', marginBottom: 4 }}>⏰ Schedule</div>
              <div style={{ fontSize: 13, color: '#ccd6ee' }}>{data.schedule.linkedinDaily} — auto-email to ophir@shipousa.com</div>
            </div>
          </div>

          {/* Blog */}
          <div style={{ background: '#0d1420', border: '1px solid #1a2540', borderRadius: 16, padding: 28 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0, color: '#44dd88' }}>📝 Blog Posts</h2>
              <div style={{ fontSize: 12, color: '#667799' }}>Next: {timeUntil(data.blog.nextPostScheduled)}</div>
            </div>

            <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
              <div style={{ flex: 1, background: '#1a2540', borderRadius: 10, padding: '14px', textAlign: 'center' }}>
                <div style={{ fontSize: 28, fontWeight: 800, color: '#44dd88' }}>{data.live?.blogPostsOnDisk ?? data.blog.postsWritten}</div>
                <div style={{ fontSize: 11, color: '#667799', marginTop: 4 }}>Written</div>
              </div>
              <div style={{ flex: 1, background: '#1a2540', borderRadius: 10, padding: '14px', textAlign: 'center' }}>
                <div style={{ fontSize: 28, fontWeight: 800, color: data.blog.postsPublished > 0 ? '#44dd88' : '#ffaa44' }}>{data.blog.postsPublished}</div>
                <div style={{ fontSize: 11, color: '#667799', marginTop: 4 }}>Published</div>
              </div>
            </div>

            {data.blog.postsPublished === 0 && (
              <div style={{ background: '#2a1a0a', border: '1px solid #ffaa4444', borderRadius: 10, padding: '12px 16px', marginBottom: 16, fontSize: 13, color: '#ffaa44' }}>
                ⚠️ 0 posts published — add WordPress credentials to auto-publish
              </div>
            )}

            <div style={{ fontSize: 12, color: '#8899bb', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 1 }}>Content Queue</div>
            <div style={{ maxHeight: 280, overflowY: 'auto' }}>
              {data.blog.posts.map((post, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid #1a2540' }}>
                  <div style={{ fontSize: 13, color: '#ccd6ee', flex: 1, paddingRight: 12 }}>{post.title}</div>
                  <Badge status={post.status} />
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Bottom Grid */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>

          {/* Canva Visuals */}
          <div style={{ background: '#0d1420', border: '1px solid #1a2540', borderRadius: 16, padding: 28 }}>
            <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 20px', color: '#aa66ff' }}>🎨 Canva Visuals</h2>
            {data.canva.visuals.map((visual, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#1a2540', borderRadius: 10, padding: '14px 16px', marginBottom: 10 }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#ccd6ee' }}>{visual.title}</div>
                  <div style={{ fontSize: 11, color: '#667799', marginTop: 3 }}>{visual.theme.replace(/_/g, ' ')} · {visual.date}</div>
                </div>
                <a href={visual.url} target="_blank" rel="noopener noreferrer"
                  style={{ background: '#00AAFF22', color: '#00AAFF', fontSize: 12, padding: '6px 14px', borderRadius: 8, textDecoration: 'none', fontWeight: 600 }}>
                  Edit →
                </a>
              </div>
            ))}
            <div style={{ marginTop: 12, fontSize: 12, color: '#556688', textAlign: 'center' }}>
              New visuals generated every Friday · Saved directly to Canva
            </div>
          </div>

          {/* Optimization Loop */}
          <div style={{ background: '#0d1420', border: '1px solid #1a2540', borderRadius: 16, padding: 28 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0, color: '#ffaa44' }}>🔄 Optimization Loop</h2>
              <div style={{ fontSize: 12, color: '#667799' }}>Runs every Friday</div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
              <div style={{ background: '#1a2540', borderRadius: 10, padding: 16 }}>
                <div style={{ fontSize: 11, color: '#8899bb', marginBottom: 4 }}>CURRENT HOOK STYLE</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#ffaa44' }}>{data.optimization.currentHookStyle}</div>
              </div>
              <div style={{ background: '#1a2540', borderRadius: 10, padding: 16 }}>
                <div style={{ fontSize: 11, color: '#8899bb', marginBottom: 4 }}>FEEDBACK RECEIVED</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: data.optimization.feedbackReceived ? '#44dd88' : '#ff6644' }}>
                  {data.optimization.feedbackReceived ? '✓ Yes' : '✗ Pending'}
                </div>
              </div>
            </div>

            <div style={{ background: '#1a2540', borderRadius: 10, padding: 16, marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: '#8899bb', marginBottom: 8 }}>TOP PERFORMING ANGLE</div>
              <div style={{ fontSize: 14, color: data.optimization.topPerformingAngle ? '#44dd88' : '#667799' }}>
                {data.optimization.topPerformingAngle ?? 'Collecting data — reply to Friday feedback email'}
              </div>
            </div>

            <div style={{ background: '#1a2540', borderRadius: 10, padding: 16 }}>
              <div style={{ fontSize: 11, color: '#8899bb', marginBottom: 8 }}>NEXT OPTIMIZATION RUN</div>
              <div style={{ fontSize: 14, color: '#ffaa44', fontWeight: 700 }}>
                {timeUntil(data.optimization.nextOptimizationRun)} — {new Date(data.optimization.nextOptimizationRun).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
              </div>
              <div style={{ fontSize: 12, color: '#556688', marginTop: 6 }}>
                Will generate 3 new posts + 2 new Canva visuals + send you the full package
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div style={{ marginTop: 24, textAlign: 'center', color: '#445566', fontSize: 12 }}>
          Auto-refreshing every 30s · State file: ~/shipo-marketing/optimization/state.json
        </div>
      </div>
    </div>
  )
}
