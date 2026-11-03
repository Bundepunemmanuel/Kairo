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
  const { user, loading: authLoading } = useAuth()
  const router = useRouter()

  const [plan] = useState('free')
  const [analyticsData, setAnalyticsData] = useState(null)
  const [analyticsLoading, setAnalyticsLoading] = useState(false)
  const [analyticsHoursBack, setAnalyticsHoursBack] = useState(168)
  const [analyticsIncludeOwner, setAnalyticsIncludeOwner] = useState(false)
  const [thisDeviceIsOwner, setThisDeviceIsOwner] = useState(false)

  useEffect(() => { setThisDeviceIsOwner(isOwnerDevice()) }, [])

  useEffect(() => {
    if (!authLoading && !user) { router.replace('/login'); return }
    if (!authLoading && user && user.email !== ADMIN_EMAIL) { router.replace('/dashboard'); return }
  }, [user, authLoading, router])

  useEffect(() => {
    if (!user || user.email !== ADMIN_EMAIL) return
    loadAnalytics()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

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
        body: JSON.stringify({ action: 'get-analytics-data', requesterEmail: user.email, hoursBack, includeOwner }),
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
  }

  const handleAnalyticsOwnerToggle = () => {
    const next = !analyticsIncludeOwner
    setAnalyticsIncludeOwner(next)
    loadAnalytics(analyticsHoursBack, next)
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
            </div>
          </div>

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
