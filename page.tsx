'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import styles from './onboarding.module.css'

type Stage = 'input' | 'loading' | 'results' | 'gate'

interface Lead {
  id: string
  title: string
  body: string
  url: string
  subreddit: string
  score: number
  signalType: 'active' | 'passive'
  reason: string
  draftReply: string
  createdAt: number
  expiresIn: number
}

interface ProductAnalysis {
  name: string
  description: string
  targetCustomer: string
  painPoints: string[]
  keywords: string[]
  subreddits: string[]
}

const LOADING_STATES = [
  'Reading your product...',
  'Identifying your ideal customer...',
  'Finding where they spend time...',
  'Scanning Reddit for live signals...',
  'Scoring buying intent...',
  'Drafting your replies...',
]

export default function OnboardingPage() {
  const [url, setUrl] = useState('')
  const [stage, setStage] = useState<Stage>('input')
  const [loadingText, setLoadingText] = useState(LOADING_STATES[0])
  const [loadingIndex, setLoadingIndex] = useState(0)
  const [leads, setLeads] = useState<Lead[]>([])
  const [analysis, setAnalysis] = useState<ProductAnalysis | null>(null)
  const [expandedLead, setExpandedLead] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [email, setEmail] = useState('')
  const [emailSubmitted, setEmailSubmitted] = useState(false)
  const [timers, setTimers] = useState<Record<string, number>>({})
  const [hasUsedFreeScan, setHasUsedFreeScan] = useState(false)

  useEffect(() => {
    const used = localStorage.getItem('kairo_scan_used')
    if (used) setHasUsedFreeScan(true)
  }, [])

  // Animate loading text
  useEffect(() => {
    if (stage !== 'loading') return
    const interval = setInterval(() => {
      setLoadingIndex((prev) => {
        const next = (prev + 1) % LOADING_STATES.length
        setLoadingText(LOADING_STATES[next])
        return next
      })
    }, 1800)
    return () => clearInterval(interval)
  }, [stage])

  // Decay timers
  useEffect(() => {
    if (!leads.length) return
    const interval = setInterval(() => {
      setTimers((prev) => {
        const updated: Record<string, number> = {}
        leads.forEach((lead) => {
          const elapsed = (Date.now() - lead.createdAt) / 1000 / 60
          updated[lead.id] = Math.max(0, lead.expiresIn - elapsed)
        })
        return updated
      })
    }, 10000)
    // Init immediately
    const initial: Record<string, number> = {}
    leads.forEach((lead) => { initial[lead.id] = lead.expiresIn })
    setTimers(initial)
    return () => clearInterval(interval)
  }, [leads])

  const formatTimer = (minutes: number) => {
    if (minutes <= 0) return 'Expired'
    const h = Math.floor(minutes / 60)
    const m = Math.floor(minutes % 60)
    if (h > 0) return `${h}h ${m}m`
    return `${m}m remaining`
  }

  const getTimerColor = (minutes: number) => {
    if (minutes <= 30) return '#c0584a'
    if (minutes <= 120) return '#d4903a'
    return '#6b8a6b'
  }

  const getUrgencyLabel = (minutes: number) => {
    if (minutes <= 30) return '🔴 Critical'
    if (minutes <= 120) return '🟡 Active'
    return '🟢 Fresh'
  }

  const isValidUrl = (str: string) => {
    try {
      const u = new URL(str.startsWith('http') ? str : `https://${str}`)
      return u.hostname.includes('.')
    } catch { return false }
  }

  const handleScan = async () => {
    if (!url.trim()) { setError('Please enter your website URL'); return }
    const cleanUrl = url.startsWith('http') ? url : `https://${url}`
    if (!isValidUrl(cleanUrl)) { setError('Please enter a valid URL'); return }

    // Check IP rate limit
    try {
      const ipCheck = await fetch('/api/check-ip')
      const ipData = await ipCheck.json()
      if (ipData.blocked) {
        setError('You have already used your free scan. Sign up to continue.')
        return
      }
    } catch { /* allow if check fails */ }

    // Check localStorage
    const localUsed = localStorage.getItem('kairo_scan_used')
    if (localUsed) {
      setStage('gate')
      return
    }

    setError('')
    setStage('loading')

    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: cleanUrl }),
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Scan failed')
      }

      const data = await res.json()
      setAnalysis(data.analysis)
      setLeads(data.leads)
      localStorage.setItem('kairo_scan_used', '1')
      setStage('results')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Something went wrong. Please try again.'
      setError(message)
      setStage('input')
    }
  }

  const handleEmailSubmit = async () => {
    if (!email || !email.includes('@')) return
    // Store email - will connect to Supabase in Chunk 3
    localStorage.setItem('kairo_email', email)
    setEmailSubmitted(true)
    // TODO: POST to /api/waitlist when Supabase is ready
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleScan()
  }

  return (
    <div className={styles.page}>
      {/* Nav */}
      <nav className={styles.nav}>
        <Link href="/" className={styles.navLogo}>
          <svg width="24" height="24" viewBox="0 0 100 100" fill="none">
            <rect x="10" y="38" width="45" height="10" rx="5" fill="#c0584a" opacity="0.6"/>
            <rect x="20" y="52" width="45" height="10" rx="5" fill="#c0584a" opacity="0.8"/>
            <rect x="15" y="66" width="45" height="10" rx="5" fill="#c0584a" opacity="0.7"/>
            <circle cx="76" cy="57" r="18" fill="#c0584a"/>
          </svg>
          <span className={styles.navLogoText}>Kairo</span>
        </Link>
        <Link href="/#pricing" className={styles.navPricing}>Pricing</Link>
      </nav>

      {/* Input Stage */}
      {stage === 'input' && (
        <div className={styles.inputStage}>
          <div className={styles.inputContent}>
            <div className={styles.inputBadge}>
              <span className={styles.inputBadgeDot} />
              Free · No signup required
            </div>
            <h1 className={styles.inputHeadline}>
              Paste your URL.<br />
              <em>Find your first customer.</em>
            </h1>
            <p className={styles.inputSub}>
              Kairo reads your product, finds where your customers spend time on Reddit, and surfaces people ready to buy — right now.
            </p>

            <div className={styles.inputBox}>
              <div className={styles.inputWrapper}>
                <span className={styles.inputPrefix}>🌐</span>
                <input
                  className={styles.urlInput}
                  type="text"
                  placeholder="yourstartup.com"
                  value={url}
                  onChange={(e) => { setUrl(e.target.value); setError('') }}
                  onKeyDown={handleKeyDown}
                  autoFocus
                />
              </div>
              {error && <p className={styles.inputError}>{error}</p>}
              <button className={styles.scanButton} onClick={handleScan}>
                Find My Customers →
              </button>
            </div>

            <div className={styles.inputExamples}>
              <span>Try:</span>
              {['lemonsqueezy.com', 'cal.com', 'resend.com'].map((ex) => (
                <button
                  key={ex}
                  className={styles.exampleChip}
                  onClick={() => setUrl(ex)}
                >
                  {ex}
                </button>
              ))}
            </div>

            <div className={styles.inputProof}>
              <div className={styles.inputProofItem}>✓ Results in under 2 minutes</div>
              <div className={styles.inputProofItem}>✓ Real Reddit posts, not samples</div>
              <div className={styles.inputProofItem}>✓ Draft reply included</div>
            </div>
          </div>
        </div>
      )}

      {/* Loading Stage */}
      {stage === 'loading' && (
        <div className={styles.loadingStage}>
          <div className={styles.loadingContent}>
            <div className={styles.loadingOrb}>
              <div className={styles.loadingOrbInner} />
              <div className={styles.loadingOrbRing} />
              <div className={styles.loadingOrbRing2} />
            </div>
            <p className={styles.loadingText}>{loadingText}</p>
            <div className={styles.loadingSteps}>
              {LOADING_STATES.map((s, i) => (
                <div
                  key={s}
                  className={`${styles.loadingStep} ${i <= loadingIndex ? styles.loadingStepActive : ''}`}
                />
              ))}
            </div>
            <p className={styles.loadingNote}>Scanning 50 recent posts across your subreddits</p>
          </div>
        </div>
      )}

      {/* Results Stage */}
      {stage === 'results' && analysis && (
        <div className={styles.resultsStage}>
          {/* Product Summary */}
          <div className={styles.productSummary}>
            <div className={styles.productSummaryInner}>
              <div className={styles.productInfo}>
                <span className={styles.productLabel}>Scanning for</span>
                <span className={styles.productName}>{analysis.name}</span>
                <span className={styles.productDesc}>{analysis.description}</span>
              </div>
              <div className={styles.productSubreddits}>
                {analysis.subreddits.slice(0, 4).map((sub) => (
                  <span key={sub} className={styles.subredditChip}>r/{sub}</span>
                ))}
              </div>
            </div>
          </div>

          {/* Leads */}
          <div className={styles.leadsContainer}>
            <div className={styles.leadsHeader}>
              <div>
                <h2 className={styles.leadsHeadline}>
                  {leads.length} customer {leads.length === 1 ? 'opportunity' : 'opportunities'} found
                </h2>
                <p className={styles.leadsSub}>Sorted by urgency. Act on critical leads first.</p>
              </div>
              <div className={styles.freeTag}>3 free · <Link href="/#pricing" className={styles.upgradeLink}>Upgrade for more</Link></div>
            </div>

            {leads.length === 0 && (
              <div className={styles.noLeads}>
                <p>No high-intent leads found right now. Try again in 15 minutes as new posts arrive.</p>
              </div>
            )}

            {leads.map((lead, index) => {
              const timer = timers[lead.id] ?? lead.expiresIn
              const isExpanded = expandedLead === lead.id
              return (
                <div key={lead.id} className={`${styles.leadCard} ${index === 0 ? styles.leadCardCritical : ''}`}>
                  <div className={styles.leadCardTop}>
                    <div className={styles.leadMeta}>
                      <span className={`${styles.signalBadge} ${lead.signalType === 'active' ? styles.signalActive : styles.signalPassive}`}>
                        {lead.signalType === 'active' ? '🔴 Active Demand' : '🟡 Passive Demand'}
                      </span>
                      <span className={styles.leadSubreddit}>r/{lead.subreddit}</span>
                      <span className={styles.leadScore}>Score: {lead.score.toFixed(1)}</span>
                    </div>
                    <div className={styles.timerBadge} style={{ color: getTimerColor(timer) }}>
                      <span className={styles.timerDot} style={{ background: getTimerColor(timer) }} />
                      {getUrgencyLabel(timer)} · {formatTimer(timer)}
                    </div>
                  </div>

                  <h3 className={styles.leadTitle}>{lead.title}</h3>
                  {lead.body && (
                    <p className={styles.leadBody}>
                      {lead.body.length > 200 ? `${lead.body.slice(0, 200)}...` : lead.body}
                    </p>
                  )}

                  <div className={styles.leadReason}>
                    <span className={styles.leadReasonLabel}>Why this matches:</span>
                    <span>{lead.reason}</span>
                  </div>

                  {isExpanded && (
                    <div className={styles.draftReply}>
                      <div className={styles.draftReplyHeader}>
                        <span className={styles.draftReplyLabel}>✍️ Draft Reply</span>
                        <button
                          className={styles.copyButton}
                          onClick={() => navigator.clipboard.writeText(lead.draftReply)}
                        >
                          Copy
                        </button>
                      </div>
                      <p className={styles.draftReplyText}>{lead.draftReply}</p>
                    </div>
                  )}

                  <div className={styles.leadActions}>
                    <button
                      className={styles.leadActionPrimary}
                      onClick={() => setExpandedLead(isExpanded ? null : lead.id)}
                    >
                      {isExpanded ? 'Hide Reply' : 'View Draft Reply'}
                    </button>
                    <a
                      href={lead.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={styles.leadActionSecondary}
                    >
                      Open in Reddit ↗
                    </a>
                    <button className={styles.leadActionDismiss}>Dismiss</button>
                  </div>
                </div>
              )
            })}

            {/* Email Gate */}
            {!emailSubmitted ? (
              <div className={styles.emailGate}>
                <div className={styles.emailGateContent}>
                  <div className={styles.emailGateIcon}>📬</div>
                  <h3 className={styles.emailGateHeadline}>
                    Want Kairo to find leads like these every day?
                  </h3>
                  <p className={styles.emailGateSub}>
                    Kairo scans Reddit every 15 minutes and sends critical leads straight to you — while you focus on building.
                  </p>
                  <div className={styles.emailGateInput}>
                    <input
                      type="email"
                      placeholder="your@email.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className={styles.emailInput}
                      onKeyDown={(e) => e.key === 'Enter' && handleEmailSubmit()}
                    />
                    <button className={styles.emailSubmit} onClick={handleEmailSubmit}>
                      Get Daily Leads →
                    </button>
                  </div>
                  <p className={styles.emailGateNote}>No spam. No credit card. Unsubscribe anytime.</p>
                </div>
              </div>
            ) : (
              <div className={styles.emailSuccess}>
                <span className={styles.emailSuccessIcon}>🎉</span>
                <div>
                  <p className={styles.emailSuccessTitle}>You're in. Kairo is watching Reddit for you.</p>
                  <p className={styles.emailSuccessNote}>
                    Check your inbox. In the meantime, <Link href="/#pricing" className={styles.upgradeLink}>upgrade to Pro</Link> to unlock all leads and draft replies.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Gate Stage - already used free scan */}
      {stage === 'gate' && (
        <div className={styles.gateStage}>
          <div className={styles.gateContent}>
            <div className={styles.gateIcon}>🔒</div>
            <h2 className={styles.gateHeadline}>You've used your free scan</h2>
            <p className={styles.gateSub}>
              Sign up free to scan again and get 3 leads daily. Upgrade anytime for more.
            </p>
            <div className={styles.gateActions}>
              <Link href="/#pricing" className={styles.gateCta}>
                See Plans →
              </Link>
              <button className={styles.gateBack} onClick={() => { setStage('input'); setUrl('') }}>
                ← Back
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
