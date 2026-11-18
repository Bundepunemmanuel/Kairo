import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import Head from 'next/head'
import { getShareByToken } from '../../lib/getShareData'
import ScoreGauge from '../../components/ScoreGauge'
import { track } from '../_app'

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

// Previously "leads go cold in 24 hours" only existed in the og:description
// meta tag — invisible to anyone who'd actually clicked through and was
// reading the page itself. This renders the same urgency as a live,
// visible badge on each lead card that's still inside its window, ticking
// down in real time rather than frozen at page-load (see the nowTick
// state in the component below forcing a re-render every 30s).
function formatTimeLeft(lead) {
  if (!lead.createdAt) return null
  const minutesLeft = windowMinutes() - (Date.now() - lead.createdAt) / 60000
  if (minutesLeft <= 0) return null
  const hours = Math.floor(minutesLeft / 60)
  const mins = Math.round(minutesLeft % 60)
  if (hours >= 1) return `${hours}h ${mins}m left`
  return `${Math.max(mins, 1)}m left`
}

// Plain "posted Nh ago" — states a fact about the post's age rather than
// commanding the reader to act on it. Used next to the unlock link below
// instead of a countdown-with-imperative ("unlock before it's gone").
function hoursAgo(lead) {
  if (!lead.createdAt) return null
  const hours = Math.floor((Date.now() - lead.createdAt) / 60000 / 60)
  if (hours < 1) return 'less than an hour ago'
  return `${hours}h ago`
}

// Renders nothing once a lead's window has fully elapsed (formatTimeLeft
// returns null) — same as the plain badge before it. The fill width
// recomputes on every parent re-render, which happens every 30s via the
// nowTick state in the component below, so this visibly drains in real
// time rather than sitting at a frozen percentage.
function UrgencyBar({ lead }) {
  const label = formatTimeLeft(lead)
  if (!label) return null
  const ageMinutes = (Date.now() - lead.createdAt) / 60000
  const pct = Math.max(0, Math.min(100, ((windowMinutes() - ageMinutes) / windowMinutes()) * 100))
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', margin: '8px 0 2px' }}>
      <div style={{ flex: 1, height: 5, borderRadius: 3, background: 'rgba(192,88,74,0.15)', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: 'var(--rust)', borderRadius: 3, transition: 'width 1s linear' }} />
      </div>
      <span style={{ fontSize: '0.72rem', color: 'var(--rust)', whiteSpace: 'nowrap', fontWeight: 600 }}>⏳ {label}</span>
    </div>
  )
}

// Splits a drafted reply into its first sentence (shown free, as a
// teaser proving the reply is real and specific) and the remainder
// (blurred, gated behind signup — see the draft-box rendering below).
// Falls back to treating the whole thing as the teaser with nothing left
// to gate if no sentence boundary is found, rather than hiding
// everything.
function splitFirstSentence(text) {
  if (!text) return { first: '', rest: '' }
  const match = text.match(/^.*?[.!?](?:\s|$)/)
  if (!match) return { first: text, rest: '' }
  const first = match[0].trim()
  const rest = text.slice(match[0].length).trim()
  return { first, rest }
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

  // Forces a re-render every 30s so the per-lead urgency bars (see
  // UrgencyBar above) actually count down live instead of freezing at
  // whatever time the page happened to load.
  const [, forceTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => forceTick(v => v + 1), 30000)
    return () => clearInterval(t)
  }, [])

  // Drives the sticky signup bar — stays hidden until the person has
  // actually scrolled past the last lead card. Catches the moment
  // someone's finished reading everything and is deciding "now what,"
  // rather than competing with the lead content for attention up top.
  const [scrolledPastLeads, setScrolledPastLeads] = useState(false)
  const leadsEndRef = useRef(null)
  useEffect(() => {
    const el = leadsEndRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      ([entry]) => setScrolledPastLeads(entry.boundingClientRect.top < 0),
      { threshold: 0 }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    track('share_page_viewed', { status, token })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

  // Carries the scanned product's URL into signup as a plain, editable
  // prefill — never a binding claim of ownership (anyone viewing a public
  // share link may not be the owner; see the in-chat discussion this
  // came out of). Whoever lands on /signup can clear it and type
  // whatever they want; nothing is saved until they themselves submit it.
  const signupHref = `/signup?url=${encodeURIComponent(url)}`

  const topLead = qualified[0] || closeMatches[0]

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
          {/* Was /signup — a cold form with zero product context, sitting
              in the exact spot a visitor checks first, letting them skip
              every lead and every bit of proof on this page before being
              asked to commit. Same fix as Nav.js: route through the
              scan-first flow instead, since this page builds its own nav
              separately and never got that fix. */}
          <Link href="/onboarding" style={{ fontSize: '0.88rem', fontWeight: 600, color: 'var(--rust)', textDecoration: 'none' }}>Sign up</Link>
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
                  One scan found this. Reddit doesn't stop — new people post like this every day, and nobody's watching for them until something is.
                </p>
                <p className="leads-sub leads-sub-meta">
                  Scanned {new Date(created_at).toLocaleDateString()} · This specific link expires in {daysRemaining} {daysRemaining === 1 ? 'day' : 'days'}
                </p>
                {shareCount > 0 && (
                  <p className="leads-sub" style={{ fontWeight: 600, color: 'var(--ink)' }}>
                    Found {shareCount} matching {shareCount === 1 ? 'post' : 'posts'} in this scan.
                  </p>
                )}
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

                <UrgencyBar lead={lead} />

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
                  </div>
                  {lead.replyFailed ? (
                    <p className="draft-text" style={{ opacity: 0.55, fontStyle: 'italic' }}>{lead.reply}</p>
                  ) : (() => {
                    const { first, rest } = splitFirstSentence(lead.reply)
                    const timeLeft = formatTimeLeft(lead)
                    return (
                      <>
                        <p className="draft-text">{first}</p>
                        {rest && (
                          <>
                            {/* Visually blurred AND unselectable/non-interactive — a
                                real gate, not just a style. The old "Copy" button is
                                gone entirely for a gated reply; there's no control
                                left anywhere on this card that hands over the full
                                text without going through signup. */}
                            <p
                              className="draft-text"
                              style={{ filter: 'blur(4px)', userSelect: 'none', pointerEvents: 'none' }}
                              aria-hidden="true"
                            >
                              {rest}
                            </p>
                            <div style={{ marginTop: 8 }}>
                              <Link
                                href={signupHref}
                                style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--rust)', textDecoration: 'none' }}
                                onClick={() => track('share_signup_clicked', { source: 'unlock_reply', subreddit: lead.subreddit })}
                              >
                                See the rest — free account →
                              </Link>
                              <div style={{ fontSize: '0.75rem', color: 'var(--ink-light)', marginTop: 2 }}>
                                {timeLeft
                                  ? `Posted ${hoursAgo(lead)} — threads like this usually go quiet within a day.`
                                  : "This one's a few days old now — newer matches show up with an account."}
                              </div>
                            </div>
                          </>
                        )}
                      </>
                    )
                  })()}
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

                    <UrgencyBar lead={lead} />

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

            {/* Sentinel for the sticky signup bar below — fires once this
                scrolls above the viewport, i.e. once someone's actually
                scrolled past every lead card. */}
            <div ref={leadsEndRef} />

            {/* ── Conversion CTA ──
                Previously an inline scan-your-own-product form, with its
                own account-creation and push-opt-in steps layered on top.
                Replaced with a single link to /signup — the free preview
                here already gives away the problem match, score, and the
                full drafted reply, so there's no value left to prove by
                scanning again on this page; the simplest next step is
                just getting them to the real signup flow. */}
            <div className="email-gate">
              <div className="email-gate-inner">
                <h3 className="email-gate-headline">Showing one sentence of each reply so you can judge if the match is real.</h3>
                <p className="email-gate-subheadline">Full replies are account-only — otherwise there's nothing left to come back for. An account also runs this same scan on your own product on a schedule, not just once.</p>
                <Link
                  href={signupHref}
                  className="ob-scan-btn"
                  style={{ width: '100%', textAlign: 'center', display: 'block', textDecoration: 'none' }}
                  onClick={() => track('share_signup_clicked', { source: 'cta', subreddit: topLead?.subreddit || null })}
                >
                  Scan your product →
                </Link>
                <p className="email-gate-note">Free to start. No credit card required.</p>
              </div>
            </div>
          </div>
        </div>

        {/* ── Sticky signup bar ──
            Hidden until the person has scrolled past every lead card —
            catches the "ok, now what" moment right after they've finished
            reading, rather than competing with the leads for attention. */}
        {scrolledPastLeads && (
          <div
            style={{
              position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 50,
              background: 'var(--paper, #fff)', borderTop: '1px solid rgba(0,0,0,0.1)',
              padding: '10px 16px', boxShadow: '0 -4px 16px rgba(0,0,0,0.08)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <Link
              href={signupHref}
              className="ob-scan-btn"
              style={{ textAlign: 'center', textDecoration: 'none', width: '100%', maxWidth: 480 }}
              onClick={() => track('share_signup_clicked', { source: 'sticky_bar', subreddit: topLead?.subreddit || null })}
            >
              Sign up →
            </Link>
          </div>
        )}
      </div>
    </>
  )
}

function KairoLogo({ size = 24 }) {
  return <img src="/logo.png" alt="Kairo" width={size} height={size} style={{ objectFit: 'contain' }} />
}
