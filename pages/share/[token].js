import { useState, useEffect } from 'react'
import { useRouter } from 'next/router'
import Link from 'next/link'
import Head from 'next/head'
import { supabase } from '../../lib/supabase'
import { pushIsSupported, needsHomeScreenInstructions, subscribeToPush } from '../../lib/push'

// ─── Reddit parsing — duplicated from onboarding.js rather than shared,
// matching this codebase's existing pattern of per-page helpers (e.g.
// KairoLogo) over a shared lib for anything view-adjacent. ───────────────
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
      .slice(0, 600)
    const published = (entry.match(/<published>([\s\S]*?)<\/published>/) || [])[1] || ''
    if (!title || !link.includes('/comments/')) continue
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
    const res = await fetch(`/api/reddit?sub=${encodeURIComponent(subreddit)}&sort=new`, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) return []
    const xml = await res.text()
    if (!xml.includes('<entry>')) return []
    return parseAtom(xml, subreddit)
  } catch {
    return []
  }
}

async function fetchCommentsFromBrowser(subreddit, postId) {
  try {
    const res = await fetch(`/api/reddit?mode=comments&sub=${encodeURIComponent(subreddit)}&postId=${encodeURIComponent(postId)}`, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return []
    const data = await res.json()
    return data.comments || []
  } catch {
    return []
  }
}

const isValidUrl = str => {
  try { new URL(str.startsWith('http') ? str : `https://${str}`); return true }
  catch { return false }
}

export default function SharePage() {
  const router = useRouter()
  const { token } = router.query

  const [status, setStatus] = useState('loading') // loading | ready | not_found | expired | error
  const [data, setData] = useState(null)
  const [copiedId, setCopiedId] = useState(null)

  const [notifyUrl, setNotifyUrl] = useState('')
  const [notifyEmail, setNotifyEmail] = useState('')
  const [notifyOpen, setNotifyOpen] = useState(false)
  const [notifyStage, setNotifyStage] = useState('form') // form | scanning | done
  const [notifyError, setNotifyError] = useState('')
  const [notifyExisting, setNotifyExisting] = useState(false)

  useEffect(() => {
    if (!router.isReady || !token) return
    ;(async () => {
      try {
        const res = await fetch(`/api/get-share?token=${encodeURIComponent(token)}`)
        if (res.status === 404) return setStatus('not_found')
        if (res.status === 410) return setStatus('expired')
        if (!res.ok) return setStatus('error')
        const json = await res.json()
        setData(json)
        setStatus('ready')
      } catch {
        setStatus('error')
      }
    })()
  }, [router.isReady, token])

  const handleCopy = (id, text) => {
    navigator.clipboard.writeText(text)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 2000)
  }

  const handleNotifySubmit = async () => {
    setNotifyError('')
    const cleanUrl = notifyUrl.startsWith('http') ? notifyUrl : `https://${notifyUrl}`
    if (!notifyUrl.trim() || !isValidUrl(cleanUrl)) {
      setNotifyError('Please enter a valid URL')
      return
    }
    const trimmedEmail = notifyEmail.trim()
    if (!trimmedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setNotifyError('Please enter a valid email')
      return
    }

    setNotifyStage('scanning')
    try {
      // ── Same analyze → Reddit → score pipeline as onboarding.js's free
      // scan, run for their product this time, not the one being shared.
      const analyzeRes = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: cleanUrl }),
      })
      if (!analyzeRes.ok) throw new Error('Could not analyze your product. Please check the URL and try again.')
      const analyzeData = await analyzeRes.json()
      if (!analyzeData.analysis) throw new Error('Analysis failed. Please try again.')
      const productAnalysis = analyzeData.analysis

      const subreddits = (productAnalysis.subreddits || ['SaaS', 'indiehackers', 'entrepreneur']).slice(0, 6)
      const postArrays = await Promise.all(subreddits.map(fetchSubredditFromBrowser))
      const allPosts = postArrays.flat().filter(p =>
        p.body && p.body.length > 40 &&
        !p.body.includes('submitted by') && !p.body.includes('[link]') && !p.body.includes('[comments]')
      )

      let scoredLeads = []
      if (allPosts.length) {
        const commentsMap = {}
        await Promise.allSettled(allPosts.map(async post => {
          const comments = await fetchCommentsFromBrowser(post.subreddit, post.id)
          if (comments.length) commentsMap[post.id] = comments
        }))
        const scoreRes = await fetch('/api/score', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ posts: allPosts, analysis: productAnalysis, commentsMap, includeCloseMatches: true }),
        })
        const scoreData = await scoreRes.json()
        if (scoreData.error) throw new Error(scoreData.error)
        scoredLeads = scoreData.leads || []
      }

      // Push subscription is best-effort — a denial or an iOS visitor who
      // hasn't installed yet still gets a real watched account below.
      let subscription = null
      if (pushIsSupported() && !needsHomeScreenInstructions()) {
        try {
          subscription = await subscribeToPush()
        } catch (e) {
          console.log('[share] push subscribe error:', e.message)
        }
      }

      const captureRes = await fetch('/api/capture-lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: trimmedEmail, url: cleanUrl, analysis: productAnalysis, leads: scoredLeads, subscription }),
      })
      const captureData = await captureRes.json()
      if (!captureRes.ok) throw new Error(captureData.error || 'Something went wrong. Please try again.')

      if (captureData.existingAccount) {
        setNotifyExisting(true)
      } else if (captureData.session) {
        await supabase.auth.setSession({
          access_token: captureData.session.access_token,
          refresh_token: captureData.session.refresh_token,
        })
      }
      setNotifyStage('done')
    } catch (e) {
      console.log('[share] notify-me error:', e.message)
      setNotifyError(e.message || 'Something went wrong. Please try again.')
      setNotifyStage('form')
    }
  }

  const daysRemaining = data
    ? Math.max(1, Math.ceil((new Date(data.expires_at) - new Date()) / (24 * 60 * 60 * 1000)))
    : null

  if (status === 'loading') {
    return (
      <div className="dash-loading">
        <div className="dash-loading-inner">
          <KairoLogo size={32} />
          <p>Loading shared leads...</p>
        </div>
      </div>
    )
  }

  if (status === 'not_found' || status === 'error') {
    return (
      <div className="ob-page">
        <div className="ob-stage">
          <div className="ob-gate-content">
            <div className="gate-icon">🔍</div>
            <h2 className="gate-headline">Link not found</h2>
            <p className="gate-sub">This share link doesn't exist, or the address is incomplete.</p>
            <div className="gate-actions">
              <Link href="/" className="btn-primary">Run your own scan →</Link>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (status === 'expired') {
    return (
      <div className="ob-page">
        <div className="ob-stage">
          <div className="ob-gate-content">
            <div className="gate-icon">⏳</div>
            <h2 className="gate-headline">This link has expired</h2>
            <p className="gate-sub">Shared scans are only viewable for 7 days. Run a fresh scan to see current results.</p>
            <div className="gate-actions">
              <Link href="/" className="btn-primary">Run your own scan →</Link>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const { url, analysis, leads, created_at } = data
  const qualified = leads.filter(l => l.tier !== 'close')
  const closeMatches = leads.filter(l => l.tier === 'close')

  return (
    <>
      <Head>
        <title>{analysis.name} — Leads found by Kairo</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
      </Head>

      <div className="ob-page">
        <nav className="ob-nav">
          <Link href="/" className="nav-logo" style={{ textDecoration: 'none' }}>
            <KairoLogo size={22} />
            <span style={{ fontFamily: 'var(--font-display)', fontSize: '1.15rem', fontWeight: 700, color: 'var(--ink)' }}>Kairo</span>
          </Link>
          <Link href="/signup" style={{ fontSize: '0.88rem', fontWeight: 600, color: 'var(--rust)', textDecoration: 'none' }}>Sign up</Link>
        </nav>

        <div className="ob-results">
          <div className="product-bar">
            <div className="product-bar-inner">
              <div className="product-info">
                <span className="product-tag">Leads found for</span>
                <span className="product-name">{analysis.name}</span>
                <span className="product-desc">{analysis.description}</span>
              </div>
            </div>
          </div>

          <div className="leads-wrap">
            <div className="leads-header">
              <div>
                <h2 className="leads-headline">
                  {qualified.length > 0
                    ? `${qualified.length} qualified ${qualified.length === 1 ? 'lead' : 'leads'} found`
                    : 'No qualifying leads in this scan'}
                </h2>
                <p className="leads-sub">
                  Scanned {new Date(created_at).toLocaleDateString()} · This link expires in {daysRemaining} {daysRemaining === 1 ? 'day' : 'days'}
                </p>
              </div>
            </div>

            {qualified.map(lead => (
              <div key={lead.id} className="lead-card">
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
                </div>

                <h3 className="lead-title">{lead.title}</h3>

                {lead.body && (
                  <p className="lead-body">{lead.body.length > 220 ? lead.body.slice(0, 220) + '...' : lead.body}</p>
                )}

                <div className="lead-reason">
                  <span className="lead-reason-label">Problem matched:</span>
                  <span>{lead.specificProblem || lead.reason}</span>
                </div>
                <div className="lead-reason" style={{ marginTop: 4, opacity: 0.75 }}>
                  <span className="lead-reason-label">Why qualified:</span>
                  <span>{lead.reason}</span>
                </div>

                <div className="draft-box">
                  <div className="draft-header">
                    <span className="draft-label">✍️ Draft Reply</span>
                    {!lead.replyFailed && (
                      <button className="copy-btn" onClick={() => handleCopy(lead.id, lead.reply)}>
                        {copiedId === lead.id ? 'Copied!' : 'Copy'}
                      </button>
                    )}
                  </div>
                  <p className="draft-text" style={lead.replyFailed ? { opacity: 0.55, fontStyle: 'italic' } : undefined}>
                    {lead.reply}
                  </p>
                </div>

                <div className="lead-actions">
                  <a href={lead.url} target="_blank" rel="noopener noreferrer" className="lead-btn-secondary">
                    Open in Reddit ↗
                  </a>
                </div>
              </div>
            ))}

            {closeMatches.length > 0 && (
              <div className="close-matches-section">
                <h3 className="close-matches-title">Close matches</h3>
                <p className="close-matches-sub">
                  Didn't quite clear the bar for a qualified lead, but real posts worth a look.
                </p>
                {closeMatches.map(lead => (
                  <div key={lead.id} className="close-match-card">
                    <div className="close-match-top">
                      <span className="close-match-badge">Close match</span>
                      <span className="lead-subreddit">r/{lead.subreddit}</span>
                      <span className="lead-score">Score: {Number(lead.score).toFixed(1)}</span>
                    </div>
                    <h4 className="close-match-title">{lead.title}</h4>
                    {lead.body && (
                      <p className="close-match-body">{lead.body.length > 180 ? lead.body.slice(0, 180) + '...' : lead.body}</p>
                    )}
                    <a href={lead.url} target="_blank" rel="noopener noreferrer" className="lead-btn-secondary">
                      Open in Reddit ↗
                    </a>
                  </div>
                ))}
              </div>
            )}

            {/* ── Conversion CTAs ── */}
            <div className="email-gate">
              <div className="email-gate-inner">
                <h3 className="email-gate-headline">Want Kairo watching for leads like these on your own product?</h3>

                <div className="share-cta-row">
                  <Link href="/signup" className="ob-scan-btn" style={{ textAlign: 'center', textDecoration: 'none', flex: 1 }}>
                    Start finding leads free
                  </Link>
                </div>
                <p className="email-gate-note" style={{ marginBottom: 14 }}>No credit card. See what Kairo finds for you.</p>

                {notifyStage === 'done' ? (
                  <div className="email-success">
                    <div className="email-success-icon">✅</div>
                    <div>
                      <div className="email-success-title">
                        {notifyExisting ? 'You already have a Kairo account' : "You're all set"}
                      </div>
                      <div className="email-success-note">
                        {notifyExisting
                          ? "We've saved this scan there — check your existing dashboard for updates."
                          : "We'll watch your product and notify you the moment something strong appears."}
                      </div>
                      {!notifyExisting && (
                        <Link href="/dashboard" style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--rust)' }}>
                          Go to your dashboard →
                        </Link>
                      )}
                    </div>
                  </div>
                ) : notifyOpen ? (
                  <>
                    {notifyStage === 'scanning' ? (
                      <p className="email-gate-note" style={{ fontStyle: 'italic' }}>Scanning your product and setting up notifications...</p>
                    ) : (
                      <>
                        <div className="email-gate-row" style={{ marginBottom: 8 }}>
                          <input
                            type="text"
                            className="email-input"
                            placeholder="yourproduct.com"
                            value={notifyUrl}
                            onChange={e => { setNotifyUrl(e.target.value); setNotifyError('') }}
                          />
                        </div>
                        <div className="email-gate-row">
                          <input
                            type="email"
                            className="email-input"
                            placeholder="you@example.com"
                            value={notifyEmail}
                            onChange={e => { setNotifyEmail(e.target.value); setNotifyError('') }}
                            onKeyDown={e => e.key === 'Enter' && handleNotifySubmit()}
                          />
                          <button className="email-submit" onClick={handleNotifySubmit}>
                            Notify me
                          </button>
                        </div>
                      </>
                    )}
                    {notifyError && <p className="ob-error">{notifyError}</p>}
                  </>
                ) : (
                  <button
                    className="lead-btn-secondary"
                    style={{ width: '100%', textAlign: 'center' }}
                    onClick={() => setNotifyOpen(true)}
                  >
                    Just tell us where to send them
                  </button>
                )}
                <p className="email-gate-note">We'll scan your product and notify you the moment we find a real match — no account needed to start.</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

function KairoLogo({ size = 24 }) {
  return <img src="/logo.png" alt="Kairo" width={size} height={size} style={{ objectFit: 'contain' }} />
}
