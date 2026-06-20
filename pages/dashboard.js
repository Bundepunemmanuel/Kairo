import { useState, useEffect } from 'react'
import Link from 'next/link'
import Head from 'next/head'
import { useRouter } from 'next/router'
import { supabase } from '../lib/supabase'
import { useAuth } from './_app'

const GOOGLE_FORM = 'https://docs.google.com/forms/d/e/1FAIpQLSfRHyC7A3nteravGbpNqWtk7kroOkY2hrMGVM9_6T-cO7RumA/viewform?usp=dialog'

export default function Dashboard() {
  const { user, loading: authLoading } = useAuth()
  const router = useRouter()

  const [profile, setProfile] = useState(null)
  const [leads, setLeads] = useState([])
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [expandedLead, setExpandedLead] = useState(null)
  const [copiedId, setCopiedId] = useState(null)
  const [timers, setTimers] = useState({})
  const [error, setError] = useState('')

  // Redirect if not logged in
  useEffect(() => {
    if (!authLoading && !user) {
      router.replace('/login')
    }
  }, [user, authLoading, router])

  // Load profile and leads
  useEffect(() => {
    if (!user) return
    loadData()
  }, [user])

  // Live timers
  useEffect(() => {
    if (!leads.length) return
    const init = {}
    leads.forEach(l => {
      const ageMinutes = (Date.now() - (l.created_at_post || Date.now())) / 60000
      const maxWindow = l.signal_type === 'active' ? 180 : 360
      init[l.id] = maxWindow - ageMinutes
    })
    setTimers(init)
    const t = setInterval(() => {
      setTimers(prev => {
        const next = {}
        leads.forEach(l => {
          const ageMinutes = (Date.now() - (l.created_at_post || Date.now())) / 60000
          const maxWindow = l.signal_type === 'active' ? 180 : 360
          next[l.id] = maxWindow - ageMinutes
        })
        return next
      })
    }, 30000)
    return () => clearInterval(t)
  }, [leads])

  const loadData = async () => {
    setLoading(true)
    try {
      // Load product profile
      const { data: profileData } = await supabase
        .from('product_profiles')
        .select('*')
        .eq('user_id', user.id)
        .single()

      setProfile(profileData)

      if (profileData) {
        // Load leads
        const { data: leadsData } = await supabase
          .from('leads')
          .select('*')
          .eq('user_id', user.id)
          .order('score', { ascending: false })
          .limit(10)

        setLeads(leadsData || [])
      }
    } catch (e) {
      console.log('[dashboard] load error:', e.message)
    } finally {
      setLoading(false)
    }
  }

  const handleRescan = async () => {
    if (!profile) return
    setScanning(true)
    setError('')
    try {
      // Re-analyze
      const analyzeRes = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: profile.url }),
      })
      let analyzeData
      try { analyzeData = await analyzeRes.json() } catch { throw new Error('Analysis failed') }
      if (!analyzeData.analysis) throw new Error('Analysis failed')
      const analysis = analyzeData.analysis

      // Fetch Reddit posts
      const subreddits = (analysis.subreddits || []).slice(0, 6)
      const postArrays = await Promise.all(subreddits.map(sub => fetchSubreddit(sub)))
      const allPosts = postArrays.flat().filter(p => p.body && p.body.length > 40 && !p.body.includes('[comments]'))

      if (!allPosts.length) { setError('No posts found. Try again in a few minutes.'); return }

      // Score
      const scoreRes = await fetch('/api/score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ posts: allPosts, analysis }),
      })
      const { leads: scoredLeads } = await scoreRes.json()

      // Save to Supabase
      await supabase.from('product_profiles').upsert({
        user_id: user.id,
        url: profile.url,
        analysis,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' })

      if (scoredLeads && scoredLeads.length > 0) {
        await supabase.from('leads').delete().eq('user_id', user.id)
        await supabase.from('leads').insert(scoredLeads.map(lead => ({
          user_id: user.id,
          post_id: lead.id || lead.url,
          title: lead.title,
          body: lead.body || '',
          url: lead.url,
          subreddit: lead.subreddit,
          score: lead.score,
          signal_type: lead.signalType,
          specific_problem: lead.specificProblem || '',
          reason: lead.reason || '',
          created_at_post: lead.createdAt || Date.now(),
        })))
      }

      // Reload
      await loadData()
    } catch (e) {
      setError(e.message || 'Scan failed. Please try again.')
    } finally {
      setScanning(false)
    }
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.push('/')
  }

  const formatTimer = mins => {
    if (mins <= 0) return 'Expired'
    const h = Math.floor(mins / 60)
    const m = Math.floor(mins % 60)
    return h > 0 ? `${h}h ${m}m` : `${m}m`
  }

  const timerColor = mins => mins <= 0 ? '#999' : mins <= 30 ? '#c0584a' : mins <= 120 ? '#d4903a' : '#5a8a5a'
  const urgencyLabel = mins => mins <= 0 ? '⚫ Expired' : mins <= 30 ? '🔴 Critical' : mins <= 120 ? '🟡 Active' : '🟢 Fresh'

  const avgScore = leads.length ? (leads.reduce((s, l) => s + l.score, 0) / leads.length).toFixed(1) : '—'

  if (authLoading || loading) {
    return (
      <div className="dash-loading">
        <div className="dash-loading-inner">
          <KairoLogo size={32} />
          <p>Loading your dashboard...</p>
        </div>
      </div>
    )
  }

  if (!profile) {
    return (
      <>
        <Head><title>Dashboard — Kairo</title></Head>
        <div className="dash-page">
          <DashNav user={user} onSignOut={handleSignOut} />
          <div className="dash-empty-profile">
            <div style={{ fontSize: '2rem', marginBottom: 16 }}>🎯</div>
            <h2>You haven't scanned a product yet</h2>
            <p>Paste your product URL to find your first Reddit lead.</p>
            <Link href="/onboarding" className="dash-scan-btn">Scan my product →</Link>
          </div>
        </div>
      </>
    )
  }

  return (
    <>
      <Head>
        <title>Dashboard — Kairo</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,700;0,900;1,700&family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet" />
      </Head>

      <div className="dash-page">
        <DashNav user={user} onSignOut={handleSignOut} />

        {/* Product bar */}
        <div className="dash-product-bar">
          <div className="dash-product-info">
            <span className="dash-product-label">Scanning for</span>
            <span className="dash-product-name">{profile.analysis?.name || profile.url}</span>
            <span className="dash-product-desc">{profile.analysis?.description}</span>
          </div>
          <button
            className="dash-rescan-btn"
            onClick={handleRescan}
            disabled={scanning}
          >
            {scanning ? '⏳ Scanning...' : '↻ Re-scan now'}
          </button>
        </div>

        {/* Stats */}
        <div className="dash-stats">
          <div className="dash-stat">
            <div className="dash-stat-value">{leads.length}</div>
            <div className="dash-stat-label">Leads found</div>
          </div>
          <div className="dash-stat">
            <div className="dash-stat-value">{avgScore}</div>
            <div className="dash-stat-label">Avg score</div>
          </div>
          <div className="dash-stat">
            <div className="dash-stat-value">{profile.analysis?.subreddits?.length || 0}</div>
            <div className="dash-stat-label">Subreddits</div>
          </div>
          <div className="dash-stat">
            <div className="dash-stat-value dash-plan-badge">Free</div>
            <div className="dash-stat-label">Current plan</div>
          </div>
        </div>

        {error && <p className="dash-error">{error}</p>}

        {/* Leads */}
        <div className="dash-leads">
          <div className="dash-leads-header">
            <h2 className="dash-leads-title">
              {leads.length > 0 ? `${leads.length} qualified ${leads.length === 1 ? 'lead' : 'leads'}` : 'No leads yet'}
            </h2>
            <p className="dash-leads-sub">
              {leads.length > 0
                ? 'Sorted by intent score. Act on critical leads first.'
                : 'Hit re-scan to find leads from your product subreddits.'}
            </p>
          </div>

          {leads.length === 0 && !scanning && (
            <div className="dash-no-leads">
              <div style={{ fontSize: '2rem', marginBottom: 12 }}>🔍</div>
              <p>No leads from your last scan. Reddit posts refresh constantly — try again in 15–30 minutes.</p>
              <button className="dash-scan-btn" onClick={handleRescan}>Scan now →</button>
            </div>
          )}

          {leads.map((lead, i) => {
            const mins = timers[lead.id] ?? 0
            const isOpen = expandedLead === lead.id

            return (
              <div key={lead.id} className={`dash-lead-card${i === 0 ? ' dash-lead-card-top' : ''}`}>
                <div className="dash-lead-top">
                  <div className="dash-lead-meta">
                    <span
                      className="dash-signal-badge"
                      style={lead.signal_type === 'active'
                        ? { background: 'rgba(192,88,74,0.1)', color: '#c0584a' }
                        : { background: 'rgba(180,140,80,0.1)', color: '#b48c50' }}
                    >
                      {lead.signal_type === 'active' ? '🔴 Active Demand' : '🟡 Passive Demand'}
                    </span>
                    <span className="dash-lead-sub">r/{lead.subreddit}</span>
                    <span className="dash-lead-score">Score: {Number(lead.score).toFixed(1)}</span>
                  </div>
                  <div className="dash-timer" style={{ color: timerColor(mins) }}>
                    <span className="dash-timer-dot" style={{ background: timerColor(mins) }} />
                    {urgencyLabel(mins)} · {formatTimer(mins)}
                  </div>
                </div>

                <h3 className="dash-lead-title">{lead.title}</h3>
                {lead.body && <p className="dash-lead-body">{lead.body.slice(0, 220)}{lead.body.length > 220 ? '...' : ''}</p>}

                <div className="dash-lead-reason">
                  <span className="dash-reason-label">Problem matched:</span>
                  <span>{lead.specific_problem || lead.reason}</span>
                </div>

                {isOpen && (
                  <div className="dash-reply-gate">
                    <div className="reply-gate-icon">✍️</div>
                    <p className="reply-gate-headline">Your reply is ready</p>
                    <p className="reply-gate-sub">
                      Upgrade to Pro to unlock AI-drafted replies written for this exact lead.
                    </p>
                    <a href={GOOGLE_FORM} target="_blank" rel="noopener noreferrer" className="reply-gate-btn">
                      Upgrade to unlock replies →
                    </a>
                    <p className="reply-gate-note">Launching August 13th · Plans from $29/month</p>
                  </div>
                )}

                <div className="dash-lead-actions">
                  <button
                    className="dash-btn-primary"
                    onClick={() => setExpandedLead(isOpen ? null : lead.id)}
                  >
                    {isOpen ? 'Hide' : '✍️ View Draft Reply'}
                  </button>
                  <a href={lead.url} target="_blank" rel="noopener noreferrer" className="dash-btn-secondary">
                    Open in Reddit ↗
                  </a>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}

function DashNav({ user, onSignOut }) {
  return (
    <nav className="dash-nav">
      <Link href="/" className="dash-nav-logo" style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 8 }}>
        <KairoLogo size={22} />
        <span style={{ fontFamily: 'Playfair Display, serif', fontSize: '1.1rem', fontWeight: 700, color: '#1a1208' }}>Kairo</span>
      </Link>
      <div className="dash-nav-right">
        <span className="dash-nav-email">{user?.email}</span>
        <button className="dash-nav-signout" onClick={onSignOut}>Sign out</button>
      </div>
    </nav>
  )
}

function KairoLogo({ size = 24 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none">
      <rect x="10" y="38" width="45" height="10" rx="5" fill="#c0584a" opacity="0.6" />
      <rect x="20" y="52" width="45" height="10" rx="5" fill="#c0584a" opacity="0.8" />
      <rect x="15" y="66" width="45" height="10" rx="5" fill="#c0584a" opacity="0.7" />
      <circle cx="76" cy="57" r="18" fill="#c0584a" />
    </svg>
  )
}

// Subreddit fetching (same as onboarding)
function parseAtom(xml, subreddit) {
  const posts = []
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)]
  for (const m of entries) {
    const entry = m[1]
    const title = (entry.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1]?.replace(/<!\[CDATA\[|\]\]>/g, '')?.trim() ?? ''
    const link = (entry.match(/<link[^>]*href="([^"]+)"/) || [])[1]?.trim() ?? ''
    const rawContent = (entry.match(/<content[^>]*>([\s\S]*?)<\/content>/) || [])[1] || ''
    const content = rawContent.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&[^;]{1,6};/g, ' ').replace(/<!--.*?-->/gs, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600)
    const published = (entry.match(/<published>([\s\S]*?)<\/published>/) || [])[1] || ''
    if (!title || !link.includes('/comments/')) continue
    const urlParts = link.split('/')
    const commentsIdx = urlParts.indexOf('comments')
    const postId = commentsIdx !== -1 ? urlParts[commentsIdx + 1] : urlParts.filter(Boolean).pop()
    posts.push({ id: postId || Math.random().toString(36).slice(2), title: title.trim(), body: content, url: link.trim(), subreddit, createdAt: published ? new Date(published).getTime() : Date.now() })
  }
  return posts
}

async function fetchSubreddit(subreddit) {
  try {
    const res = await fetch(`/api/reddit?sub=${encodeURIComponent(subreddit)}&sort=new`, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) return []
    const xml = await res.text()
    if (!xml.includes('<entry>')) return []
    return parseAtom(xml, subreddit)
  } catch { return [] }
}
