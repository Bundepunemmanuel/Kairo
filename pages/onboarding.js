import { useState, useEffect } from 'react'
import Link from 'next/link'
import Head from 'next/head'

const LOADING_STATES = [
  'Reading your product...',
  'Identifying your ideal customer...',
  'Finding where they spend time...',
  'Scanning Reddit for live signals...',
  'Scoring buying intent...',
  'Drafting your replies...',
]

export default function Onboarding() {
  const [url, setUrl] = useState('')
  const [stage, setStage] = useState('input') // input | loading | results | gate
  const [loadingIndex, setLoadingIndex] = useState(0)
  const [leads, setLeads] = useState([])
  const [analysis, setAnalysis] = useState(null)
  const [expandedLead, setExpandedLead] = useState(null)
  const [error, setError] = useState('')
  const [email, setEmail] = useState('')
  const [emailDone, setEmailDone] = useState(false)
  const [timers, setTimers] = useState({})
  const [copiedId, setCopiedId] = useState(null)

  // Animate loading text
  useEffect(() => {
    if (stage !== 'loading') return
    const t = setInterval(() => setLoadingIndex(i => (i + 1) % LOADING_STATES.length), 1800)
    return () => clearInterval(t)
  }, [stage])

  // Decay timers
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

    // Check localStorage first
    if (localStorage.getItem('kairo_scan_used')) { setStage('gate'); return }

    // Check IP
    try {
      const r = await fetch('/api/check-ip')
      const d = await r.json()
      if (d.blocked) { setStage('gate'); return }
    } catch { /* allow */ }

    setError('')
    setStage('loading')

    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: clean }),
      })
      if (!res.ok) { const e = await res.json(); throw new Error(e.error || 'Scan failed') }
      const data = await res.json()
      setAnalysis(data.analysis)
      setLeads(data.leads)
      localStorage.setItem('kairo_scan_used', '1')
      setStage('results')
    } catch (e) {
      setError(e.message || 'Something went wrong. Please try again.')
      setStage('input')
    }
  }

  const handleEmail = () => {
    if (!email || !email.includes('@')) return
    localStorage.setItem('kairo_email', email)
    setEmailDone(true)
    // Will connect to Supabase in Chunk 2
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
      </Head>

      <div className="ob-page">
        {/* Nav */}
        <nav className="ob-nav">
          <Link href="/" className="nav-logo" style={{ textDecoration: 'none' }}>
            <KairoLogo size={22} />
            <span style={{ fontFamily: 'var(--font-display)', fontSize: '1.15rem', fontWeight: 700, color: 'var(--ink)' }}>Kairo</span>
          </Link>
          <Link href="/#pricing" style={{ fontSize: '0.88rem', fontWeight: 500, color: 'var(--ink-light)' }}>Pricing</Link>
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
                {['lemonsqueezy.com', 'cal.com', 'resend.com'].map(ex => (
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
              <p className="loading-note">Scanning 50 recent posts across your subreddits</p>
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
                <div className="free-tag">3 free · <Link href="/#pricing" className="upgrade-link">Upgrade for more</Link></div>
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

              {/* Email Gate */}
              {!emailDone ? (
                <div className="email-gate">
                  <div className="email-gate-inner">
                    <div className="email-gate-icon">📬</div>
                    <h3 className="email-gate-headline">Want leads like these every day?</h3>
                    <p className="email-gate-sub">
                      Kairo scans Reddit every 15 minutes and sends critical leads straight to you — while you focus on building.
                    </p>
                    <div className="email-gate-row">
                      <input
                        type="email"
                        placeholder="your@email.com"
                        value={email}
                        onChange={e => setEmail(e.target.value)}
                        className="email-input"
                        onKeyDown={e => e.key === 'Enter' && handleEmail()}
                      />
                      <button className="email-submit" onClick={handleEmail}>Get Daily Leads →</button>
                    </div>
                    <p className="email-gate-note">No spam. No credit card. Unsubscribe anytime.</p>
                  </div>
                </div>
              ) : (
                <div className="email-success">
                  <span className="email-success-icon">🎉</span>
                  <div>
                    <p className="email-success-title">You're in. Kairo is watching Reddit for you.</p>
                    <p className="email-success-note">
                      <Link href="/#pricing" className="upgrade-link">Upgrade to Pro</Link> to unlock all leads and draft replies.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* GATE */}
        {stage === 'gate' && (
          <div className="ob-stage">
            <div className="ob-gate-content">
              <div className="gate-icon">🔒</div>
              <h2 className="gate-headline">You've used your free scan</h2>
              <p className="gate-sub">Sign up free to scan again and get 3 leads daily. Upgrade anytime for more.</p>
              <div className="gate-actions">
                <Link href="/#pricing" className="btn-primary">See Plans →</Link>
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
