import { useState, useEffect } from 'react'
import Link from 'next/link'
import Head from 'next/head'

const GOOGLE_FORM = 'https://docs.google.com/forms/d/e/1FAIpQLSfRHyC7A3nteravGbpNqWtk7kroOkY2hrMGVM9_6T-cO7RumA/viewform?usp=dialog'

const LOADING_STATES = [
  'Reading your product...',
  'Identifying your ideal customer...',
  'Finding where they spend time...',
  'Scanning Reddit for live signals...',
  'Scoring buying intent...',
  'Drafting your replies...',
]

// Parse Reddit Atom feed - same approach as SubScan
function parseAtom(xml, subreddit) {
  const posts = []
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)]
  for (const m of entries) {
    const entry = m[1]
    const title = (entry.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1]
      ?.replace(/<!\[CDATA\[|\]\]>/g, '')?.trim() ?? ''
    const link = (entry.match(/<link[^>]*href="([^"]+)"/) || [])[1]?.trim() ?? ''
    const rawContent = (entry.match(/<content[^>]*>([\s\S]*?)<\/content>/) || [])[1] || ''
    const content = rawContent
      .replace(/<!\[CDATA\[|\]\]>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#32;/g, ' ')
      .replace(/&[^;]{1,6};/g, ' ')
      .replace(/<!--.*?-->/gs, '')
      .replace(/SC_OFF|SC_ON/g, '')
      .replace(/<table[\s\S]*?<\/table>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300)
    const published = (entry.match(/<published>([\s\S]*?)<\/published>/) || [])[1] || ''
    if (!title || !link.includes('/comments/')) continue
    posts.push({
      id: link.split('/').filter(Boolean).pop() || Math.random().toString(36).slice(2),
      title: title.trim(),
      body: content,
      url: link.trim(),
      subreddit,
      createdAt: published ? new Date(published).getTime() : Date.now(),
      ups: 0,
    })
  }
  return posts
}

// Fetch Reddit from browser - avoids server-side blocking
async function fetchSubredditFromBrowser(subreddit) {
  try {
    const res = await fetch(
      `/api/reddit?sub=${encodeURIComponent(subreddit)}&sort=new`,
      { signal: AbortSignal.timeout(10000) }
    )
    if (!res.ok) return []
    const xml = await res.text()
    if (!xml.includes('<entry>')) return []
    return parseAtom(xml, subreddit)
  } catch {
    return []
  }
}

// Call Groq API from browser - same as SubScan
async function callGroqFromBrowser(messages, maxTokens = 1000, temperature = 0.3) {
  const res = await fetch('/api/groq', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, maxTokens, temperature }),
  })
  const data = await res.json()
  return data.content || ''
}

export default function Onboarding() {
  const [url, setUrl] = useState('')
  const [stage, setStage] = useState('input')
  const [loadingIndex, setLoadingIndex] = useState(0)
  const [leads, setLeads] = useState([])
  const [analysis, setAnalysis] = useState(null)
  const [expandedLead, setExpandedLead] = useState(null)
  const [error, setError] = useState('')
  const [timers, setTimers] = useState({})
  const [copiedId, setCopiedId] = useState(null)

  useEffect(() => {
    if (stage !== 'loading') return
    const t = setInterval(() => setLoadingIndex(i => (i + 1) % LOADING_STATES.length), 1800)
    return () => clearInterval(t)
  }, [stage])

  useEffect(() => {
    if (!leads.length) return
    const init = {}
    leads.forEach(l => { init[l.id] = l.expiresIn })
    setTimers(init)
    const t = setInterval(() => {
      setTimers(prev => {
        const next = {}
        leads.forEach(l => {
          const elapsed = (Date.now() - l.createdAt) / 60000
          next[l.id] = Math.max(0, l.expiresIn - elapsed)
        })
        return next
      })
    }, 15000)
    return () => clearInterval(t)
  }, [leads])

  const formatTimer = mins => {
    if (mins <= 0) return 'Expired'
    const h = Math.floor(mins / 60)
    const m = Math.floor(mins % 60)
    return h > 0 ? `${h}h ${m}m` : `${m}m remaining`
  }

  const timerColor = mins => mins <= 30 ? '#c0584a' : mins <= 120 ? '#d4903a' : '#5a8a5a'
  const urgencyLabel = mins => mins <= 30 ? '🔴 Critical' : mins <= 120 ? '🟡 Active' : '🟢 Fresh'

  const isValidUrl = str => {
    try { new URL(str.startsWith('http') ? str : `https://${str}`); return true }
    catch { return false }
  }

  const handleScan = async () => {
    if (!url.trim()) { setError('Please enter your website URL'); return }
    const clean = url.startsWith('http') ? url : `https://${url}`
    if (!isValidUrl(clean)) { setError('Please enter a valid URL'); return }

    if (localStorage.getItem('kairo_scan_used')) { setStage('gate'); return }

    try {
      const r = await fetch('/api/check-ip')
      const d = await r.json()
      if (d.blocked) { setStage('gate'); return }
    } catch { /* allow */ }

    setError('')
    setStage('loading')

    try {
      // Step 1: Analyze product via server API
      const analyzeRes = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: clean }),
      })
      const { analysis: productAnalysis } = await analyzeRes.json()
      setAnalysis(productAnalysis)

      // Step 2: Fetch Reddit posts from browser directly
      const subreddits = (productAnalysis.subreddits || ['SaaS', 'indiehackers', 'entrepreneur']).slice(0, 5)
      const postArrays = await Promise.all(subreddits.map(fetchSubredditFromBrowser))
      const allPosts = postArrays.flat().filter(p =>
        p.body &&
        p.body.length > 40 &&
        !p.body.includes('submitted by') &&
        !p.body.includes('[link]') &&
        !p.body.includes('[comments]')
      )

      if (!allPosts.length) {
        setLeads([])
        localStorage.setItem('kairo_scan_used', '1')
        setStage('results')
        return
      }

      // Step 3: Score and generate replies via server API
      const scoreRes = await fetch('/api/score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ posts: allPosts, analysis: productAnalysis }),
      })
      const { leads: scoredLeads } = await scoreRes.json()

      localStorage.setItem('kairo_scan_used', '1')
      setLeads(scoredLeads || [])
      setStage('results')
    } catch (e) {
      setError(e.message || 'Something went wrong. Please try again.')
      setStage('input')
    }
  }

  const handleCopy = (id, text) => {
    navigator.clipboard.writeText(text)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 2000)
  }

  return (
    <>
      <Head>
        <title>Find Your First Customer — Kairo</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,700;0,900;1,700&family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet" />
      </Head>

      <div className="ob-page">
        <nav className="ob-nav">
          <Link href="/" className="nav-logo" style={{ textDecoration: 'none' }}>
            <KairoLogo size={22} />
            <span style={{ fontFamily: 'var(--font-display)', fontSize: '1.15rem', fontWeight: 700, color: 'var(--ink)' }}>Kairo</span>
          </Link>
          <a href={GOOGLE_FORM} target="_blank" rel="noopener noreferrer" style={{ fontSize: '0.88rem', fontWeight: 500, color: 'var(--rust)' }}>Join Kairo</a>
        </nav>

        {/* INPUT */}
        {stage === 'input' && (
          <div className="ob-stage">
            <div className="ob-input-content">
              <div className="ob-badge">
                <span className="badge-dot" style={{ background: '#4caf50' }} />
                Free · No signup required
              </div>
              <h1 className="ob-headline">
                Paste your URL.<br /><em>Find your first customer.</em>
              </h1>
              <p className="ob-sub">
                Kairo reads your product, finds where your customers are on Reddit, and surfaces people ready to buy — right now.
              </p>

              <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div className="ob-input-wrap">
                  <span style={{ fontSize: '1.1rem' }}>🌐</span>
                  <input
                    className="ob-url-input"
                    type="text"
                    placeholder="yourstartup.com"
                    value={url}
                    onChange={e => { setUrl(e.target.value); setError('') }}
                    onKeyDown={e => e.key === 'Enter' && handleScan()}
                    autoFocus
                  />
                </div>
                {error && <p className="ob-error">{error}</p>}
                <button className="ob-scan-btn" onClick={handleScan}>
                  Find My Customers →
                </button>
              </div>

              <div className="ob-examples">
                <span>Try:</span>
                {['subscan-omega.vercel.app', 'cal.com', 'resend.com'].map(ex => (
                  <button key={ex} className="ob-chip" onClick={() => setUrl(ex)}>{ex}</button>
                ))}
              </div>

              <div className="ob-proof">
                <span className="ob-proof-item">✓ Results in under 2 minutes</span>
                <span className="ob-proof-item">✓ Real Reddit posts</span>
                <span className="ob-proof-item">✓ Draft reply included</span>
              </div>
            </div>
          </div>
        )}

        {/* LOADING */}
        {stage === 'loading' && (
          <div className="ob-stage">
            <div className="ob-loading-content">
              <div className="loading-orb">
                <div className="loading-orb-inner" />
                <div className="loading-orb-ring" />
                <div className="loading-orb-ring2" />
              </div>
              <p className="loading-text">{LOADING_STATES[loadingIndex]}</p>
              <div className="loading-dots">
                {LOADING_STATES.map((_, i) => (
                  <div key={i} className={`loading-dot${i <= loadingIndex ? ' active' : ''}`} />
                ))}
              </div>
              <p className="loading-note">Scanning recent posts across your subreddits</p>
            </div>
          </div>
        )}

        {/* RESULTS */}
        {stage === 'results' && analysis && (
          <div className="ob-results">
            <div className="product-bar">
              <div className="product-bar-inner">
                <div className="product-info">
                  <span className="product-tag">Scanning for</span>
                  <span className="product-name">{analysis.name}</span>
                  <span className="product-desc">{analysis.description}</span>
                </div>
                <div className="sub-chips">
                  {(analysis.subreddits || []).slice(0, 4).map(s => (
                    <span key={s} className="sub-chip">r/{s}</span>
                  ))}
                </div>
              </div>
            </div>

            <div className="leads-wrap">
              <div className="leads-header">
                <div>
                  <h2 className="leads-headline">{leads.length} customer {leads.length === 1 ? 'opportunity' : 'opportunities'} found</h2>
                  <p className="leads-sub">Sorted by urgency. Act on critical leads first.</p>
                </div>
                <div className="free-tag">3 free · <a href={GOOGLE_FORM} target="_blank" rel="noopener noreferrer" className="upgrade-link">Get more</a></div>
              </div>

              {leads.length === 0 && (
                <div className="no-leads">No high-intent leads found right now. Try again in 15 minutes as new posts arrive.</div>
              )}

              {leads.map((lead, i) => {
                const mins = timers[lead.id] ?? lead.expiresIn
                const isOpen = expandedLead === lead.id
                return (
                  <div key={lead.id} className={`lead-card${i === 0 ? ' lead-card-critical' : ''}`}>
                    <div className="lead-card-top">
                      <div className="lead-meta">
                        <span
                          className="signal-badge-card"
                          style={lead.signalType === 'active'
                            ? { background: 'rgba(192,88,74,0.1)', color: 'var(--rust)' }
                            : { background: 'rgba(180,140,80,0.1)', color: '#b48c50' }}
                        >
                          {lead.signalType === 'active' ? '🔴 Active Demand' : '🟡 Passive Demand'}
                        </span>
                        <span className="lead-subreddit">r/{lead.subreddit}</span>
                        <span className="lead-score">Score: {Number(lead.score).toFixed(1)}</span>
                      </div>
                      <div className="timer-badge" style={{ color: timerColor(mins) }}>
                        <span className="timer-dot" style={{ background: timerColor(mins) }} />
                        {urgencyLabel(mins)} · {formatTimer(mins)}
                      </div>
                    </div>

                    <h3 className="lead-title">{lead.title}</h3>
                    {lead.body && <p className="lead-body">{lead.body.length > 220 ? lead.body.slice(0, 220) + '...' : lead.body}</p>}

                    <div className="lead-reason">
                      <span className="lead-reason-label">Why this matches:</span>
                      <span>{lead.reason}</span>
                    </div>

                    {isOpen && (
                      <div className="draft-box">
                        <div className="draft-header">
                          <span className="draft-label">✍️ Draft Reply</span>
                          <button className="copy-btn" onClick={() => handleCopy(lead.id, lead.draftReply)}>
                            {copiedId === lead.id ? 'Copied!' : 'Copy'}
                          </button>
                        </div>
                        <p className="draft-text">{lead.draftReply}</p>
                      </div>
                    )}

                    <div className="lead-actions">
                      <button className="lead-btn-primary" onClick={() => setExpandedLead(isOpen ? null : lead.id)}>
                        {isOpen ? 'Hide Reply' : 'View Draft Reply'}
                      </button>
                      <a href={lead.url} target="_blank" rel="noopener noreferrer" className="lead-btn-secondary">
                        Open in Reddit ↗
                      </a>
                      <button className="lead-btn-dismiss">Dismiss</button>
                    </div>
                  </div>
                )
              })}

              {/* Join Kairo CTA */}
              <div className="email-gate">
                <div className="email-gate-inner">
                  <div className="email-gate-icon">🚀</div>
                  <h3 className="email-gate-headline">Want leads like these every day?</h3>
                  <p className="email-gate-sub">
                    Kairo scans Reddit every 15 minutes and finds critical leads automatically — while you focus on building.
                  </p>
                  <a
                    href={GOOGLE_FORM}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ob-scan-btn"
                    style={{ textAlign: 'center', textDecoration: 'none', display: 'block', marginTop: 4 }}
                  >
                    Join Kairo — Free →
                  </a>
                  <p className="email-gate-note">No credit card · Launching August 13th</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* GATE */}
        {stage === 'gate' && (
          <div className="ob-stage">
            <div className="ob-gate-content">
              <div className="gate-icon">🔒</div>
              <h2 className="gate-headline">You've used your free scan</h2>
              <p className="gate-sub">Join Kairo free to scan again and get leads daily.</p>
              <div className="gate-actions">
                <a href={GOOGLE_FORM} target="_blank" rel="noopener noreferrer" className="btn-primary">Join Kairo →</a>
                <button className="gate-back" onClick={() => { setStage('input'); setUrl('') }}>← Back</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
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
