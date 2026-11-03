import { useState, useEffect } from 'react'
import Link from 'next/link'
import Head from 'next/head'
import { supabase } from '../../lib/supabase'
import { pushIsSupported, needsHomeScreenInstructions, subscribeToPush } from '../../lib/push'
import { getShareByToken } from '../../lib/getShareData'
import ScoreGauge from '../../components/ScoreGauge'
import { track } from '../_app'

// ─── Reddit parsing — duplicated from onboarding.js rather than shared,
// matching this codebase's existing pattern of per-page helpers (e.g.
// KairoLogo) over a shared lib for anything view-adjacent. ───────────────
function parseAtom(xml, defaultSubreddit) {
  const posts = []
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)]
  for (const m of entries) {
    const entry = m[1]
    const title = (entry.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1]
      ?.replace(/<!\[CDATA\[|\]\]>/g, '')?.trim() ?? ''
    const link = (entry.match(/<link[^>]*href="([^"]+)"/) || [])[1]?.trim() ?? ''
    // Each entry carries its own subreddit via <category term="...">,
    // which matters now that one request can combine several subreddits
    // (multireddit batching). Falls back to defaultSubreddit only if the
    // tag is ever missing.
    const subreddit = (entry.match(/<category term="([^"]+)"/) || [])[1] || defaultSubreddit
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

// `subs` may be a single subreddit or several joined with "+" — see
// onboarding.js for the full reasoning (encodeURIComponent → %2B, which
// Reddit decodes back to a literal "+" and reads as the multireddit
// separator).
//
// No keywords param — reddit.js no longer reads one (week-search via
// Reddit's search endpoint was tried, then reversed; not coming back).
//
// source='direct' (default) or 'worker' — see onboarding.js for the full
// reasoning (the Cloudflare Worker proxy is a separate IP with its own
// independent quota bucket).
async function fetchSubredditFromBrowser(subs, source = 'direct') {
  try {
    const res = await fetch(`/api/reddit?sub=${encodeURIComponent(subs)}&sort=new&source=${source}`, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) return []
    const xml = await res.text()
    if (!xml.includes('<entry>')) return []
    return parseAtom(xml, subs)
  } catch {
    return []
  }
}

// ─── Shared Reddit quota status ─────────────────────────────────────────
// See onboarding.js for the full reasoning — a plain Supabase read via
// reddit.js's mode=status, never an outbound Reddit request itself.
// Returns both the direct and worker buckets.
async function fetchQuotaStatus() {
  try {
    const res = await fetch('/api/reddit?mode=status', { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

// Splits up to 6 subreddits into two halves of up to 3, fetched
// concurrently (direct + worker) — see onboarding.js's
// fetchSubredditsDualPath for the full reasoning. Replaces the previous
// chunkSubreddits + staggeredMap pair, which existed to pace requests
// against each other under one shared quota; direct and worker don't
// share anything, so there's nothing left to pace.
async function fetchSubredditsDualPath(subreddits) {
  const directSubs = subreddits.slice(0, 3)
  const workerSubs = subreddits.slice(3, 6)

  const [directPosts, workerPosts] = await Promise.all([
    directSubs.length ? fetchSubredditFromBrowser(directSubs.join('+'), 'direct') : Promise.resolve([]),
    workerSubs.length ? fetchSubredditFromBrowser(workerSubs.join('+'), 'worker') : Promise.resolve([]),
  ])

  console.log(`[share] direct ${directPosts.length} posts, worker ${workerPosts.length} posts`)
  return [...directPosts, ...workerPosts]
}

const isValidUrl = str => {
  try { new URL(str.startsWith('http') ? str : `https://${str}`); return true }
  catch { return false }
}

// Reply window mirrors score.js (flat 24h, counted from when the post went
// up, i.e. lead.createdAt) and the same copy in pages/api/og.js — keep all
// three in sync. Only used to decide whether the link-preview caption may
// carry urgency copy: with the 7-day search window, many leads are already
// past their window, so "go cold" copy must not imply those are fresh.
const windowMinutes = () => 1440
const isInsideWindow = lead => {
  if (!lead.createdAt) return false
  return (Date.now() - lead.createdAt) / 60000 < windowMinutes(lead)
}

// SSR, not client fetch — the only page in this app that needs it. Link
// preview bots (Slack, Twitter, iMessage) read only the first server
// response and don't wait for or execute client-side fetches, so the
// og:title/og:image tags below have to be correct before this component
// ever runs in a browser.
export async function getServerSideProps({ params }) {
  const result = await getShareByToken(params.token)
  return { props: { token: params.token, initialStatus: result.status, initialData: result.data || null } }
}

export default function SharePage({ token, initialStatus, initialData }) {
  const status = initialStatus // ready | not_found | expired
  const data = initialData
  const [copiedId, setCopiedId] = useState(null)

  const [notifyUrl, setNotifyUrl] = useState('')
  const [notifyEmail, setNotifyEmail] = useState('')
  const [notifyOpen, setNotifyOpen] = useState(false)
  const [notifyStage, setNotifyStage] = useState('form') // form | scanning | done
  const [notifyError, setNotifyError] = useState('')
  const [notifyExisting, setNotifyExisting] = useState(false)

  // ── Shared Reddit quota countdown — see onboarding.js for full reasoning ──
  const [quotaResetAt, setQuotaResetAt] = useState(null)
  const [quotaSecondsLeft, setQuotaSecondsLeft] = useState(0)

  useEffect(() => {
    track('share_page_viewed', { status, token })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Checked once on load (this page has no separate "input stage" the way
  // onboarding.js does — the notify form is visible, or one tap away, from
  // the start) so the countdown is already live by the time someone opens
  // the notify form, not discovered only after they submit it.
  useEffect(() => {
    let cancelled = false
    fetchQuotaStatus().then(status => {
      if (cancelled || !status) return
      const serverNowMs = status.serverNow ? new Date(status.serverNow).getTime() : Date.now()

      // Two buckets now (direct + worker) — the countdown reflects
      // whichever resets LATER, since that's the real binding constraint
      // for a scan that draws from both. See onboarding.js for the same logic.
      const msUntilResets = [status.direct?.resetAt, status.worker?.resetAt]
        .filter(Boolean)
        .map(resetAt => new Date(resetAt).getTime() - serverNowMs)
        .filter(ms => ms > 0)

      if (!msUntilResets.length) return
      const msUntilReset = Math.max(...msUntilResets)
      setQuotaResetAt(Date.now() + msUntilReset)
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!quotaResetAt) { setQuotaSecondsLeft(0); return }
    const tick = () => {
      const left = Math.max(0, Math.ceil((quotaResetAt - Date.now()) / 1000))
      setQuotaSecondsLeft(left)
      if (left <= 0) setQuotaResetAt(null)
    }
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [quotaResetAt])

  const handleCopy = (id, text) => {
    navigator.clipboard.writeText(text)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 2000)
  }

  const handleNotifySubmit = async () => {
    setNotifyError('')
    if (quotaSecondsLeft > 0) {
      setNotifyError(`Reddit's shared scan quota is busy right now — available again in ${quotaSecondsLeft}s.`)
      return
    }
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
    track('share_notify_submitted')
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
      const allPostsRaw = await fetchSubredditsDualPath(subreddits)
      const allPosts = allPostsRaw.filter(p =>
        p.body && p.body.length > 40 &&
        !p.body.includes('submitted by') && !p.body.includes('[link]') && !p.body.includes('[comments]')
      )

      let scoredLeads = []
      if (allPosts.length) {
        // Comment-fetching used to happen here, but score.js never read it
        // and the comments endpoint gets Reddit's explicit anti-bot block
        // page every time now — removed, same as onboarding.js.
        const scoreRes = await fetch('/api/score', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ posts: allPosts, analysis: productAnalysis, includeCloseMatches: true }),
        })
        const scoreData = await scoreRes.json()
        if (scoreData.error) throw new Error(scoreData.error)
        scoredLeads = scoreData.leads || []
      }

      // Same public homepage ticker as the main onboarding scan — this is
      // just as much "someone scanned their product" as that flow is.
      const qualifiedForFeed = scoredLeads.filter(l => l.tier !== 'close')
      if (qualifiedForFeed.length > 0) {
        fetch('/api/log-scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            productName: productAnalysis.name,
            leadCount: qualifiedForFeed.length,
            topScore: Math.max(...qualifiedForFeed.map(l => l.score || 0)),
            url: cleanUrl,
          }),
        }).catch(() => {})
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
      track('share_notify_completed', { existingAccount: !!captureData.existingAccount })
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

  if (status === 'not_found') {
    return (
      <div className="ob-page">
        <Head>
          <title>Link not found — Kairo</title>
          <meta name="robots" content="noindex" />
        </Head>
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
        <Head>
          <title>This link has expired — Kairo</title>
          <meta name="robots" content="noindex" />
        </Head>
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

  // This is what X draws over the bottom-left of the preview image, so it
  // carries the same hook as the image itself. Falls back to the plain
  // caption when a share has no qualified leads (the image falls back too).
  const shareCount = qualified.length
  const cardCaption = shareCount > 0
    ? `${analysis.name} — ${shareCount} ${shareCount === 1 ? 'person' : 'people'} on Reddit ${shareCount === 1 ? 'needs' : 'need'} this.${qualified.some(isInsideWindow) ? ' Leads go cold in 24 hours.' : ''}`
    : `${analysis.name} — Leads found by Kairo`

  return (
    <>
      <Head>
        <title>{analysis.name} — Leads found by Kairo</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <meta property="og:title" content={cardCaption} />
        <meta property="og:description" content="Kairo scans Reddit and finds people already asking for solutions like yours." />
        <meta property="og:type" content="website" />
        <meta property="og:url" content={`https://kairo-omega.vercel.app/share/${token}`} />
        <meta property="og:image" content={`https://kairo-omega.vercel.app/api/og?token=${token}`} />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={cardCaption} />
        <meta name="twitter:image" content={`https://kairo-omega.vercel.app/api/og?token=${token}`} />
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
                    <ScoreGauge score={lead.score} />
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
                      <ScoreGauge score={lead.score} />
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
                          <button className="email-submit" onClick={handleNotifySubmit} disabled={quotaSecondsLeft > 0}>
                            {quotaSecondsLeft > 0 ? `Available in ${quotaSecondsLeft}s` : 'Notify me'}
                          </button>
                        </div>
                      </>
                    )}
                    {quotaSecondsLeft > 0 && !notifyError && (
                      <p className="ob-error" style={{ color: 'var(--ink-light)' }}>
                        Reddit's shared scan quota is busy right now — available again in {quotaSecondsLeft}s
                      </p>
                    )}
                    {notifyError && <p className="ob-error">{notifyError}</p>}
                  </>
                ) : (
                  <button
                    className="lead-btn-secondary"
                    style={{ width: '100%', textAlign: 'center' }}
                    onClick={() => { setNotifyOpen(true); track('share_notify_opened') }}
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
