import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import Head from 'next/head'
import { useRouter } from 'next/router'
import { supabase } from '../lib/supabase'
import { useAuth } from './_app'

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
  const { user, loading: authLoading } = useAuth()
  const router = useRouter()
  const [url, setUrl] = useState('')
  const [stage, setStage] = useState('input')
  const [checkingExisting, setCheckingExisting] = useState(true)
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

  // ── Zero-results capture (email + push, no signup form) ──
  const [captureEmail, setCaptureEmail] = useState('')
  const [capturing, setCapturing] = useState(false)
  const [captureError, setCaptureError] = useState('')
  const [captureDone, setCaptureDone] = useState(false)
  const [captureExisting, setCaptureExisting] = useState(false)
  // Set right before we mint a session for a freshly-captured account, so
  // the profile-check effect below doesn't immediately redirect to
  // /dashboard and slam them into the password gate — they should get to
  // see the "we'll notify you" confirmation and leave on their own terms.
  const justCapturedRef = useRef(false)

  // If a logged-in user already has a saved product profile, send them straight
  // to the dashboard instead of showing the anonymous-visitor marketing funnel.
  // A logged-in user with NO saved profile yet still sees onboarding normally —
  // this is how they scan for the first time after signing up.
  useEffect(() => {
    if (authLoading) return
    if (!user) { setCheckingExisting(false); return }

    const checkExistingProfile = async () => {
      try {
        const { data } = await supabase
          .from('product_profiles')
          .select('id')
          .eq('user_id', user.id)
          .single()
        if (data) {
          if (justCapturedRef.current) {
            justCapturedRef.current = false
            setCheckingExisting(false)
            return
          }
          router.replace('/dashboard')
          return
        }
      } catch {
        // No profile found — fine, let them onboard normally
      }

      // No profile yet — check for a scan carried over from the "Keep
      // watching for me" signup flow, so they don't have to redo the
      // scan they already just watched run once.
      try {
        const pending = sessionStorage.getItem('kairo_pending_scan')
        if (pending) {
          const { url: pendingUrl, analysis: pendingAnalysis, leads: pendingLeads } = JSON.parse(pending)
          sessionStorage.removeItem('kairo_pending_scan')

          await supabase.from('product_profiles').upsert({
            user_id: user.id,
            url: pendingUrl,
            analysis: pendingAnalysis,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'user_id' })

          const qualifiedOnly = (pendingLeads || []).filter(l => l.tier !== 'close')
          if (qualifiedOnly.length > 0) {
            const leadsToSave = qualifiedOnly.map(lead => ({
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
            }))
            await supabase.from('leads').insert(leadsToSave)
          }

          router.replace('/dashboard')
          return
        }
      } catch (e) {
        console.log('[onboarding] pending scan restore error:', e.message)
        // Non-fatal — just falls through to normal onboarding below
      }

      setCheckingExisting(false)
    }
    checkExistingProfile()
  }, [user, authLoading, router])

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

    // The one-free-scan gate is for anonymous marketing visitors only.
    // Logged-in users (e.g. right after signup) should always be able to
    // scan — their actual usage is governed by their plan's daily quota,
    // enforced separately by cron-scan.
    if (!user && localStorage.getItem('kairo_scan_used')) { setStage('gate'); return }

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

      let analyzeData
      try {
        analyzeData = await analyzeRes.json()
      } catch {
        throw new Error('Could not analyze your product. Please check the URL and try again.')
      }
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
        body: JSON.stringify({ posts: allPosts, analysis: productAnalysis, commentsMap, includeCloseMatches: true }),
      })

      const { leads: scoredLeads, error: scoreError } = await scoreRes.json()

      if (scoreError) throw new Error(scoreError)

      localStorage.setItem('kairo_scan_used', '1')
      setLeads(scoredLeads || [])
      setStage('results')

      // Save product profile and leads to database if user is logged in
      if (user) {
        try {
          // Save product profile
          await supabase.from('product_profiles').upsert({
            user_id: user.id,
            url: clean,
            analysis: productAnalysis,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'user_id' })

          // Save leads — qualified tier only. Close matches are shown in
          // the onboarding UI for context but were explicitly scoped to
          // stay there; the real leads table has no tier concept, so
          // saving a close match here would misrepresent it as fully
          // qualified on the actual dashboard.
          const qualifiedOnly = (scoredLeads || []).filter(l => l.tier !== 'close')
          if (qualifiedOnly.length > 0) {
            // Delete old leads first
            await supabase.from('leads').delete().eq('user_id', user.id)
            // Insert new leads
            const leadsToSave = qualifiedOnly.map(lead => ({
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
            }))
            await supabase.from('leads').insert(leadsToSave)
          }
        } catch (e) {
          console.log('[onboarding] save error:', e.message)
          // Non-fatal — scan still worked
        }
      }
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

  // ── Zero-results capture ──────────────────────────────────────────────
  // Same VAPID conversion used in settings.js's push flow.
  const urlBase64ToUint8Array = (base64String) => {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
    const rawData = atob(base64)
    return Uint8Array.from([...rawData].map(char => char.charCodeAt(0)))
  }

  const isIOS = () =>
    typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream

  const isStandalone = () =>
    typeof window !== 'undefined' &&
    (window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches)

  const pushIsSupported = () =>
    typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window

  // iOS Safari only supports push once the site's been added to the home
  // screen and reopened from there — pushIsSupported() alone doesn't
  // capture that. Show them how, rather than a button that silently fails.
  const needsHomeScreenInstructions = () => isIOS() && !isStandalone()

  const handleCaptureLead = async () => {
    setCaptureError('')
    const trimmedEmail = captureEmail.trim()
    if (!trimmedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setCaptureError('Please enter a valid email')
      return
    }

    setCapturing(true)
    let subscription = null

    // Only attempt push where it can actually work. iOS-not-yet-installed
    // visitors still get an account + saved scan below — they just won't
    // get a push until they add Kairo to their home screen (see the
    // instructions shown alongside this form) and enable it in Settings.
    if (pushIsSupported() && !needsHomeScreenInstructions()) {
      try {
        const permission = await Notification.requestPermission()
        if (permission !== 'granted') {
          setCaptureError('Notification permission was denied. You can enable it later in your browser settings.')
          setCapturing(false)
          return
        }
        const registration = await navigator.serviceWorker.register('/sw.js')
        await navigator.serviceWorker.ready
        const sub = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(process.env.NEXT_PUBLIC_VAPID_KEY),
        })
        subscription = sub.toJSON()
      } catch (e) {
        console.log('[onboarding] push subscribe error:', e.message)
        setCaptureError('Could not enable notifications. Please try again.')
        setCapturing(false)
        return
      }
    }

    try {
      const res = await fetch('/api/capture-lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: trimmedEmail, url, analysis, leads, subscription }),
      })
      const data = await res.json()
      if (!res.ok) {
        setCaptureError(data.error || 'Something went wrong. Please try again.')
        setCapturing(false)
        return
      }

      if (data.existingAccount) {
        // Email already belongs to a real account — profile/push were
        // saved under it, but we never sign into someone else's account.
        setCaptureExisting(true)
      } else if (data.session) {
        justCapturedRef.current = true
        await supabase.auth.setSession({
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
        })
      }
      setCaptureDone(true)
    } catch (e) {
      console.log('[onboarding] capture-lead error:', e.message)
      setCaptureError('Something went wrong. Please try again.')
    } finally {
      setCapturing(false)
    }
  }

  // Avoid flashing the marketing funnel while we check if a logged-in user
  // already has a saved profile and should be redirected to /dashboard instead.
  if (checkingExisting) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: 'var(--cream)' }}>
        <p style={{ color: 'var(--ink-light)', fontFamily: 'DM Sans, sans-serif' }}>Loading...</p>
      </div>
    )
  }

  // Derived, not stored — leads can include both qualified and close-match
  // tiers now, so any "N leads found" copy must count qualified only or
  // it misrepresents how many actually cleared the real bar.
  const qualifiedCount = leads.filter(l => l.tier !== 'close').length

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
          {user ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Link href="/dashboard" style={{ fontSize: '0.88rem', fontWeight: 500, color: 'var(--rust)', textDecoration: 'none' }}>Dashboard</Link>
              <button
                onClick={async () => { await supabase.auth.signOut(); window.location.href = '/' }}
                style={{ fontSize: '0.82rem', color: 'var(--ink-light)', background: 'none', border: 'none', cursor: 'pointer' }}
              >
                Sign out
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Link href="/login" style={{ fontSize: '0.88rem', fontWeight: 500, color: 'var(--ink-light)', textDecoration: 'none' }}>Login</Link>
              <Link href="/signup" style={{ fontSize: '0.88rem', fontWeight: 600, color: 'var(--rust)', textDecoration: 'none' }}>Sign up</Link>
            </div>
          )}
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

            {/* Small commitment step after the first real action (Commitment
                & Consistency) — only meaningful for a signed-in user, since
                that's the only case where a product_profiles row exists to
                actually confirm/adjust. Anonymous visitors get the
                sign-up CTA further down instead. */}
            {user && (
              <div className="confirm-subs-nudge">
                <span>We'll keep watching these subreddits automatically going forward.</span>
                <Link href="/settings" className="confirm-subs-link">Add or adjust subreddits →</Link>
              </div>
            )}

            <div className="leads-wrap">
              <div className="leads-header">
                <div>
                  <h2 className="leads-headline">
                    {qualifiedCount > 0
                      ? `${qualifiedCount} qualified ${qualifiedCount === 1 ? 'lead' : 'leads'} found`
                      : 'No qualifying leads right now'}
                  </h2>
                  <p className="leads-sub">
                    {qualifiedCount > 0
                      ? 'Every lead matched to a specific problem you solve. Sorted by urgency.'
                      : scanStats
                        ? `Scanned ${scanStats.postsScanned} posts across ${scanStats.subreddits.length} subreddits. Nothing matched your specific problems.`
                        : 'Posts scanned but nothing matched your specific problems.'}
                  </p>
                </div>
                {qualifiedCount > 0 && (
                  <div className="free-tag">3 free · <Link href="/signup" className="upgrade-link">Sign up for more</Link></div>
                )}
              </div>

              {/* Zero results state — honest, and still gives something */}
              {leads.length === 0 && (
                <div className="no-leads-box">
                  <div className="no-leads-icon">🔍</div>
                  <h3 className="no-leads-headline">No high-intent posts right now</h3>
                  <p className="no-leads-body">
                    This is normal — demand for most products comes in waves, not a steady stream. Kairo only surfaces leads where someone is <strong>specifically experiencing a problem you solve</strong>, and right now the recent posts in your subreddits don't meet that bar.
                  </p>
                  <p className="no-leads-body" style={{ marginTop: 8 }}>
                    Kairo keeps scanning every 15–30 minutes and will notify you the moment something strong appears.
                  </p>
                  <div className="no-leads-actions">
                    {captureDone ? (
                      <div className="email-success">
                        <div className="email-success-icon">✅</div>
                        <div>
                          <div className="email-success-title">
                            {captureExisting ? 'You already have a Kairo account' : "You're all set"}
                          </div>
                          <div className="email-success-note">
                            {captureExisting
                              ? "We've saved this scan there — check your existing dashboard for updates."
                              : needsHomeScreenInstructions()
                                ? "We'll save this scan and start watching now. Add Kairo to your home screen (below) to get notified the moment something appears."
                                : "We'll watch for you and notify you the moment something strong appears — no need to keep this tab open."}
                          </div>
                        </div>
                      </div>
                    ) : needsHomeScreenInstructions() ? (
                      <div className="email-gate">
                        <div className="email-gate-inner">
                          <div className="email-gate-icon">📲</div>
                          <h3 className="email-gate-headline">Add Kairo to your home screen</h3>
                          <p className="email-gate-sub">
                            Safari on iPhone only allows notifications for sites added to your home screen. Tap the Share button below, then "Add to Home Screen" — then come back here and reopen Kairo from your home screen to get notified.
                          </p>
                          <div className="email-gate-row">
                            <input
                              type="email"
                              className="email-input"
                              placeholder="you@example.com"
                              value={captureEmail}
                              onChange={e => { setCaptureEmail(e.target.value); setCaptureError('') }}
                            />
                            <button className="email-submit" onClick={handleCaptureLead} disabled={capturing}>
                              {capturing ? 'Saving...' : 'Save my scan'}
                            </button>
                          </div>
                          {captureError && <p className="ob-error">{captureError}</p>}
                          <p className="email-gate-note">We'll start watching now — notifications work once you've added Kairo to your home screen.</p>
                        </div>
                      </div>
                    ) : (
                      <div className="email-gate">
                        <div className="email-gate-inner">
                          <div className="email-gate-icon">🔔</div>
                          <h3 className="email-gate-headline">Get notified the moment something appears</h3>
                          <p className="email-gate-sub">
                            Leave your email and enable browser notifications — no password, no signup form.
                          </p>
                          <div className="email-gate-row">
                            <input
                              type="email"
                              className="email-input"
                              placeholder="you@example.com"
                              value={captureEmail}
                              onChange={e => { setCaptureEmail(e.target.value); setCaptureError('') }}
                              onKeyDown={e => e.key === 'Enter' && handleCaptureLead()}
                            />
                            <button className="email-submit" onClick={handleCaptureLead} disabled={capturing}>
                              {capturing ? 'Setting up...' : 'Notify me'}
                            </button>
                          </div>
                          {captureError && <p className="ob-error">{captureError}</p>}
                          <p className="email-gate-note">We'll ask your browser for notification permission — nothing else.</p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {leads.filter(l => l.tier !== 'close').map((lead, i) => {
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
                      <div className="draft-box">
                        <div className="draft-header">
                          <span className="draft-label">✍️ Draft Reply</span>
                          {replies[lead.id] && (
                            <button className="copy-btn" onClick={() => handleCopy(lead.id, replies[lead.id])}>
                              {copiedId === lead.id ? 'Copied!' : 'Copy'}
                            </button>
                          )}
                        </div>
                        {replyLoading[lead.id] ? (
                          <p className="draft-text" style={{ opacity: 0.6, fontStyle: 'italic' }}>Writing reply...</p>
                        ) : replies[lead.id] ? (
                          <p className="draft-text">{replies[lead.id]}</p>
                        ) : (
                          <p className="draft-text" style={{ opacity: 0.55, fontStyle: 'italic' }}>
                            Could not generate a reply. Open the thread and reply manually using the problem context above.
                          </p>
                        )}
                      </div>
                    )}

                    <div className="lead-actions">
                      <button className="lead-btn-primary" onClick={() => handleViewReply(lead.id, lead)}>
                        {isOpen ? 'Hide Reply' : '✍️ View Draft Reply'}
                      </button>
                      <a href={lead.url} target="_blank" rel="noopener noreferrer" className="lead-btn-secondary">
                        Open in Reddit ↗
                      </a>
                    </div>
                  </div>
                )
              })}

              {/* Close matches — real, scored posts just below the strict
                  qualify bar. Never fabricated, always labeled honestly
                  as lower-confidence, never styled to look like a
                  qualified lead. */}
              {leads.filter(l => l.tier === 'close').length > 0 && (
                <div className="close-matches-section">
                  <h3 className="close-matches-title">Close matches</h3>
                  <p className="close-matches-sub">
                    Didn't quite clear the bar for a qualified lead, but real posts worth a look.
                  </p>
                  {leads.filter(l => l.tier === 'close').map(lead => (
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

              {/* Sign up CTA — only show if there were leads */}
              {leads.length > 0 && (
                <div className="email-gate">
                  <div className="email-gate-inner">
                    <div className="email-gate-icon">🚀</div>
                    <h3 className="email-gate-headline">Want leads like these every day?</h3>
                    <p className="email-gate-sub">
                      Kairo scans Reddit automatically and finds critical leads while you focus on building.
                    </p>
                    <Link
                      href="/signup"
                      className="ob-scan-btn"
                      style={{ textAlign: 'center', textDecoration: 'none', display: 'block', marginTop: 4 }}
                    >
                      Sign up — Free →
                    </Link>
                    <p className="email-gate-note">No credit card required</p>
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
              <p className="gate-sub">Sign up free to scan again and get leads automatically every day.</p>
              <div className="gate-actions">
                <Link href="/signup" className="btn-primary">Sign up — Free →</Link>
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
  return <img src="/logo.png" alt="Kairo" width={size} height={size} style={{ objectFit: 'contain' }} />
}
