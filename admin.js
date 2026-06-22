import { useState, useEffect } from 'react'
import Link from 'next/link'
import Head from 'next/head'
import { useRouter } from 'next/router'
import { supabase } from '../lib/supabase'
import { useAuth } from './_app'

const PLAN_LABELS = { free: 'Free', starter: 'Starter', pro: 'Pro', unlimited: 'Unlimited' }
const PLAN_PRICES = { free: 0, starter: 29, pro: 49, unlimited: 99 }
const ADMIN_EMAIL = 'bundepunemmanuel@gmail.com'

export default function Admin() {
  const { user, loading: authLoading } = useAuth()
  const router = useRouter()

  const [plan, setPlan] = useState('free')
  const [loading, setLoading] = useState(true)
  const [adminData, setAdminData] = useState(null)
  const [scanProgress, setScanProgress] = useState(null) // { running, message }
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState('created_at')
  const [confirmPlanChange, setConfirmPlanChange] = useState(null) // { userId, name, currentPlan, newPlan }
  const [cleanupConfirm, setCleanupConfirm] = useState(false)
  const [cleanupRunning, setCleanupRunning] = useState(false)

  useEffect(() => {
    if (!authLoading && !user) { router.replace('/login'); return }
    if (!authLoading && user && user.email !== ADMIN_EMAIL) { router.replace('/dashboard'); return }
  }, [user, authLoading, router])

  useEffect(() => {
    if (!user || user.email !== ADMIN_EMAIL) return
    loadAdminData()
  }, [user])

  const loadAdminData = async () => {
    setLoading(true)
    try {
      const { data: allPlans } = await supabase.from('user_plans').select('user_id, plan, updated_at')
      const { data: allProfiles } = await supabase.from('product_profiles').select('user_id, url, analysis, created_at, last_scan_at')

      const planCounts = { free: 0, starter: 0, pro: 0, unlimited: 0 }
      ;(allPlans || []).forEach(p => { planCounts[p.plan] = (planCounts[p.plan] || 0) + 1 })

      const totalUsers = allProfiles?.length || 0
      const plannedUsers = allPlans?.length || 0
      planCounts.free += Math.max(0, totalUsers - plannedUsers)

      const mrr = (planCounts.starter * PLAN_PRICES.starter) + (planCounts.pro * PLAN_PRICES.pro) + (planCounts.unlimited * PLAN_PRICES.unlimited)

      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      const { count: leadsLast24h } = await supabase
        .from('leads')
        .select('id', { count: 'exact', head: true })
        .gte('scanned_at', twentyFourHoursAgo)

      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
      const { data: settingsRows } = await supabase.from('user_settings').select('user_id, last_active_at')
      const churnRisk = (allProfiles || []).filter(p => {
        const settings = (settingsRows || []).find(s => s.user_id === p.user_id)
        const lastActive = settings?.last_active_at || p.created_at
        return new Date(lastActive) < new Date(sevenDaysAgo)
      })

      const subredditCounts = {}
      ;(allProfiles || []).forEach(p => {
        (p.analysis?.subreddits || []).forEach(s => {
          subredditCounts[s] = (subredditCounts[s] || 0) + 1
        })
      })
      const topSubreddits = Object.entries(subredditCounts).sort((a, b) => b[1] - a[1]).slice(0, 8)

      const userList = (allProfiles || []).map(p => {
        const planRow = (allPlans || []).find(pl => pl.user_id === p.user_id)
        return {
          user_id: p.user_id,
          url: p.url,
          name: p.analysis?.name || p.url,
          plan: planRow?.plan || 'free',
          created_at: p.created_at,
          last_scan_at: p.last_scan_at,
        }
      })

      // Count old archived leads for cleanup tool
      const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
      const { count: oldArchivedCount } = await supabase
        .from('leads')
        .select('id', { count: 'exact', head: true })
        .or('deleted.eq.true,replied.eq.true')
        .lt('scanned_at', ninetyDaysAgo)

      setAdminData({
        totalUsers,
        planCounts,
        mrr,
        leadsLast24h: leadsLast24h || 0,
        topSubreddits,
        userList,
        churnRisk,
        oldArchivedCount: oldArchivedCount || 0,
        cronHealthy: true, // placeholder — could check Edge Function logs via API later
        lastCronRun: userList[0]?.last_scan_at || null,
      })
    } catch (e) {
      console.log('[admin] load error:', e.message)
    } finally {
      setLoading(false)
    }
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.push('/')
  }

  const handleForceScan = async () => {
    setScanProgress({ running: true, message: 'Starting scan across all users...' })
    try {
      const res = await fetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'force-scan', requesterEmail: user.email }),
      })
      const data = await res.json()
      setScanProgress({
        running: false,
        message: data.message || `Done: ${data.processed || 0} processed, ${data.skipped || 0} skipped of ${data.total || 0} total users`,
      })
      await loadAdminData()
    } catch (e) {
      setScanProgress({ running: false, message: 'Force scan failed: ' + e.message })
    }
  }

  const requestPlanChange = (u, newPlan) => {
    if (newPlan === u.plan) return
    setConfirmPlanChange({ userId: u.user_id, name: u.name, currentPlan: u.plan, newPlan })
  }

  const confirmPlanChangeAction = async () => {
    if (!confirmPlanChange) return
    try {
      const res = await fetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'set-plan',
          requesterEmail: user.email,
          targetUserId: confirmPlanChange.userId,
          newPlan: confirmPlanChange.newPlan,
        }),
      })
      const data = await res.json()
      if (data.error) { alert(data.error); setConfirmPlanChange(null); return }
      setConfirmPlanChange(null)
      await loadAdminData()
    } catch (e) {
      alert('Set plan failed: ' + e.message)
      setConfirmPlanChange(null)
    }
  }

  const handleCleanup = async () => {
    if (!cleanupConfirm) { setCleanupConfirm(true); return }
    setCleanupRunning(true)
    try {
      const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
      await supabase.from('leads').delete().or('deleted.eq.true,replied.eq.true').lt('scanned_at', ninetyDaysAgo)
      await loadAdminData()
    } catch (e) {
      alert('Cleanup failed: ' + e.message)
    } finally {
      setCleanupRunning(false)
      setCleanupConfirm(false)
    }
  }

  const formatDate = ts => ts ? new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'
  const formatRelative = ts => {
    if (!ts) return 'never'
    const mins = Math.floor((Date.now() - new Date(ts).getTime()) / 60000)
    if (mins < 60) return `${mins}m ago`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return `${hours}h ago`
    return `${Math.floor(hours / 24)}d ago`
  }

  const filteredUsers = (adminData?.userList || [])
    .filter(u => !search || u.name.toLowerCase().includes(search.toLowerCase()) || u.url.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => {
      if (sortBy === 'created_at') return new Date(b.created_at) - new Date(a.created_at)
      if (sortBy === 'plan') return a.plan.localeCompare(b.plan)
      if (sortBy === 'last_scan') return new Date(b.last_scan_at || 0) - new Date(a.last_scan_at || 0)
      return 0
    })

  if (authLoading || loading) {
    return <div className="dash-loading"><div className="dash-loading-inner"><p>Loading admin panel...</p></div></div>
  }

  if (user?.email !== ADMIN_EMAIL) return null

  return (
    <>
      <Head>
        <title>Admin — Kairo</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,700;0,900;1,700&family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet" />
      </Head>

      <div className="dash-page">
        <AppNav user={user} plan={plan} active="admin" onSignOut={handleSignOut} />

        <div className="admin-container">
          {/* Command bar */}
          <div className="admin-command-bar">
            <div className="admin-command-status">
              <span className={`admin-status-dot ${adminData.cronHealthy ? 'healthy' : 'unhealthy'}`} />
              <span>Cron {adminData.cronHealthy ? 'healthy' : 'issue detected'}</span>
              <span className="admin-command-divider">·</span>
              <span>Last run {formatRelative(adminData.lastCronRun)}</span>
            </div>
            <button className="admin-force-btn" onClick={handleForceScan} disabled={scanProgress?.running}>
              {scanProgress?.running ? '⏳ Scanning...' : '⚡ Force scan now'}
            </button>
          </div>
          {scanProgress && <p className={scanProgress.running ? 'admin-progress-msg running' : 'admin-progress-msg'}>{scanProgress.message}</p>}

          {/* MRR + stats */}
          <div className="admin-stats-row">
            <div className="admin-stat-card admin-mrr-card">
              <div className="admin-stat-label">MRR (projected)</div>
              <div className="admin-stat-big">${adminData.mrr}</div>
              <div className="admin-stat-sub">Starter ×{adminData.planCounts.starter} · Pro ×{adminData.planCounts.pro} · Unlimited ×{adminData.planCounts.unlimited}</div>
              <p className="admin-stat-note">Projected from manually-assigned plans — billing isn't live yet (Chunk 5)</p>
            </div>
            <div className="admin-stat-card">
              <div className="admin-stat-label">Total users</div>
              <div className="admin-stat-big">{adminData.totalUsers}</div>
            </div>
            <div className="admin-stat-card">
              <div className="admin-stat-label">Leads (24h)</div>
              <div className="admin-stat-big">{adminData.leadsLast24h}</div>
            </div>
          </div>

          {/* Churn risk + top subreddits as cards */}
          <div className="admin-cards-row">
            <div className="admin-card">
              <h3 className="admin-card-title">⚠️ Churn risk ({adminData.churnRisk.length})</h3>
              <p className="admin-card-sub">No activity in 7+ days</p>
              {adminData.churnRisk.length === 0 ? (
                <p className="admin-card-empty">No users at risk right now.</p>
              ) : (
                <div className="admin-churn-list">
                  {adminData.churnRisk.slice(0, 5).map(u => (
                    <div key={u.user_id} className="admin-churn-row">{u.analysis?.name || u.url}</div>
                  ))}
                </div>
              )}
            </div>
            <div className="admin-card">
              <h3 className="admin-card-title">📊 Top subreddits</h3>
              <p className="admin-card-sub">Across all users</p>
              <div className="admin-subreddit-chips">
                {adminData.topSubreddits.map(([sub, count]) => (
                  <span key={sub} className="dash-admin-subreddit-chip">r/{sub} ({count})</span>
                ))}
              </div>
            </div>
          </div>

          {/* User table */}
          <div className="admin-table-section">
            <div className="admin-table-header">
              <h2 className="admin-table-title">All users ({filteredUsers.length})</h2>
              <div className="admin-table-controls">
                <input
                  className="admin-search-input"
                  placeholder="Search by name or URL..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
                <select className="admin-sort-select" value={sortBy} onChange={e => setSortBy(e.target.value)}>
                  <option value="created_at">Newest signup</option>
                  <option value="plan">Plan</option>
                  <option value="last_scan">Last scanned</option>
                </select>
              </div>
            </div>

            <div className="admin-user-table">
              {filteredUsers.map(u => (
                <div key={u.user_id} className="admin-user-row">
                  <div className="admin-user-info">
                    <span className="admin-user-name">{u.name}</span>
                    <span className="admin-user-meta">{u.url} · signed up {formatDate(u.created_at)} · scanned {formatRelative(u.last_scan_at)}</span>
                  </div>
                  <select
                    className="dash-admin-plan-select"
                    value={u.plan}
                    onChange={e => requestPlanChange(u, e.target.value)}
                  >
                    <option value="free">Free</option>
                    <option value="starter">Starter</option>
                    <option value="pro">Pro</option>
                    <option value="unlimited">Unlimited</option>
                  </select>
                </div>
              ))}
            </div>
          </div>

          {/* Cleanup tool */}
          <div className="admin-cleanup-section">
            <h3 className="admin-card-title">🧹 Database cleanup</h3>
            <p className="admin-card-sub">{adminData.oldArchivedCount} archived leads (replied/deleted) are older than 90 days.</p>
            <button className="admin-cleanup-btn" onClick={handleCleanup} disabled={cleanupRunning || adminData.oldArchivedCount === 0}>
              {cleanupRunning ? 'Cleaning...' : cleanupConfirm ? 'Click again to confirm permanent deletion' : `Delete ${adminData.oldArchivedCount} old leads`}
            </button>
          </div>
        </div>
      </div>

      {confirmPlanChange && (
        <div className="dash-modal-overlay" onClick={() => setConfirmPlanChange(null)}>
          <div className="dash-modal admin-confirm-modal" onClick={e => e.stopPropagation()}>
            <h3>Change plan?</h3>
            <p>
              Change <strong>{confirmPlanChange.name}</strong> from{' '}
              <strong>{PLAN_LABELS[confirmPlanChange.currentPlan]}</strong> to{' '}
              <strong>{PLAN_LABELS[confirmPlanChange.newPlan]}</strong>?
            </p>
            <div className="admin-confirm-actions">
              <button className="admin-confirm-cancel" onClick={() => setConfirmPlanChange(null)}>Cancel</button>
              <button className="admin-confirm-ok" onClick={confirmPlanChangeAction}>Confirm</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

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
