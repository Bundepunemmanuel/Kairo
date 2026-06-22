import { useState, useEffect } from 'react'
import Link from 'next/link'
import Head from 'next/head'
import { useRouter } from 'next/router'
import { supabase } from '../lib/supabase'
import { useAuth } from './_app'

const GOOGLE_FORM = 'https://docs.google.com/forms/d/e/1FAIpQLSfRHyC7A3nteravGbpNqWtk7kroOkY2hrMGVM9_6T-cO7RumA/viewform?usp=dialog'

const PLAN_LIMITS = { free: 3, starter: 10, pro: 50, unlimited: 999999 }
const PLAN_LABELS = { free: 'Free', starter: 'Starter', pro: 'Pro', unlimited: 'Unlimited' }
const ADMIN_EMAIL = 'bundepunemmanuel@gmail.com'

export default function Dashboard() {
  const { user, loading: authLoading } = useAuth()
  const router = useRouter()

  const [profile, setProfile] = useState(null)
  const [activeLeads, setActiveLeads] = useState([])
  const [plan, setPlan] = useState('free')
  const [leadsToday, setLeadsToday] = useState(0)
  const [loading, setLoading] = useState(true)
  const [timers, setTimers] = useState({})
  const [openMenuId, setOpenMenuId] = useState(null)
  const [replyModalLead, setReplyModalLead] = useState(null)
  const [lastSeenAt, setLastSeenAt] = useState(null)
  const [neverScanned, setNeverScanned] = useState(false)

  useEffect(() => {
    if (!authLoading && !user) router.replace('/login')
  }, [user, authLoading, router])

  useEffect(() => {
    if (!user) return
    loadData()
  }, [user])

  useEffect(() => {
    if (!activeLeads.length) return
    const compute = () => {
      const next = {}
      activeLeads.forEach(l => {
        const ageMinutes = (Date.now() - (l.created_at_post || Date.now())) / 60000
        const maxWindow = l.signal_type === 'active' ? 180 : 360
        next[l.id] = maxWindow - ageMinutes
      })
      return next
    }
    setTimers(compute())
    const t = setInterval(() => setTimers(compute()), 30000)
    return () => clearInterval(t)
  }, [activeLeads])

  const loadData = async () => {
    setLoading(true)
    try {
      const { data: profileData } = await supabase
        .from('product_profiles')
        .select('*')
        .eq('user_id', user.id)
        .single()
      setProfile(profileData)
      setNeverScanned(!profileData)

      const { data: planData } = await supabase
        .from('user_plans')
        .select('plan')
        .eq('user_id', user.id)
        .single()
      setPlan(planData?.plan || 'free')

      const { data: settingsData } = await supabase
        .from('user_settings')
        .select('last_seen_leads_at')
        .eq('user_id', user.id)
        .single()
      const prevSeenAt = settingsData?.last_seen_leads_at || null
      setLastSeenAt(prevSeenAt)

      const { data: active } = await supabase
        .from('leads')
        .select('*')
        .eq('user_id', user.id)
        .eq('deleted', false)
        .eq('replied', false)
        .order('score', { ascending: false })
      setActiveLeads(active || [])

      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      const { count } = await supabase
        .from('leads')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .gte('scanned_at', twentyFourHoursAgo)
      setLeadsToday(count || 0)

      // Update last_seen_leads_at to now, for next visit's "New" comparison
      await supabase.from('user_settings').upsert({
        user_id: user.id,
        last_seen_leads_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' })
    } catch (e) {
      console.log('[dashboard] load error:', e.message)
    } finally {
      setLoading(false)
    }
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.push('/')
  }

  const handleDelete = async (leadId) => {
    setOpenMenuId(null)
    setActiveLeads(prev => prev.filter(l => l.id !== leadId))
    const { error } = await supabase.from('leads').update({ deleted: true }).eq('id', leadId)
    if (error) { console.log('[dashboard] delete error:', error.message); await loadData() }
  }

  const handleMarkReplied = async (leadId) => {
    setOpenMenuId(null)
    setActiveLeads(prev => prev.filter(l => l.id !== leadId))
    const { error } = await supabase.from('leads').update({ replied: true }).eq('id', leadId)
    if (error) { console.log('[dashboard] mark replied error:', error.message); await loadData() }
  }

  const formatTimer = mins => {
    if (mins <= 0) return 'Expired'
    const h = Math.floor(mins / 60)
    const m = Math.floor(mins % 60)
    return h > 0 ? `${h}h ${m}m` : `${m}m`
  }

  const formatRelativeTime = timestamp => {
    if (!timestamp) return ''
    const mins = Math.floor((Date.now() - timestamp) / 60000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins}m ago`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return `${hours}h ago`
    return `${Math.floor(hours / 24)}d ago`
  }

  const timerColor = mins => mins <= 0 ? '#999' : mins <= 30 ? '#c0584a' : mins <= 120 ? '#d4903a' : '#5a8a5a'
  const urgencyLabel = mins => mins <= 0 ? 'Expired' : mins <= 30 ? 'Critical' : mins <= 120 ? 'Active' : 'Fresh'
  const urgencyClass = mins => mins <= 0 ? 'urgency-expired' : mins <= 30 ? 'urgency-critical' : mins <= 120 ? 'urgency-active' : 'urgency-fresh'

  const avgScore = activeLeads.length ? (activeLeads.reduce((s, l) => s + l.score, 0) / activeLeads.length).toFixed(1) : '—'
  const limit = PLAN_LIMITS[plan] ?? 3
  const quotaUsed = Math.min(leadsToday, limit)
  const quotaReached = leadsToday >= limit

  const newLeadsCount = lastSeenAt
    ? activeLeads.filter(l => new Date(l.scanned_at).getTime() > new Date(lastSeenAt).getTime()).length
    : 0

  const isLeadNew = lead => lastSeenAt && new Date(lead.scanned_at).getTime() > new Date(lastSeenAt).getTime()

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
        <AppNav user={user} plan={plan} active="dashboard" onSignOut={handleSignOut} />

        {neverScanned ? (
          <div className="dash-empty-profile">
            <div style={{ fontSize: '2rem', marginBottom: 16 }}>🎯</div>
            <h2>You haven't scanned a product yet</h2>
            <p>Paste your product URL to find your first Reddit lead.</p>
            <Link href="/onboarding" className="dash-scan-btn">Scan my product →</Link>
          </div>
        ) : (
          <>
            <div className="dash-product-bar">
              <div className="dash-product-info">
                <span className="dash-product-label">Scanning for</span>
                <span className="dash-product-name">{profile.analysis?.name || profile.url}</span>
                <span className="dash-product-desc">{profile.analysis?.description}</span>
              </div>
              <div className="dash-cron-badge">
                <span className="dash-cron-dot" />
                Auto-scanning every 30 min
              </div>
            </div>

            <div className="dash-stats">
              <div className="dash-stat">
                <div className="dash-stat-value">{activeLeads.length}</div>
                <div className="dash-stat-label">Active leads</div>
              </div>
              <div className="dash-stat">
                <div className="dash-stat-value">{avgScore}</div>
                <div className="dash-stat-label">Avg score</div>
              </div>
              <div className="dash-stat">
                <div className="dash-stat-value" style={quotaReached ? { color: '#c0584a' } : {}}>{quotaUsed}/{limit === 999999 ? '∞' : limit}</div>
                <div className="dash-stat-label">Today's quota</div>
              </div>
              <div className="dash-stat">
                <div className="dash-stat-value dash-plan-badge">{PLAN_LABELS[plan]}</div>
                <div className="dash-stat-label">Current plan</div>
              </div>
            </div>

            {quotaReached && plan !== 'unlimited' && (
              <div className="dash-quota-banner">
                Today's {PLAN_LABELS[plan]} quota reached. New leads resume in the next 24-hour window.{' '}
                <a href={GOOGLE_FORM} target="_blank" rel="noopener noreferrer">Upgrade for more →</a>
              </div>
            )}

            <div className="dash-leads">
              {newLeadsCount > 0 && (
                <div className="dash-new-banner">✨ {newLeadsCount} new lead{newLeadsCount > 1 ? 's' : ''} since you last checked</div>
              )}

              <div className="dash-leads-header">
                <h2 className="dash-leads-title">
                  {activeLeads.length > 0 ? `${activeLeads.length} active ${activeLeads.length === 1 ? 'lead' : 'leads'}` : 'No active leads'}
                </h2>
                <p className="dash-leads-sub">
                  {activeLeads.length > 0
                    ? 'Sorted by intent score. New leads arrive automatically every 30 minutes.'
                    : quotaReached
                      ? `You've hit today's ${PLAN_LABELS[plan]} quota — new leads resume in the next 24-hour window.`
                      : 'Kairo is scanning your subreddits every 30 minutes. Check back shortly for your first leads.'}
                </p>
              </div>

              {activeLeads.length === 0 && (
                <div className="dash-no-leads">
                  <div style={{ fontSize: '2rem', marginBottom: 12 }}>🔍</div>
                  <p>
                    {quotaReached
                      ? 'No more leads until your quota resets.'
                      : 'No active leads right now. New ones will appear here automatically as Kairo scans.'}
                  </p>
                </div>
              )}

              {activeLeads.map((lead, i) => {
                const mins = timers[lead.id] ?? 0
                const isMenuOpen = openMenuId === lead.id
                const isNew = isLeadNew(lead)

                return (
                  <div key={lead.id} className={`dash-lead-card ${urgencyClass(mins)}`}>
                    {isNew && <span className="dash-new-badge">NEW</span>}
                    <div className="dash-lead-top">
                      <div className="dash-lead-meta">
                        <span
                          className="dash-signal-badge"
                          style={lead.signal_type === 'active'
                            ? { background: 'rgba(192,88,74,0.1)', color: '#c0584a' }
                            : { background: 'rgba(180,140,80,0.1)', color: '#b48c50' }}
                        >
                          {lead.signal_type === 'active' ? '🔴 Active' : '🟡 Passive'}
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
                    {lead.body && <p className="dash-lead-body">{lead.body.slice(0, 200)}{lead.body.length > 200 ? '...' : ''}</p>}

                    <div className="dash-lead-reason">
                      <span>{lead.specific_problem || lead.reason}</span>
                    </div>

                    <div className="dash-lead-footer">
                      <span className="dash-lead-arrived">Arrived {formatRelativeTime(new Date(lead.scanned_at).getTime())}</span>

                      <div className="dash-lead-actions">
                        <button className="dash-btn-primary" onClick={() => setReplyModalLead(lead)}>✍️ View Draft Reply</button>
                        <a href={lead.url} target="_blank" rel="noopener noreferrer" className="dash-btn-secondary">Open in Reddit ↗</a>
                        <div className="dash-kebab-wrap">
                          <button className="dash-btn-kebab" onClick={() => setOpenMenuId(isMenuOpen ? null : lead.id)}>⋮</button>
                          {isMenuOpen && (
                            <div className="dash-kebab-menu">
                              <button onClick={() => handleMarkReplied(lead.id)}>✓ Mark as Replied</button>
                              <button onClick={() => handleDelete(lead.id)}>✕ Delete</button>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>

      {replyModalLead && (
        <div className="dash-modal-overlay" onClick={() => setReplyModalLead(null)}>
          <div className="dash-modal" onClick={e => e.stopPropagation()}>
            <button className="dash-modal-close" onClick={() => setReplyModalLead(null)}>✕</button>
            <div className="reply-gate-icon">✍️</div>
            <p className="reply-gate-headline">Your reply is ready</p>
            <p className="reply-gate-sub">Upgrade to Pro to unlock AI-drafted replies written for this exact lead.</p>
            <a href={GOOGLE_FORM} target="_blank" rel="noopener noreferrer" className="reply-gate-btn">Upgrade to unlock replies →</a>
            <p className="reply-gate-note">Launching August 13th · Plans from $29/month</p>
          </div>
        </div>
      )}
    </>
  )
}

// ─── Shared nav, inlined per page (no separate component file) ───────────
function AppNav({ user, plan, active, onSignOut }) {
  const isAdmin = user?.email === ADMIN_EMAIL
  return (
    <nav className="app-nav">
      <Link href="/dashboard" className="app-nav-logo">
        <KairoLogo size={22} />
        <span>Kairo</span>
      </Link>
      <div className="app-nav-tabs">
        <Link href="/dashboard" className={active === 'dashboard' ? 'app-nav-tab active' : 'app-nav-tab'}>Dashboard</Link>
        <Link href="/archive" className={active === 'archive' ? 'app-nav-tab active' : 'app-nav-tab'}>Archive</Link>
        <Link href="/settings" className={active === 'settings' ? 'app-nav-tab active' : 'app-nav-tab'}>Settings</Link>
        <Link href="/billing" className={active === 'billing' ? 'app-nav-tab active' : 'app-nav-tab'}>Billing</Link>
        {isAdmin && <Link href="/admin" className={active === 'admin' ? 'app-nav-tab active' : 'app-nav-tab'}>Admin</Link>}
      </div>
      <div className="app-nav-right">
        <span className="app-nav-plan-badge">{PLAN_LABELS[plan] || 'Free'}</span>
        <button className="app-nav-signout" onClick={onSignOut}>Sign out</button>
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
