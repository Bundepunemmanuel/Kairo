import { useState, useEffect } from 'react'
import Link from 'next/link'
import Head from 'next/head'
import { useRouter } from 'next/router'
import { supabase } from '../lib/supabase'
import { useAuth } from './_app'
import { isOwnerDevice, setOwnerDevice } from '../lib/analytics'

const PLAN_LABELS = { free: 'Free', starter: 'Starter', pro: 'Pro', unlimited: 'Unlimited' }
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
  const [seenPostsCleanupConfirm, setSeenPostsCleanupConfirm] = useState(false)
  const [seenPostsCleanupRunning, setSeenPostsCleanupRunning] = useState(false)
  // Expandable per-user leads list — cached per user_id so re-expanding a
  // row already viewed this session doesn't refetch.
  const [expandedUserId, setExpandedUserId] = useState(null)
  const [userLeadsById, setUserLeadsById] = useState({}) // { [user_id]: leads[] }
  const [loadingLeadsFor, setLoadingLeadsFor] = useState(null)

  // Admin X-lead watchlist (#4)
  const [watchlistData, setWatchlistData] = useState(null) // { items, isRunning, cancelRequested, pendingCount }
  const [watchlistPasteText, setWatchlistPasteText] = useState('')
  const [watchlistAdding, setWatchlistAdding] = useState(false)
  const [watchlistAddResult, setWatchlistAddResult] = useState(null) // { inserted, skipped }
  const [watchlistBusy, setWatchlistBusy] = useState(false) // run/stop in flight

  // Self-hosted analytics (#5, #6)
  const [analyticsData, setAnalyticsData] = useState(null)
  const [analyticsLoading, setAnalyticsLoading] = useState(false)
  const [analyticsHoursBack, setAnalyticsHoursBack] = useState(168)
  const [analyticsIncludeOwner, setAnalyticsIncludeOwner] = useState(false)

  // Whether THIS browser is currently flagged as the owner's own device.
  // Read from localStorage on mount (client-only, hence the effect rather
  // than reading it straight into useState's initializer).
  const [thisDeviceIsOwner, setThisDeviceIsOwner] = useState(false)
  useEffect(() => { setThisDeviceIsOwner(isOwnerDevice()) }, [])

  const handleToggleThisDeviceOwner = () => {
    const next = setOwnerDevice(!thisDeviceIsOwner)
    setThisDeviceIsOwner(next)
  }

  useEffect(() => {
    if (!authLoading && !user) { router.replace('/login'); return }
    if (!authLoading && user && user.email !== ADMIN_EMAIL) { router.replace('/dashboard'); return }
  }, [user, authLoading, router])

  useEffect(() => {
    if (!user || user.email !== ADMIN_EMAIL) return
    loadAdminData()
    loadWatchlist()
    loadAnalytics()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  // Poll while a batch is actively running so status/progress/new share
  // links show up without the admin needing to refresh the page.
  useEffect(() => {
    if (!watchlistData?.isRunning) return
    const interval = setInterval(loadWatchlist, 5000)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchlistData?.isRunning])

  const loadAdminData = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'get-admin-data', requesterEmail: user.email }),
      })
      const rawText = await res.text()
      let data
      try {
        data = JSON.parse(rawText)
      } catch {
        console.log('[admin] non-JSON response:', rawText.slice(0, 200))
        setAdminData(null)
        return
      }
      if (data.error) {
        console.log('[admin] load error:', data.error)
        setAdminData(null)
        return
      }
      setAdminData(data)
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
      const rawText = await res.text()
      let data
      try {
        data = JSON.parse(rawText)
      } catch {
        setScanProgress({ running: false, message: 'Scan failed: server returned an unexpected response.' })
        return
      }
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

  const toggleUserLeads = async (u) => {
    // Collapse if this row is already open
    if (expandedUserId === u.user_id) {
      setExpandedUserId(null)
      return
    }
    setExpandedUserId(u.user_id)

    // Already fetched this session — no need to hit the API again
    if (userLeadsById[u.user_id]) return

    setLoadingLeadsFor(u.user_id)
    try {
      const res = await fetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'get-user-leads', requesterEmail: user.email, targetUserId: u.user_id }),
      })
      const data = await res.json()
      setUserLeadsById(prev => ({ ...prev, [u.user_id]: data.leads || [] }))
    } catch (e) {
      console.log('[admin] get-user-leads failed:', e.message)
      setUserLeadsById(prev => ({ ...prev, [u.user_id]: [] }))
    } finally {
      setLoadingLeadsFor(null)
    }
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

  // No confirm modal, unlike plan changes — holding/releasing is cheap to
  // reverse either direction (just flips a flag, doesn't touch billing or
  // saved leads), so the extra click isn't buying much safety here.
  const handleToggleHold = async (u) => {
    try {
      const res = await fetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'set-hold',
          requesterEmail: user.email,
          targetUserId: u.user_id,
          held: !u.is_held,
        }),
      })
      const data = await res.json()
      if (data.error) { alert(data.error); return }
      await loadAdminData()
    } catch (e) {
      alert('Set hold failed: ' + e.message)
    }
  }

  const handleCleanup = async () => {
    if (!cleanupConfirm) { setCleanupConfirm(true); return }
    setCleanupRunning(true)
    try {
      const res = await fetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cleanup-old-leads', requesterEmail: user.email }),
      })
      const data = await res.json()
      if (data.error) { alert(data.error); return }
      await loadAdminData()
    } catch (e) {
      alert('Cleanup failed: ' + e.message)
    } finally {
      setCleanupRunning(false)
      setCleanupConfirm(false)
    }
  }

  const handleSeenPostsCleanup = async () => {
    if (!seenPostsCleanupConfirm) { setSeenPostsCleanupConfirm(true); return }
    setSeenPostsCleanupRunning(true)
    try {
      const res = await fetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cleanup-seen-posts', requesterEmail: user.email }),
      })
      const data = await res.json()
      if (data.error) { alert(data.error); return }
      await loadAdminData()
    } catch (e) {
      alert('Cleanup failed: ' + e.message)
    } finally {
      setSeenPostsCleanupRunning(false)
      setSeenPostsCleanupConfirm(false)
    }
  }

  // ─── Admin X-lead watchlist (#4) ─────────────────────────────────────
  const loadWatchlist = async () => {
    try {
      const res = await fetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'watchlist-list', requesterEmail: user.email }),
      })
      const data = await res.json()
      if (data.error) { console.log('[admin] watchlist load error:', data.error); return }
      setWatchlistData(data)
    } catch (e) {
      console.log('[admin] watchlist load error:', e.message)
    }
  }

  const handleWatchlistAdd = async () => {
    if (!watchlistPasteText.trim()) return
    setWatchlistAdding(true)
    setWatchlistAddResult(null)
    try {
      const res = await fetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'watchlist-add', requesterEmail: user.email, pairs: watchlistPasteText }),
      })
      const data = await res.json()
      if (data.error) { alert(data.error); return }
      setWatchlistAddResult(data)
      if (data.inserted > 0) setWatchlistPasteText('')
      await loadWatchlist()
    } catch (e) {
      alert('Add failed: ' + e.message)
    } finally {
      setWatchlistAdding(false)
    }
  }

  const handleWatchlistRun = async () => {
    setWatchlistBusy(true)
    try {
      const res = await fetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'watchlist-run', requesterEmail: user.email }),
      })
      const data = await res.json()
      if (data.error) { alert(data.error); return }
      await loadWatchlist()
    } catch (e) {
      alert('Run failed: ' + e.message)
    } finally {
      setWatchlistBusy(false)
    }
  }

  const handleWatchlistStop = async () => {
    setWatchlistBusy(true)
    try {
      const res = await fetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'watchlist-stop', requesterEmail: user.email }),
      })
      const data = await res.json()
      if (data.error) { alert(data.error); return }
      await loadWatchlist()
    } catch (e) {
      alert('Stop failed: ' + e.message)
    } finally {
      setWatchlistBusy(false)
    }
  }

  // ─── Self-hosted analytics (#5, #6) ──────────────────────────────────
  const loadAnalytics = async (hoursBack = analyticsHoursBack, includeOwner = analyticsIncludeOwner) => {
    setAnalyticsLoading(true)
    try {
      const res = await fetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'get-analytics-data', requesterEmail: user.email, hoursBack, includeOwner }),
      })
      const data = await res.json()
      if (data.error) { console.log('[admin] analytics load error:', data.error); return }
      setAnalyticsData(data)
    } catch (e) {
      console.log('[admin] analytics load error:', e.message)
    } finally {
      setAnalyticsLoading(false)
    }
  }

  const handleAnalyticsHoursChange = hours => {
    setAnalyticsHoursBack(hours)
    loadAnalytics(hours, analyticsIncludeOwner)
  }

  const handleAnalyticsOwnerToggle = () => {
    const next = !analyticsIncludeOwner
    setAnalyticsIncludeOwner(next)
    loadAnalytics(analyticsHoursBack, next)
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
    .filter(u => !search || u.name.toLowerCase().includes(search.toLowerCase()) || u.url.toLowerCase().includes(search.toLowerCase()) || (u.email || '').toLowerCase().includes(search.toLowerCase()))
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

  if (!adminData) {
    return (
      <div className="dash-page">
        <AppNav user={user} plan={plan} active="admin" onSignOut={handleSignOut} />
        <div className="admin-container">
          <p style={{ padding: '2rem 0' }}>
            Couldn't load admin data. Check that the SUPABASE_SERVICE_ROLE_KEY env var is set on Vercel and that /api/admin is working.
          </p>
          <button className="admin-force-btn" onClick={loadAdminData}>Retry</button>
        </div>
      </div>
    )
  }

  return (
    <>
      <Head>
        <title>Admin — Kairo</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,700;0,900;1,700&family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet" />
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
              <p className="admin-card-sub">No activity in 7+ days · sorted by real risk, not just silence</p>
              {adminData.churnRisk.length === 0 ? (
                <p className="admin-card-empty">No users at risk right now.</p>
              ) : (
                <div className="admin-churn-list">
                  {adminData.churnRisk.slice(0, 5).map(u => (
                    <div key={u.user_id} className="admin-churn-row">
                      <div className="admin-churn-row-top">
                        <span className="admin-churn-name">{u.name}</span>
                        <span className={`admin-plan-badge admin-plan-${u.plan}`}>{u.plan}</span>
                      </div>
                      <div className="admin-churn-row-sub">
                        {u.daysInactive}d inactive · {u.pushEnabled ? '🔔 push on' : '🔕 push off'}
                      </div>
                    </div>
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

          {/* Upgrade requests — recorded interest, not real billing yet */}
          <div className="admin-card" style={{ marginBottom: 20 }}>
            <h3 className="admin-card-title">💳 Upgrade requests ({(adminData.upgradeRequests || []).length})</h3>
            <p className="admin-card-sub">Users who tapped "Get [plan]" on the Billing page before checkout was live</p>
            {(adminData.upgradeRequests || []).length === 0 ? (
              <p className="admin-card-empty">No upgrade requests yet.</p>
            ) : (
              <div className="admin-user-table">
                {adminData.upgradeRequests.map((r, i) => (
                  <div key={i} className="admin-user-row">
                    <div className="admin-user-info">
                      <span className="admin-user-name">{r.email || r.user_id}</span>
                      <span className="admin-user-meta">wants {r.requested_plan} · {formatRelative(r.created_at)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* User table */}
          <div className="admin-table-section">
            <div className="admin-table-header">
              <h2 className="admin-table-title">All users ({filteredUsers.length})</h2>
              <div className="admin-table-controls">
                <input
                  className="admin-search-input"
                  placeholder="Search by name, email, or URL..."
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
              {filteredUsers.map(u => {
                const isExpanded = expandedUserId === u.user_id
                const leads = userLeadsById[u.user_id]
                const isLoadingLeads = loadingLeadsFor === u.user_id

                return (
                  <div key={u.user_id} className="admin-user-row-wrap">
                    <div className="admin-user-row">
                      <button
                        type="button"
                        className="admin-user-expand-btn"
                        onClick={() => toggleUserLeads(u)}
                        aria-label={isExpanded ? 'Collapse leads' : 'Expand leads'}
                      >
                        {isExpanded ? '▾' : '▸'}
                      </button>
                      <div className="admin-user-info">
                        <span className="admin-user-name">
                          {u.name}
                          {u.is_held && <span className="admin-user-held-badge">Held</span>}
                        </span>
                        <span className="admin-user-email">{u.email || 'no email on file'}</span>
                        <span className="admin-user-meta">
                          {u.url} · signed up {formatDate(u.created_at)} · scanned {formatRelative(u.last_scan_at)}
                          {u.is_held && u.held_at && ` · held ${formatRelative(u.held_at)}`}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="admin-user-hold-btn"
                        onClick={() => handleToggleHold(u)}
                        title={u.is_held ? 'Resume scanning for this account' : 'Hold this account (stop scanning)'}
                      >
                        {u.is_held ? 'Release' : 'Hold'}
                      </button>
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

                    {isExpanded && (
                      <div className="admin-user-leads">
                        {isLoadingLeads ? (
                          <p className="admin-user-leads-empty">Loading leads...</p>
                        ) : !leads || leads.length === 0 ? (
                          <p className="admin-user-leads-empty">No leads found for this account yet.</p>
                        ) : (
                          leads.map(lead => (
                            <div key={lead.id} className="admin-user-lead-row">
                              <div className="admin-user-lead-top">
                                <span className="admin-user-lead-sub">r/{lead.subreddit}</span>
                                <span className="admin-user-lead-score">Score: {lead.score}</span>
                                {lead.deleted && <span className="admin-user-lead-tag">Deleted</span>}
                                {lead.replied && <span className="admin-user-lead-tag">Replied</span>}
                              </div>
                              <a href={lead.url} target="_blank" rel="noreferrer" className="admin-user-lead-title">
                                {lead.title}
                              </a>
                              {lead.specific_problem && (
                                <p className="admin-user-lead-problem">{lead.specific_problem}</p>
                              )}
                              <span className="admin-user-lead-time">{formatRelative(lead.scanned_at)}</span>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          {/* ─── Admin X-lead watchlist (#4) ─────────────────────────── */}
          <div className="admin-table-section" style={{ marginBottom: 20 }}>
            <div className="admin-table-header">
              <h2 className="admin-table-title">🎯 X-lead watchlist</h2>
              <div className="admin-table-controls">
                {watchlistData?.isRunning ? (
                  <button className="admin-watchlist-stop-btn" onClick={handleWatchlistStop} disabled={watchlistBusy}>
                    {watchlistBusy ? 'Stopping...' : '⏹ Stop batch'}
                  </button>
                ) : (
                  <button
                    className="admin-watchlist-run-btn"
                    onClick={handleWatchlistRun}
                    disabled={watchlistBusy || !(watchlistData?.pendingCount > 0)}
                  >
                    {watchlistBusy ? 'Starting...' : `▶ Run batch (${watchlistData?.pendingCount || 0} pending)`}
                  </button>
                )}
              </div>
            </div>

            <p className="admin-card-sub">
              One pair per line: <code>&lt;productUrl&gt; &lt;xPostUrl&gt;</code>, whitespace-separated.
              {watchlistData?.isRunning && <span className="admin-watchlist-running-badge"> ● Batch running</span>}
            </p>

            <textarea
              className="admin-watchlist-textarea"
              placeholder={'https://example.com https://x.com/someuser/status/123...\nhttps://another.com https://x.com/otheruser/status/456...'}
              value={watchlistPasteText}
              onChange={e => setWatchlistPasteText(e.target.value)}
              rows={4}
            />
            <div className="admin-watchlist-add-row">
              <button className="admin-watchlist-add-btn" onClick={handleWatchlistAdd} disabled={watchlistAdding || !watchlistPasteText.trim()}>
                {watchlistAdding ? 'Adding...' : 'Add to watchlist'}
              </button>
              {watchlistAddResult && (
                <span className="admin-watchlist-add-result">
                  Added {watchlistAddResult.inserted}
                  {watchlistAddResult.skipped?.length > 0 && `, skipped ${watchlistAddResult.skipped.length} (${watchlistAddResult.skipped.map(s => `line ${s.line}: ${s.reason}`).join('; ')})`}
                </span>
              )}
            </div>

            {!watchlistData?.items?.length ? (
              <p className="admin-card-empty">Nothing in the watchlist yet.</p>
            ) : (
              <div className="admin-watchlist-list">
                {watchlistData.items.map(item => (
                  <div key={item.id} className="admin-watchlist-row">
                    <div className="admin-watchlist-row-top">
                      <span className={`admin-watchlist-status admin-watchlist-status-${item.status}`}>{item.status}</span>
                      <a href={item.product_url} target="_blank" rel="noreferrer" className="admin-watchlist-link">{item.product_url}</a>
                      <a href={item.x_post_url} target="_blank" rel="noreferrer" className="admin-watchlist-link admin-watchlist-link-x">Reply ↗</a>
                    </div>
                    <div className="admin-watchlist-row-bottom">
                      {item.status === 'done' && item.share_token && (
                        <>
                          <button
                            className="admin-watchlist-copy-btn"
                            onClick={() => { navigator.clipboard?.writeText(`https://kairo-omega.vercel.app/share/${item.share_token}`) }}
                          >
                            📋 Copy share link
                          </button>
                          <span className="admin-watchlist-meta">{item.lead_count} leads · top score {item.top_score}</span>
                          <span className="admin-watchlist-meta">{item.viewCount} view{item.viewCount === 1 ? '' : 's'}{item.lastViewedAt ? ` · last viewed ${formatRelative(item.lastViewedAt)}` : ''}</span>
                        </>
                      )}
                      {item.status === 'error' && <span className="admin-watchlist-error">{item.error_message}</span>}
                      <span className="admin-watchlist-meta">{formatRelative(item.created_at)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ─── Self-hosted analytics (#5, #6) ──────────────────────── */}
          <div className="admin-table-section" style={{ marginBottom: 20 }}>
            <div className="admin-table-header">
              <h2 className="admin-table-title">📈 Analytics</h2>
              <div className="admin-table-controls">
                <select className="admin-sort-select" value={analyticsHoursBack} onChange={e => handleAnalyticsHoursChange(Number(e.target.value))}>
                  <option value={24}>Last 24h</option>
                  <option value={168}>Last 7 days</option>
                  <option value={720}>Last 30 days</option>
                </select>
                <label className="admin-analytics-owner-toggle">
                  <input type="checkbox" checked={analyticsIncludeOwner} onChange={handleAnalyticsOwnerToggle} />
                  Include owner activity
                </label>
              </div>
            </div>

            {/* One-tap toggle for THIS browser — same permanent flag
                ?kairo_owner=1 sets, just without needing to remember or
                paste that URL. Separate from "Include owner activity"
                above: this marks a device, that filters the report. */}
            <div className={`admin-owner-device-banner ${thisDeviceIsOwner ? 'is-owner' : ''}`}>
              <span>
                {thisDeviceIsOwner
                  ? '✓ This browser is marked as yours — its activity is excluded from analytics by default.'
                  : 'This browser is not marked as yours yet — your own visits here still count as real traffic.'}
              </span>
              <button className="admin-owner-device-btn" onClick={handleToggleThisDeviceOwner}>
                {thisDeviceIsOwner ? 'Unmark this browser' : 'Mark this browser as mine'}
              </button>
            </div>

            {analyticsLoading && !analyticsData ? (
              <p className="admin-card-empty">Loading analytics...</p>
            ) : !analyticsData ? (
              <p className="admin-card-empty">No analytics data yet.</p>
            ) : (
              <>
                <div className="admin-cards-row">
                  <div className="admin-card">
                    <h3 className="admin-card-title">Main funnel</h3>
                    <div className="admin-funnel">
                      {analyticsData.funnel.map(f => (
                        <div key={f.step} className="admin-funnel-row">
                          <span className="admin-funnel-step">{f.step}</span>
                          <div className="admin-funnel-bar-track">
                            <div
                              className="admin-funnel-bar-fill"
                              style={{ width: `${analyticsData.funnel[0].uniqueVisitors ? Math.max(2, (f.uniqueVisitors / analyticsData.funnel[0].uniqueVisitors) * 100) : 0}%` }}
                            />
                          </div>
                          <span className="admin-funnel-count">{f.uniqueVisitors}</span>
                          {f.dropOffPct > 0 && <span className="admin-funnel-dropoff">−{f.dropOffPct}%</span>}
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="admin-card">
                    <h3 className="admin-card-title">Scan outcome branch</h3>
                    <p className="admin-card-sub">Zero-results is a fork after scan_completed, not a funnel drop-off.</p>
                    <div className="admin-stat-big">{analyticsData.branchRate.zeroResultsPct}%</div>
                    <p className="admin-card-sub">{analyticsData.branchRate.zeroResultsShown} of {analyticsData.branchRate.scanCompleted} completed scans found nothing qualified</p>
                  </div>
                </div>

                <div className="admin-cards-row">
                  <div className="admin-card">
                    <h3 className="admin-card-title">Share-link sub-funnel</h3>
                    <div className="admin-funnel">
                      {analyticsData.shareFunnel.map(f => (
                        <div key={f.step} className="admin-funnel-row">
                          <span className="admin-funnel-step">{f.step}</span>
                          <div className="admin-funnel-bar-track">
                            <div
                              className="admin-funnel-bar-fill"
                              style={{ width: `${analyticsData.shareFunnel[0].uniqueVisitors ? Math.max(2, (f.uniqueVisitors / analyticsData.shareFunnel[0].uniqueVisitors) * 100) : 0}%` }}
                            />
                          </div>
                          <span className="admin-funnel-count">{f.uniqueVisitors}</span>
                          {f.dropOffPct > 0 && <span className="admin-funnel-dropoff">−{f.dropOffPct}%</span>}
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="admin-card">
                    <h3 className="admin-card-title">Device breakdown</h3>
                    <div className="admin-subreddit-chips">
                      {Object.entries(analyticsData.deviceBreakdown).map(([device, count]) => (
                        <span key={device} className="dash-admin-subreddit-chip">{device} ({count})</span>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="admin-card" style={{ marginBottom: 20 }}>
                  <h3 className="admin-card-title">Product URLs with zero results</h3>
                  {!analyticsData.topZeroResultUrls.length ? (
                    <p className="admin-card-empty">No zero-result scans in this window.</p>
                  ) : (
                    <div className="admin-user-table">
                      {analyticsData.topZeroResultUrls.map((z, i) => (
                        <div key={i} className="admin-user-row">
                          <div className="admin-user-info">
                            <span className="admin-user-name">{z.url}</span>
                            <span className="admin-user-meta">{z.count} zero-result scan{z.count === 1 ? '' : 's'}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="admin-card" style={{ marginBottom: 20 }}>
                  <h3 className="admin-card-title">Other events</h3>
                  <div className="admin-subreddit-chips">
                    {analyticsData.otherEvents.map(e => (
                      <span key={e.eventType} className="dash-admin-subreddit-chip">{e.eventType} ({e.count}, {e.uniqueVisitors} visitors)</span>
                    ))}
                  </div>
                </div>

                <div className="admin-card">
                  <h3 className="admin-card-title">Recent visitor journeys</h3>
                  <p className="admin-card-sub">Actual event sequences, most recently active first.</p>
                  <div className="admin-watchlist-list">
                    {analyticsData.recentJourneys.map(j => (
                      <div key={j.visitorId} className="admin-watchlist-row">
                        <div className="admin-watchlist-row-top">
                          <span className="admin-journey-visitor">{j.visitorId.slice(0, 8)}… · {j.deviceType}</span>
                        </div>
                        <div className="admin-journey-events">
                          {j.events.map((ev, i) => (
                            <span key={i} className="admin-journey-event">
                              {ev.eventType}{i < j.events.length - 1 ? ' → ' : ''}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Cleanup tool */}
          <div className="admin-cleanup-section">
            <h3 className="admin-card-title">🧹 Database cleanup</h3>
            <p className="admin-card-sub">{adminData.oldArchivedCount} archived leads (replied/deleted) are older than 90 days.</p>
            <button className="admin-cleanup-btn" onClick={handleCleanup} disabled={cleanupRunning || adminData.oldArchivedCount === 0}>
              {cleanupRunning ? 'Cleaning...' : cleanupConfirm ? 'Click again to confirm permanent deletion' : `Delete ${adminData.oldArchivedCount} old leads`}
            </button>
          </div>

          <div className="admin-cleanup-section">
            <h3 className="admin-card-title">🧹 Seen posts cleanup</h3>
            <p className="admin-card-sub">{adminData.oldSeenPostsCount} scored-post records (dedup tracking) are older than 30 days — Reddit's feed won't resurface anything this old, so they're safe to delete.</p>
            <button className="admin-cleanup-btn" onClick={handleSeenPostsCleanup} disabled={seenPostsCleanupRunning || adminData.oldSeenPostsCount === 0}>
              {seenPostsCleanupRunning ? 'Cleaning...' : seenPostsCleanupConfirm ? 'Click again to confirm permanent deletion' : `Delete ${adminData.oldSeenPostsCount} old records`}
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
      <div className="app-nav-top">
        <Link href="/dashboard" className="app-nav-logo">
          <KairoLogo size={22} />
          <span>Kairo</span>
        </Link>
        <div className="app-nav-right">
          <span className="app-nav-plan-badge">{PLAN_LABELS[plan] || 'Free'}</span>
          <button className="app-nav-signout" onClick={onSignOut}>Sign out</button>
        </div>
      </div>
      <div className="app-nav-tabs-wrap">
        <div className="app-nav-tabs">
          <Link href="/dashboard" className={active === 'dashboard' ? 'app-nav-tab active' : 'app-nav-tab'}>Dashboard</Link>
          <Link href="/archive" className={active === 'archive' ? 'app-nav-tab active' : 'app-nav-tab'}>Archive</Link>
          <Link href="/settings" className={active === 'settings' ? 'app-nav-tab active' : 'app-nav-tab'}>Settings</Link>
          <Link href="/billing" className={active === 'billing' ? 'app-nav-tab active' : 'app-nav-tab'}>Billing</Link>
          {isAdmin && <Link href="/admin" className={active === 'admin' ? 'app-nav-tab active' : 'app-nav-tab'}>Admin</Link>}
        </div>
      </div>
    </nav>
  )
}

function KairoLogo({ size = 24 }) {
  return <img src="/logo.png" alt="Kairo" width={size} height={size} style={{ objectFit: 'contain' }} />
}
