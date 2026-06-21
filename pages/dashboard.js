import { useState, useEffect } from 'react'
import Link from 'next/link'
import Head from 'next/head'
import { useRouter } from 'next/router'
import { supabase } from '../lib/supabase'
import { useAuth } from './_app'

const GOOGLE_FORM = 'https://docs.google.com/forms/d/e/1FAIpQLSfRHyC7A3nteravGbpNqWtk7kroOkY2hrMGVM9_6T-cO7RumA/viewform?usp=dialog'

const PLAN_LIMITS = { free: 3, starter: 10, pro: 50, unlimited: 999999 }
const PLAN_LABELS = { free: 'Free', starter: 'Starter', pro: 'Pro', unlimited: 'Unlimited' }
const PLAN_PRICES = { free: 0, starter: 29, pro: 49, unlimited: 99 }
const ADMIN_EMAIL = 'bundepunemmanuel@gmail.com'

export default function Dashboard() {
  const { user, loading: authLoading } = useAuth()
  const router = useRouter()

  const [profile, setProfile] = useState(null)
  const [activeLeads, setActiveLeads] = useState([])
  const [archivedLeads, setArchivedLeads] = useState([]) // deleted or replied
  const [plan, setPlan] = useState('free')
  const [leadsToday, setLeadsToday] = useState(0)
  const [loading, setLoading] = useState(true)
  const [expandedLead, setExpandedLead] = useState(null)
  const [timers, setTimers] = useState({})
  const [showArchive, setShowArchive] = useState(false)
  const [adminData, setAdminData] = useState(null)
  const [adminLoading, setAdminLoading] = useState(false)
  const isAdmin = user?.email === ADMIN_EMAIL

  useEffect(() => {
    if (!authLoading && !user) router.replace('/login')
  }, [user, authLoading, router])

  useEffect(() => {
    if (!user) return
    loadData()
    if (user.email === ADMIN_EMAIL) loadAdminData()
  }, [user])

  const loadAdminData = async () => {
    setAdminLoading(true)
    try {
      const { data: allPlans } = await supabase.from('user_plans').select('user_id, plan, updated_at')
      const { data: allProfiles } = await supabase.from('product_profiles').select('user_id, url, analysis, created_at')

      const planCounts = { free: 0, starter: 0, pro: 0, unlimited: 0 }
      ;(allPlans || []).forEach(p => { planCounts[p.plan] = (planCounts[p.plan] || 0) + 1 })

      // Users with no plan row default to free
      const totalUsers = allProfiles?.length || 0
      const plannedUsers = allPlans?.length || 0
      planCounts.free += Math.max(0, totalUsers - plannedUsers)

      const mrr = (planCounts.starter * PLAN_PRICES.starter) + (planCounts.pro * PLAN_PRICES.pro) + (planCounts.unlimited * PLAN_PRICES.unlimited)

      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      const { count: leadsLast24h } = await supabase
        .from('leads')
        .select('id', { count: 'exact', head: true })
        .gte('scanned_at', twentyFourHoursAgo)

      // Subreddit frequency across all users
      const subredditCounts = {}
      ;(allProfiles || []).forEach(p => {
        (p.analysis?.subreddits || []).forEach(s => {
          subredditCounts[s] = (subredditCounts[s] || 0) + 1
        })
      })
      const topSubreddits = Object.entries(subredditCounts).sort((a, b) => b[1] - a[1]).slice(0, 5)

      // Build user list with email lookup
      const userList = (allProfiles || []).map(p => {
        const planRow = (allPlans || []).find(pl => pl.user_id === p.user_id)
        return {
          user_id: p.user_id,
          url: p.url,
          name: p.analysis?.name || p.url,
          plan: planRow?.plan || 'free',
          created_at: p.created_at,
        }
      })

      setAdminData({
        totalUsers,
        planCounts,
        mrr,
        leadsLast24h: leadsLast24h || 0,
        topSubreddits,
        userList,
      })
    } catch (e) {
      console.log('[admin] load error:', e.message)
    } finally {
      setAdminLoading(false)
    }
  }

  const handleForceScan = async () => {
    setAdminLoading(true)
    try {
      const res = await fetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'force-scan', requesterEmail: user.email }),
      })
      const data = await res.json()
      alert(data.message || 'Scan triggered')
      await loadData()
      await loadAdminData()
    } catch (e) {
      alert('Force scan failed: ' + e.message)
    } finally {
      setAdminLoading(false)
    }
  }

  const handleSetPlan = async (targetUserId, newPlan) => {
    try {
      const res = await fetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-plan', requesterEmail: user.email, targetUserId, newPlan }),
      })
      const data = await res.json()
      if (data.error) { alert(data.error); return }
      await loadAdminData()
    } catch (e) {
      alert('Set plan failed: ' + e.message)
    }
  }

  // Live timers for active leads
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

      const { data: planData } = await supabase
        .from('user_plans')
        .select('plan')
        .eq('user_id', user.id)
        .single()
      setPlan(planData?.plan || 'free')

      // Active leads — not deleted, not replied
      const { data: active } = await supabase
        .from('leads')
        .select('*')
        .eq('user_id', user.id)
        .eq('deleted', false)
        .eq('replied', false)
        .order('score', { ascending: false })
      setActiveLeads(active || [])

      // Archived leads — deleted or replied (still visible, separate section)
      const { data: archived } = await supabase
        .from('leads')
        .select('*')
        .eq('user_id', user.id)
        .or('deleted.eq.true,replied.eq.true')
        .order('scanned_at', { ascending: false })
      setArchivedLeads(archived || [])

      // Count leads created in last 24h — for quota display (independent of deleted status)
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      const { count } = await supabase
        .from('leads')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .gte('scanned_at', twentyFourHoursAgo)
      setLeadsToday(count || 0)
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
    setActiveLeads(prev => prev.filter(l => l.id !== leadId))
    const { error } = await supabase.from('leads').update({ deleted: true }).eq('id', leadId)
    if (error) {
      console.log('[dashboard] delete error:', error.message)
      await loadData() // revert optimistic update if it actually failed
      return
    }
    await loadData()
  }

  const handleMarkReplied = async (leadId) => {
    setActiveLeads(prev => prev.filter(l => l.id !== leadId))
    const { error } = await supabase.from('leads').update({ replied: true }).eq('id', leadId)
    if (error) {
      console.log('[dashboard] mark replied error:', error.message)
      await loadData()
      return
    }
    await loadData()
  }

  const formatTimer = mins => {
    if (mins <= 0) return 'Expired'
    const h = Math.floor(mins / 60)
    const m = Math.floor(mins % 60)
    return h > 0 ? `${h}h ${m}m` : `${m}m`
  }

  const timerColor = mins => mins <= 0 ? '#999' : mins <= 30 ? '#c0584a' : mins <= 120 ? '#d4903a' : '#5a8a5a'
  const urgencyLabel = mins => mins <= 0 ? '⚫ Expired' : mins <= 30 ? '🔴 Critical' : mins <= 120 ? '🟡 Active' : '🟢 Fresh'

  const avgScore = activeLeads.length ? (activeLeads.reduce((s, l) => s + l.score, 0) / activeLeads.length).toFixed(1) : '—'
  const limit = PLAN_LIMITS[plan] ?? 3
  const quotaUsed = Math.min(leadsToday, limit)
  const quotaReached = leadsToday >= limit

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

        {/* Product bar — no manual re-scan button, cron handles it */}
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

        {/* Stats */}
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
            <div className="dash-stat-value">{quotaUsed}/{limit === 999999 ? '∞' : limit}</div>
            <div className="dash-stat-label">Today's quota</div>
          </div>
          <div className="dash-stat">
            <div className="dash-stat-value dash-plan-badge">{PLAN_LABELS[plan]}</div>
            <div className="dash-stat-label">Current plan</div>
          </div>
        </div>

        {quotaReached && plan !== 'unlimited' && (
          <div className="dash-quota-banner">
            You've used today's {PLAN_LABELS[plan]} quota ({limit} leads). New leads resume in the next 24-hour window.{' '}
            <a href={GOOGLE_FORM} target="_blank" rel="noopener noreferrer">Upgrade for more →</a>
          </div>
        )}

        {/* Active Leads */}
        <div className="dash-leads">
          <div className="dash-leads-header">
            <h2 className="dash-leads-title">
              {activeLeads.length > 0 ? `${activeLeads.length} active ${activeLeads.length === 1 ? 'lead' : 'leads'}` : 'No active leads'}
            </h2>
            <p className="dash-leads-sub">
              {activeLeads.length > 0
                ? 'Sorted by intent score. New leads arrive automatically every 30 minutes.'
                : 'Kairo scans automatically every 30 minutes. Check back shortly.'}
            </p>
          </div>

          {activeLeads.length === 0 && (
            <div className="dash-no-leads">
              <div style={{ fontSize: '2rem', marginBottom: 12 }}>🔍</div>
              <p>No active leads right now. Kairo is scanning your subreddits every 30 minutes in the background — new leads will appear here automatically.</p>
            </div>
          )}

          {activeLeads.map((lead, i) => {
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
                    <p className="reply-gate-sub">Upgrade to Pro to unlock AI-drafted replies written for this exact lead.</p>
                    <a href={GOOGLE_FORM} target="_blank" rel="noopener noreferrer" className="reply-gate-btn">Upgrade to unlock replies →</a>
                    <p className="reply-gate-note">Launching August 13th · Plans from $29/month</p>
                  </div>
                )}

                <div className="dash-lead-actions">
                  <button className="dash-btn-primary" onClick={() => setExpandedLead(isOpen ? null : lead.id)}>
                    {isOpen ? 'Hide' : '✍️ View Draft Reply'}
                  </button>
                  <a href={lead.url} target="_blank" rel="noopener noreferrer" className="dash-btn-secondary">Open in Reddit ↗</a>
                  <button className="dash-btn-replied" onClick={() => handleMarkReplied(lead.id)} title="Mark as replied">✓ Replied</button>
                  <button className="dash-btn-delete" onClick={() => handleDelete(lead.id)} title="Remove from view">✕</button>
                </div>
              </div>
            )
          })}
        </div>

        {/* Archive toggle */}
        {archivedLeads.length > 0 && (
          <div className="dash-archive-section">
            <button className="dash-archive-toggle" onClick={() => setShowArchive(!showArchive)}>
              {showArchive ? '▲ Hide' : '▼ Show'} archived leads ({archivedLeads.length})
            </button>
            {showArchive && (
              <div className="dash-archive-list">
                {archivedLeads.map(lead => (
                  <div key={lead.id} className="dash-archive-card">
                    <div className="dash-archive-meta">
                      <span className="dash-archive-status">{lead.replied ? '✓ Replied' : '✕ Removed'}</span>
                      <span className="dash-lead-sub">r/{lead.subreddit}</span>
                    </div>
                    <p className="dash-archive-title">{lead.title}</p>
                    <a href={lead.url} target="_blank" rel="noopener noreferrer" className="dash-archive-link">Open in Reddit ↗</a>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Admin Panel — only visible to admin email */}
        {isAdmin && (
          <div className="dash-admin-section">
            <h2 className="dash-admin-title">⚙️ Admin Panel</h2>

            {adminLoading && !adminData && <p className="dash-admin-loading">Loading admin data...</p>}

            {adminData && (
              <>
                <div className="dash-admin-stats">
                  <div className="dash-admin-stat">
                    <div className="dash-admin-stat-value">{adminData.totalUsers}</div>
                    <div className="dash-admin-stat-label">Total users</div>
                  </div>
                  <div className="dash-admin-stat">
                    <div className="dash-admin-stat-value">${adminData.mrr}</div>
                    <div className="dash-admin-stat-label">MRR (projected)</div>
                  </div>
                  <div className="dash-admin-stat">
                    <div className="dash-admin-stat-value">{adminData.leadsLast24h}</div>
                    <div className="dash-admin-stat-label">Leads (24h)</div>
                  </div>
                  <div className="dash-admin-stat">
                    <div className="dash-admin-stat-value">{adminData.planCounts.free}/{adminData.planCounts.starter}/{adminData.planCounts.pro}/{adminData.planCounts.unlimited}</div>
                    <div className="dash-admin-stat-label">Free/Starter/Pro/Unlim</div>
                  </div>
                </div>

                <p className="dash-admin-note">MRR is projected from manually-assigned plans — billing isn't live yet (Chunk 5).</p>

                <button className="dash-admin-btn" onClick={handleForceScan} disabled={adminLoading}>
                  {adminLoading ? 'Running...' : '⚡ Force scan now (all users)'}
                </button>

                <h3 className="dash-admin-subtitle">Top subreddits across all users</h3>
                <div className="dash-admin-subreddit-list">
                  {adminData.topSubreddits.map(([sub, count]) => (
                    <span key={sub} className="dash-admin-subreddit-chip">r/{sub} ({count})</span>
                  ))}
                </div>

                <h3 className="dash-admin-subtitle">All users</h3>
                <div className="dash-admin-user-table">
                  {adminData.userList.map(u => (
                    <div key={u.user_id} className="dash-admin-user-row">
                      <div className="dash-admin-user-info">
                        <span className="dash-admin-user-name">{u.name}</span>
                        <span className="dash-admin-user-meta">{u.url}</span>
                      </div>
                      <select
                        className="dash-admin-plan-select"
                        value={u.plan}
                        onChange={e => handleSetPlan(u.user_id, e.target.value)}
                      >
                        <option value="free">Free</option>
                        <option value="starter">Starter</option>
                        <option value="pro">Pro</option>
                        <option value="unlimited">Unlimited</option>
                      </select>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
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
        <Link href="/settings" className="dash-nav-settings">Settings</Link>
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
