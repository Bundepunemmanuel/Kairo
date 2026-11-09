import { useState, useEffect } from 'react'
import Link from 'next/link'
import Head from 'next/head'
import { useRouter } from 'next/router'
import { supabase } from '../lib/supabase'
import { useAuth } from './_app'
import { isOwnerDevice, setOwnerDevice } from '../lib/analytics'

const PLAN_LABELS = { free: 'Free', starter: 'Starter', pro: 'Pro', unlimited: 'Unlimited' }
const ADMIN_EMAIL = 'bundepunemmanuel@gmail.com'

// Split out of pages/admin.js into its own route so opening Analytics
// doesn't make the main admin page long — the admin page now just links
// here instead of expanding an inline section. Same data, same handlers,
// same look; only the location changed.
export default function AdminAnalytics() {
  const { user, session, loading: authLoading } = useAuth()
  const router = useRouter()

  const [plan] = useState('free')
  const [analyticsData, setAnalyticsData] = useState(null)
  const [analyticsLoading, setAnalyticsLoading] = useState(false)
  const [analyticsHoursBack, setAnalyticsHoursBack] = useState(168)
  const [analyticsIncludeOwner, setAnalyticsIncludeOwner] = useState(false)
  const [thisDeviceIsOwner, setThisDeviceIsOwner] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [acquisitionData, setAcquisitionData] = useState(null)
  const [abandonmentData, setAbandonmentData] = useState(null)

  useEffect(() => { setThisDeviceIsOwner(isOwnerDevice()) }, [])

  useEffect(() => {
    if (!authLoading && !user) { router.replace('/login'); return }
    if (!authLoading && user && user.email !== ADMIN_EMAIL) { router.replace('/dashboard'); return }
  }, [user, authLoading, router])

  useEffect(() => {
    if (!user || user.email !== ADMIN_EMAIL) return
    loadAnalytics()
    loadAcquisition()
    loadAbandonment()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  const loadAcquisition = async (hoursBack = analyticsHoursBack, includeOwner = analyticsIncludeOwner) => {
    try {
      const res = await fetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'get-acquisition-data', accessToken: session?.access_token, hoursBack, includeOwner }),
      })
      const data = await res.json()
      if (data.error) { console.log('[admin-analytics] acquisition load error:', data.error); return }
      setAcquisitionData(data.acquisition || [])
    } catch (e) {
      console.log('[admin-analytics] acquisition load error:', e.message)
    }
  }

  const loadAbandonment = async (hoursBack = analyticsHoursBack, includeOwner = analyticsIncludeOwner) => {
    try {
      const res = await fetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'get-abandonment-data', accessToken: session?.access_token, hoursBack, includeOwner }),
      })
      const data = await res.json()
      if (data.error) { console.log('[admin-analytics] abandonment load error:', data.error); return }
      setAbandonmentData(data)
    } catch (e) {
      console.log('[admin-analytics] abandonment load error:', e.message)
    }
  }

  const handleExportJson = async () => {
    setExporting(true)
    try {
      const res = await fetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'export-analytics-json', accessToken: session?.access_token, hoursBack: analyticsHoursBack, includeOwner: analyticsIncludeOwner }),
      })
      const data = await res.json()
      if (data.error) { alert(data.error); return }
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `kairo-analytics-export-${new Date().toISOString().slice(0, 10)}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (e) {
      alert('Export failed: ' + e.message)
    } finally {
      setExporting(false)
    }
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.push('/')
  }

  const loadAnalytics = async (hoursBack = analyticsHoursBack, includeOwner = analyticsIncludeOwner) => {
    setAnalyticsLoading(true)
    try {
      const res = await fetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'get-analytics-data', accessToken: session?.access_token, hoursBack, includeOwner }),
      })
      const data = await res.json()
      if (data.error) { console.log('[admin-analytics] load error:', data.error); return }
      setAnalyticsData(data)
    } catch (e) {
      console.log('[admin-analytics] load error:', e.message)
    } finally {
      setAnalyticsLoading(false)
    }
  }

  const handleAnalyticsHoursChange = hours => {
    setAnalyticsHoursBack(hours)
    loadAnalytics(hours, analyticsIncludeOwner)
    loadAcquisition(hours, analyticsIncludeOwner)
    loadAbandonment(hours, analyticsIncludeOwner)
  }

  const handleAnalyticsOwnerToggle = () => {
    const next = !analyticsIncludeOwner
    setAnalyticsIncludeOwner(next)
    loadAnalytics(analyticsHoursBack, next)
    loadAcquisition(analyticsHoursBack, next)
    loadAbandonment(analyticsHoursBack, next)
  }

  const handleToggleThisDeviceOwner = () => {
    const next = setOwnerDevice(!thisDeviceIsOwner)
    setThisDeviceIsOwner(next)
  }

  if (authLoading) {
    return <div className="dash-loading"><div className="dash-loading-inner"><p>Loading...</p></div></div>
  }
  if (user?.email !== ADMIN_EMAIL) return null

  return (
    <div className="dash-page">
      <Head><title>Analytics — Kairo Admin</title></Head>
      <AppNav user={user} plan={plan} onSignOut={handleSignOut} />

      <div className="admin-container">
        <Link href="/admin" className="admin-back-link">← Back to Admin</Link>

        <div className="admin-table-section" style={{ marginBottom: 0 }}>
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
              <button className="admin-export-btn" onClick={handleExportJson} disabled={exporting}>
                {exporting ? 'Exporting...' : '⬇ Export JSON'}
              </button>
            </div>
          </div>

          <Link href="/admin-visitors" className="admin-analytics-link-card" style={{ marginBottom: 16 }}>
            <span>👤 Visitor explorer — inspect individual visitors</span>
            <span className="admin-analytics-link-arrow">→</span>
          </Link>

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
              {/* 1. Four headline metrics — derived directly from the
                  existing funnel array (funnel steps are
                  page_view/hero_cta_clicked/scan_started/scan_completed/
                  notify_me_completed/monitoring_activated), not a new
                  backend computation. "Signups" maps to notify_me_completed,
                  the scan-first flow's own completion event. */}
              <div className="admin-headline-grid">
                <div className="admin-headline-tile">
                  <span className="admin-headline-label">Unique visitors</span>
                  <span className="admin-headline-value">{analyticsData.funnel[0]?.uniqueVisitors ?? '—'}</span>
                </div>
                <div className="admin-headline-tile">
                  <span className="admin-headline-label">Signups</span>
                  <span className="admin-headline-value">{analyticsData.funnel[4]?.uniqueVisitors ?? '—'}</span>
                </div>
                <div className="admin-headline-tile">
                  <span className="admin-headline-label">Scans completed</span>
                  <span className="admin-headline-value">{analyticsData.funnel[3]?.uniqueVisitors ?? '—'}</span>
                </div>
                <div className="admin-headline-tile">
                  <span className="admin-headline-label">Monitoring activated</span>
                  <span className="admin-headline-value">{analyticsData.funnel[5]?.uniqueVisitors ?? '—'}</span>
                </div>
              </div>

              {/* 2. One compact conversion funnel. */}
              <div className="admin-card" style={{ marginBottom: 16 }}>
                <h3 className="admin-card-title">Conversion funnel</h3>
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

              {/* 3. One compact drop-off section — combines what used to
                  be three separate cards (scan outcome branch, share
                  sub-funnel, abandonment) into one capped, ranked list.
                  Full detail (share funnel steps, per-URL zero-result
                  breakdown, confirmed-vs-inferred counts) still exists in
                  the underlying data; it's just not all displayed inline
                  here anymore — that's what "View details" is for. */}
              <div className="admin-card" style={{ marginBottom: 16 }}>
                <h3 className="admin-card-title">Where visitors drop off</h3>
                <div className="admin-dropoff-list">
                  {analyticsData.branchRate.scanCompleted > 0 && (
                    <div className="admin-dropoff-row">
                      <div className="admin-dropoff-info">
                        <span className="admin-dropoff-label">Zero-result scans</span>
                        <span className="admin-dropoff-meta">{analyticsData.branchRate.zeroResultsShown} of {analyticsData.branchRate.scanCompleted} completed scans ({analyticsData.branchRate.zeroResultsPct}%)</span>
                      </div>
                      <span className="admin-dropoff-tag">Investigate</span>
                    </div>
                  )}
                  {analyticsData.shareFunnel[0]?.uniqueVisitors > 0 && (
                    <div className="admin-dropoff-row">
                      <div className="admin-dropoff-info">
                        <span className="admin-dropoff-label">Share-link signups</span>
                        <span className="admin-dropoff-meta">{analyticsData.shareFunnel[analyticsData.shareFunnel.length - 1]?.uniqueVisitors ?? 0} of {analyticsData.shareFunnel[0]?.uniqueVisitors} viewers completed signup</span>
                      </div>
                      <span className="admin-dropoff-tag">Investigate</span>
                    </div>
                  )}
                  {(abandonmentData?.abandonment || []).slice(0, 3).map(a => (
                    <div key={a.milestone} className="admin-dropoff-row">
                      <div className="admin-dropoff-info">
                        <span className="admin-dropoff-label">{a.label}</span>
                        <span className="admin-dropoff-meta">
                          {a.affectedVisitors} visitors ({a.pctOfEligible}%){a.confirmedErrors > 0 ? ` · ${a.confirmedErrors} confirmed error${a.confirmedErrors === 1 ? '' : 's'}` : ''}
                        </span>
                      </div>
                      <span className="admin-dropoff-tag">{a.confirmedErrors > 0 ? 'Review' : 'Investigate'}</span>
                    </div>
                  ))}
                  {!analyticsData.branchRate.scanCompleted && !abandonmentData?.abandonment?.length && (
                    <p className="admin-card-empty">Not enough data in this window yet.</p>
                  )}
                </div>
              </div>

              {/* 4. One small traffic-source breakdown — capped to top 4,
                  "Direct / Unknown" used honestly wherever attribution
                  can't be established. */}
              <div className="admin-card" style={{ marginBottom: 20 }}>
                <h3 className="admin-card-title">Traffic sources</h3>
                {!acquisitionData?.length ? (
                  <p className="admin-card-empty">No attributable traffic in this window.</p>
                ) : (
                  <div className="admin-subreddit-chips">
                    {acquisitionData.slice(0, 4).map(a => (
                      <span key={a.source} className="dash-admin-subreddit-chip">{a.source} ({a.uniqueVisitors})</span>
                    ))}
                  </div>
                )}
              </div>

              {/* Data quality kept as a single quiet footer line, not a
                  card — still visible, no longer competing for attention
                  with the metrics that actually matter. */}
              {analyticsData.dataQuality && (
                <div className="admin-data-quality-note">
                  {analyticsData.dataQuality.totalEvents} events in window · {analyticsData.dataQuality.missingSessionIdPct}% missing session data
                  {analyticsData.dataQuality.possibleDuplicateGroups > 0 && ` · ${analyticsData.dataQuality.possibleDuplicateGroups} possible duplicate group${analyticsData.dataQuality.possibleDuplicateGroups === 1 ? '' : 's'}`}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function AppNav({ user, plan, onSignOut }) {
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
          <Link href="/dashboard" className="app-nav-tab">Dashboard</Link>
          <Link href="/archive" className="app-nav-tab">Archive</Link>
          <Link href="/settings" className="app-nav-tab">Settings</Link>
          <Link href="/billing" className="app-nav-tab">Billing</Link>
          {isAdmin && <Link href="/admin" className="app-nav-tab active">Admin</Link>}
        </div>
      </div>
    </nav>
  )
}

function KairoLogo({ size = 24 }) {
  return <img src="/logo.png" alt="Kairo" width={size} height={size} style={{ objectFit: 'contain' }} />
}
