import { useState, useEffect } from 'react'
import Link from 'next/link'
import Head from 'next/head'
import { useRouter } from 'next/router'
import { supabase } from '../lib/supabase'
import { useAuth } from './_app'

const PLAN_LABELS = { free: 'Free', starter: 'Starter', pro: 'Pro', unlimited: 'Unlimited' }
const ADMIN_EMAIL = 'bundepunemmanuel@gmail.com'

const STATUS_LABELS = {
  new: 'New visitor',
  returning: 'Returning visitor',
  engaged: 'Engaged visitor',
  signup_started: 'Signup started',
  signup_completed: 'Signup completed',
  first_scan_completed: 'First scan completed',
  zero_result_visitor: 'Zero-result visitor',
  monitoring_activated: 'Monitoring activated',
  inactive: 'Inactive',
}

export default function AdminVisitors() {
  const { user, session, loading: authLoading } = useAuth()
  const router = useRouter()

  const [plan] = useState('free')
  const [visitors, setVisitors] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [hoursBack, setHoursBack] = useState(168)
  const pageSize = 25

  const [selectedVisitorId, setSelectedVisitorId] = useState(null)
  const [profile, setProfile] = useState(null)
  const [profileLoading, setProfileLoading] = useState(false)

  useEffect(() => {
    if (!authLoading && !user) { router.replace('/login'); return }
    if (!authLoading && user && user.email !== ADMIN_EMAIL) { router.replace('/dashboard'); return }
  }, [user, authLoading, router])

  useEffect(() => {
    if (!user || user.email !== ADMIN_EMAIL) return
    loadVisitors()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, page, statusFilter, hoursBack])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.push('/')
  }

  const loadVisitors = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'get-visitor-list', accessToken: session?.access_token,
          hoursBack, search, statusFilter: statusFilter || null, page, pageSize,
        }),
      })
      const data = await res.json()
      if (data.error) { console.log('[admin-visitors] load error:', data.error); return }
      setVisitors(data.visitors || [])
      setTotal(data.total || 0)
    } catch (e) {
      console.log('[admin-visitors] load error:', e.message)
    } finally {
      setLoading(false)
    }
  }

  const handleSearchSubmit = () => { setPage(1); loadVisitors() }

  const openVisitor = async visitorId => {
    setSelectedVisitorId(visitorId)
    setProfileLoading(true)
    setProfile(null)
    try {
      const res = await fetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'get-visitor-profile', accessToken: session?.access_token, visitorId }),
      })
      const data = await res.json()
      if (data.error) { console.log('[admin-visitors] profile error:', data.error); return }
      setProfile(data)
    } catch (e) {
      console.log('[admin-visitors] profile error:', e.message)
    } finally {
      setProfileLoading(false)
    }
  }

  const formatRelative = ts => {
    if (!ts) return '—'
    const diffMs = Date.now() - new Date(ts).getTime()
    const mins = Math.floor(diffMs / 60000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    return `${Math.floor(hrs / 24)}d ago`
  }

  if (authLoading) {
    return <div className="dash-loading"><div className="dash-loading-inner"><p>Loading...</p></div></div>
  }
  if (user?.email !== ADMIN_EMAIL) return null

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className="dash-page">
      <Head><title>Visitors — Kairo Admin</title></Head>
      <AppNav user={user} plan={plan} onSignOut={handleSignOut} />

      <div className="admin-container">
        <Link href="/admin-analytics" className="admin-back-link">← Back to Analytics</Link>

        <div className="admin-table-section" style={{ marginBottom: 0 }}>
          <div className="admin-table-header">
            <h2 className="admin-table-title">👤 Visitor explorer</h2>
            <div className="admin-table-controls">
              <select className="admin-sort-select" value={hoursBack} onChange={e => { setPage(1); setHoursBack(Number(e.target.value)) }}>
                <option value={24}>Last 24h</option>
                <option value={168}>Last 7 days</option>
                <option value={720}>Last 30 days</option>
              </select>
            </div>
          </div>

          <div className="admin-watchlist-add-row" style={{ marginBottom: 14 }}>
            <input
              className="admin-search-input"
              placeholder="Search by visitor ID or email..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSearchSubmit()}
              style={{ flex: 1 }}
            />
            <select className="admin-sort-select" value={statusFilter} onChange={e => { setPage(1); setStatusFilter(e.target.value) }}>
              <option value="">All statuses</option>
              {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>

          {loading ? (
            <p className="admin-card-empty">Loading visitors...</p>
          ) : !visitors.length ? (
            <p className="admin-card-empty">No visitors match this filter.</p>
          ) : (
            <div className="admin-watchlist-list">
              {visitors.map(v => (
                <div key={v.visitorId} className="admin-watchlist-row" style={{ cursor: 'pointer' }} onClick={() => openVisitor(v.visitorId)}>
                  <div className="admin-watchlist-row-top">
                    <span className={`admin-watchlist-status admin-watchlist-status-${v.status === 'monitoring_activated' || v.status === 'first_scan_completed' ? 'done' : v.status === 'inactive' ? 'error' : 'pending'}`}>
                      {STATUS_LABELS[v.status] || v.status}
                    </span>
                    <span className="admin-watchlist-link">{v.email || `${v.visitorId.slice(0, 12)}...`}</span>
                  </div>
                  <div className="admin-watchlist-row-bottom">
                    <span className="admin-watchlist-meta">{v.deviceType}</span>
                    <span className="admin-watchlist-meta">{v.sessionCount} session{v.sessionCount === 1 ? '' : 's'}</span>
                    <span className="admin-watchlist-meta">{v.eventCount} events</span>
                    <span className="admin-watchlist-meta">last seen {formatRelative(v.lastVisit)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {totalPages > 1 && (
            <div className="admin-watchlist-add-row" style={{ marginTop: 14, justifyContent: 'center' }}>
              <button className="admin-watchlist-copy-btn" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>← Prev</button>
              <span className="admin-watchlist-meta">Page {page} of {totalPages} ({total} visitors)</span>
              <button className="admin-watchlist-copy-btn" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next →</button>
            </div>
          )}
        </div>

        {selectedVisitorId && (
          <div className="admin-table-section" style={{ marginTop: 20 }}>
            <div className="admin-table-header">
              <h2 className="admin-table-title">Visitor timeline</h2>
              <button className="admin-watchlist-copy-btn" onClick={() => { setSelectedVisitorId(null); setProfile(null) }}>✕ Close</button>
            </div>
            {profileLoading ? (
              <p className="admin-card-empty">Loading timeline...</p>
            ) : !profile ? (
              <p className="admin-card-empty">Could not load this visitor.</p>
            ) : (
              <>
                <p className="admin-card-sub">
                  {profile.email || profile.visitorId} · {profile.deviceType} · {profile.sessionCount} session{profile.sessionCount === 1 ? '' : 's'} · first seen {formatRelative(profile.firstVisit)}
                  {profile.utmSource && ` · utm_source=${profile.utmSource}`}
                  {profile.referrer && ` · referrer: ${profile.referrer}`}
                </p>
                <div className="admin-visitor-timeline">
                  {profile.timeline.map((ev, i) => (
                    <div key={i} className="admin-visitor-timeline-row">
                      <span className="admin-visitor-timeline-time">{new Date(ev.timestamp).toLocaleString()}</span>
                      <span className={`admin-visitor-timeline-label ${ev.outcome === 'failed' ? 'is-failed' : ev.outcome === 'confirmed' ? 'is-confirmed' : ''}`}>
                        {ev.label}
                      </span>
                      <span className="admin-watchlist-meta">{ev.page}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
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
