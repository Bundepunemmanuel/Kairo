import { useState, useEffect } from 'react'
import Link from 'next/link'
import Head from 'next/head'

const GOOGLE_FORM = 'https://docs.google.com/forms/d/e/1FAIpQLSfRHyC7A3nteravGbpNqWtk7kroOkY2hrMGVM9_6T-cO7RumA/viewform?usp=dialog'

const LOADING_STATES = [
  'Reading your product...',
  'Mapping the problems you solve...',
  'Finding where your customers post...',
  'Scanning Reddit for live signals...',
  'Checking comments for buying intent...',
  'Qualifying leads against your ICP...',
  'Drafting replies...',
]

// ─── Reddit parsing ────────────────────────────────────────────────────────

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
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#32;/g, ' ')
      .replace(/&[^;]{1,6};/g, ' ').replace(/<!--.*?-->/gs, '')
      .replace(/SC_OFF|SC_ON/g, '').replace(/<table[\s\S]*?<\/table>/gi, '')
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      .slice(0, 600) // Increased from 300 — more context for better scoring
    const published = (entry.match(/<published>([\s\S]*?)<\/published>/) || [])[1] || ''
    if (!title || !link.includes('/comments/')) continue

    // Extract post ID from URL for comment fetching
    const urlParts = link.split('/')
    const commentsIdx = urlParts.indexOf('comments')
    const postId = commentsIdx !== -1 ? urlParts[commentsIdx + 1] : urlParts.filter(Boolean).pop()

    posts.push({
      id: postId || Math.random().toString(36).slice(2),
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

// Fetch comments for a specific post
async function fetchCommentsFromBrowser(subreddit, postId) {
  try {
    const res = await fetch(
      `/api/reddit?mode=comments&sub=${encodeURIComponent(subreddit)}&postId=${encodeURIComponent(postId)}`,
      { signal: AbortSignal.timeout(8000) }
    )
    if (!res.ok) return []
    const data = await res.json()
    return data.comments || []
  } catch {
    return []
  }
}

// ─── Component ────────────────────────────────────────────────────────────

export default function Onboarding() {
  const [url, setUrl] = useState('')
  const [stage, setStage] = useState('input')
  const [loadingIndex, setLoadingIndex] = useState(0)
  const [loadingMessage, setLoadingMessage] = useState(LOADING_STATES[0])
  const [leads, setLeads] = useState([])
  const [analysis, setAnalysis] = useState(null)
  const [expandedLead, setExpandedLead] = useState(null)
  const [error, setError] = useState('')
  const [timers, setTimers] = useState({})
  const [copiedId, setCopiedId] = useState(null)
  const [scanStats, setScanStats] = useState(null) // { postsScanned, subreddits }
  const [replies, setReplies] = useState({}) // { [leadId]: reply text }
  const [replyLoading, setReplyLoading] = useState({}) // { [leadId]: true/false }

  useEffect(() => {
    if (stage !== 'loading') return
    const t = setInterval(() => {
      setLoadingIndex(i => {
        const next = (i + 1) % LOADING_STATES.length
        setLoadingMessage(LOADING_STATES[next])
        return next
      })
    }, 2200)
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
    }, 30000)
    return () => clearInterval(t)
  }, [leads])

  const formatTimer = mins => {
    if (mins <= 0) return 'Expired'
    const h = Math.floor(mins / 60)
    const m = Math.floor(mins % 60)
    return h > 0 ? `${h}h ${m}m` : `${m}m remaining`
  }

  const timerColor = mins => mins <= 0 ? '#999999' : mins <= 30 ? '#c0584a' : mins <= 120 ? '#d4903a' : '#5a8a5a'
  const urgencyLabel = mins => mins <= 0 ? '⚫ Expired' : mins <= 30 ? '🔴 Critical' : mins <= 120 ? '🟡 Active' : '🟢 Fresh'

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
      const r = await fetch('/api/check-ip', { signal: AbortSignal.timeout(5000) })
      const d = await r.json()
      if (d.blocked) { setStage('gate'); return }
    } catch { /* allow on timeout */ }

    setError('')
    setStage('loading')
    setLoadingIndex(0)
    setLoadingMessage(LOADING_STATES[0])

    try {
      // ── Step 1: Analyze product — extract specific problems, not just audience
      const analyzeRes = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: clean }),
      })

      if (!analyzeRes.ok) {
        throw new Error('Could not analyze your product. Please check the URL and try again.')
      }

      const analyzeData = await analyzeRes.json()
      if (!analyzeData.analysis) {
        throw new Error('Analysis failed. Please try again.')
      }

      const productAnalysis = analyzeData.analysis
      setAnalysis(productAnalysis)

      // ── Step 2: Fetch Reddit posts from browser (avoids server-side blocking)
      const subreddits = (productAnalysis.subreddits || ['SaaS', 'indiehackers', 'entrepreneur']).slice(0, 6)
      const postArrays = await Promise.all(subreddits.map(fetchSubredditFromBrowser))
      const allPosts = postArrays.flat().filter(p =>
        p.body &&
        p.body.length > 40 &&
        !p.body.includes('submitted by') &&
        !p.body.includes('[link]') &&
        !p.body.includes('[comments]')
      )

      setScanStats({ postsScanned: allPosts.length, subreddits })

      if (!allPosts.length) {
        localStorage.setItem('kairo_scan_used', '1')
        setLeads([])
        setStage('results')
        return
      }

      // ── Step 3: Fetch comments for each post (in parallel, best-effort)
      // We fetch comments for ALL posts so score.js can find comment-level signals
      const commentsMap = {}
      const commentFetches = allPosts.map(async post => {
        const comments = await fetchCommentsFromBrowser(post.subreddit, post.id)
        if (comments.length > 0) {
          commentsMap[post.id] = comments
        }
      })
      await Promise.allSettled(commentFetches) // Never block on comment failures

      // ── Step 4: Score posts + comments, generate replies
      const scoreRes = await fetch('/api/score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ posts: allPosts, analysis: productAnalysis, commentsMap }),
      })

      const { leads: scoredLeads, error: scoreError } = await scoreRes.json()

      if (scoreError) throw new Error(scoreError)

      localStorage.setItem('kairo_scan_used', '1')
      setLeads(scoredLeads || [])
      setStage('results')
    } catch (e) {
      setError(e.message || 'Something went wrong. Please try again.')
      setStage('input')
    }
  }

  const handleViewReply = async (leadId, lead) => {
    // If already open, close it
    if (expandedLead === leadId) {
      setExpandedLead(null)
      return
    }
    setExpandedLead(leadId)
    // If reply already fetched, don't fetch again
    if (replies[leadId] !== undefined) return
    // Fetch reply on demand
    setReplyLoading(prev => ({ ...prev, [leadId]: true }))
    try {
      const res = await fetch('/api/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          post: { title: lead.title, body: lead.body, subreddit: lead.subreddit },
          analysis,
          signalType: lead.signalType,
          specificProblem: lead.specificProblem,
        }),
      })
      const data = await res.json()
      setReplies(prev => ({ ...prev, [leadId]: data.reply || '' }))
    } catch {
      setReplies(prev => ({ ...prev, [leadId]: '' }))
    } finally {
      setReplyLoading(prev => ({ ...prev, [leadId]: false }))
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

        {/* ── INPUT ── */}
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
                Kairo reads your product, maps the specific problems you solve, and surfaces Reddit users experiencing those exact problems right now.
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
                <span className="ob-proof-item">✓ Problem-matched leads only</span>
                <span className="ob-proof-item">✓ Posts and comments scanned</span>
                <span className="ob-proof-item">✓ Draft reply included</span>
              </div>
            </div>
          </div>
        )}

        {/* ── LOADING ── */}
        {stage === 'loading' && (
          <div className="ob-stage">
            <div className="ob-loading-content">
              <div className="loading-orb">
                <div className="loading-orb-inner" />
                <div className="loading-orb-ring" />
                <div className="loading-orb-ring2" />
              </div>
              <p className="loading-text">{loadingMessage}</p>
              <div className="loading-dots">
                {LOADING_STATES.map((_, i) => (
                  <div key={i} className={`loading-dot${i <= loadingIndex ? ' active' : ''}`} />
                ))}
              </div>
              <p className="loading-note">Matching problems, not just audience</p>
            </div>
          </div>
        )}

        {/* ── RESULTS ── */}
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
                  {(analysis.subreddits || []).slice(0, 5).map(s => (
                    <span key={s} className="sub-chip">r/{s}</span>
                  ))}
                </div>
              </div>
            </div>

            <div className="leads-wrap">
              <div className="leads-header">
                <div>
                  <h2 className="leads-headline">
                    {leads.length > 0
                      ? `${leads.length} qualified ${leads.length === 1 ? 'lead' : 'leads'} found`
                      : 'No qualifying leads right now'}
                  </h2>
                  <p className="leads-sub">
                    {leads.length > 0
                      ? 'Every lead matched to a specific problem you solve. Sorted by urgency.'
                      : scanStats
                        ? `Scanned ${scanStats.postsScanned} posts across ${scanStats.subreddits.length} subreddits. Nothing matched your specific problems.`
                        : 'Posts scanned but nothing matched your specific problems.'}
                  </p>
                </div>
                {leads.length > 0 && (
                  <div className="free-tag">3 free · <a href={GOOGLE_FORM} target="_blank" rel="noopener noreferrer" className="upgrade-link">Get more</a></div>
                )}
              </div>

              {/* Zero results state — honest and confident */}
              {leads.length === 0 && (
                <div className="no-leads-box">
                  <div className="no-leads-icon">🔍</div>
                  <h3 className="no-leads-headline">Nothing qualified this scan</h3>
                  <p className="no-leads-body">
                    Kairo only surfaces leads where someone is <strong>specifically experiencing a problem you solve</strong>. Right now, the recent posts in your subreddits don't meet that bar.
                  </p>
                  <p className="no-leads-body" style={{ marginTop: 8 }}>
                    This is a good thing — you're not wasting time on weak matches. Try again in 15–30 minutes as new posts arrive.
                  </p>
                  <div className="no-leads-actions">
                    <a href={GOOGLE_FORM} target="_blank" rel="noopener noreferrer" className="ob-scan-btn" style={{ textDecoration: 'none', display: 'inline-block', textAlign: 'center' }}>
                      Get notified when leads appear →
                    </a>
                  </div>
                </div>
              )}

              {leads.map((lead, i) => {
                const mins = timers[lead.id] ?? lead.expiresIn
                const isOpen = expandedLead === lead.id
                const isCommentLead = !!lead.commentLead

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
                        {isCommentLead && (
                          <span className="comment-lead-badge">💬 Signal in comments</span>
                        )}
                      </div>
                      <div className="timer-badge" style={{ color: timerColor(mins) }}>
                        <span className="timer-dot" style={{ background: timerColor(mins) }} />
                        {urgencyLabel(mins)} · {formatTimer(mins)}
                      </div>
                    </div>

                    <h3 className="lead-title">{lead.title}</h3>

                    {/* If signal came from a comment, show the comment — not the post body */}
                    {isCommentLead ? (
                      <div className="comment-signal-box">
                        <span className="comment-signal-label">💬 Buying signal found in a comment:</span>
                        <p className="comment-signal-text">
                          {lead.commentLead.body.length > 280
                            ? lead.commentLead.body.slice(0, 280) + '...'
                            : lead.commentLead.body}
                        </p>
                      </div>
                    ) : (
                      lead.body && <p className="lead-body">{lead.body.length > 220 ? lead.body.slice(0, 220) + '...' : lead.body}</p>
                    )}

                    {/* Specific problem match — not generic "relevant to your audience" */}
                    <div className="lead-reason">
                      <span className="lead-reason-label">Problem matched:</span>
                      <span>{lead.specificProblem || lead.reason}</span>
                    </div>

                    <div className="lead-reason" style={{ marginTop: 4, opacity: 0.75 }}>
                      <span className="lead-reason-label">Why qualified:</span>
                      <span>{lead.reason}</span>
                    </div>

                    {isOpen && (
                      <div className="reply-gate-box">
                        <div className="reply-gate-icon">✍️</div>
                        <p className="reply-gate-headline">Your reply is ready</p>
                        <p className="reply-gate-sub">
                          Kairo drafts a personalized reply for every lead — written to match their exact situation. Join the waitlist to unlock it.
                        </p>
                        <a
                          href={GOOGLE_FORM}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="reply-gate-btn"
                        >
                          Join Kairo to get your reply →
                        </a>
                        <p className="reply-gate-note">Free · Launching August 13th · No credit card</p>
                      </div>
                    )}

                    <div className="lead-actions">
                      <button className="lead-btn-primary" onClick={() => setExpandedLead(isOpen ? null : lead.id)}>
                        {isOpen ? 'Hide Reply' : '✍️ View Draft Reply'}
                      </button>
                      <a href={lead.url} target="_blank" rel="noopener noreferrer" className="lead-btn-secondary">
                        Open in Reddit ↗
                      </a>
                    </div>
                  </div>
                )
              })}

              {/* Join CTA — only show if there were leads */}
              {leads.length > 0 && (
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
              )}
            </div>
          </div>
        )}

        {/* ── GATE ── */}
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
