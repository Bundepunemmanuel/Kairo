import { useState, useEffect } from 'react'
import Link from 'next/link'
import Head from 'next/head'
import { useRouter } from 'next/router'
import { supabase } from '../lib/supabase'
import { useAuth } from './_app'

const PLAN_LIMITS = { free: 3, starter: 10, pro: 50, unlimited: 999999 }
const PLAN_LABELS = { free: 'Free', starter: 'Starter', pro: 'Pro', unlimited: 'Unlimited' }
const ADMIN_EMAIL = 'bundepunemmanuel@gmail.com'

export default function Settings() {
  const { user, loading: authLoading } = useAuth()
  const router = useRouter()

  const [profile, setProfile] = useState(null)
  const [plan, setPlan] = useState('free')
  const [leadsToday, setLeadsToday] = useState(0)
  const [loading, setLoading] = useState(true)

  const [urlInput, setUrlInput] = useState('')
  const [urlSaved, setUrlSaved] = useState(false)

  const [deleteConfirm, setDeleteConfirm] = useState(false)

  useEffect(() => {
    if (!authLoading && !user) router.replace('/login')
  }, [user, authLoading, router])

  useEffect(() => {
    if (!user) return
    loadData()
  }, [user])

  const loadData = async () => {
    setLoading(true)
    try {
      const { data: profileData } = await supabase
        .from('product_profiles')
        .select('*')
        .eq('user_id', user.id)
        .single()
      setProfile(profileData)
      setUrlInput(profileData?.url || '')

      const { data: planData } = await supabase
        .from('user_plans')
        .select('plan')
        .eq('user_id', user.id)
        .single()
      setPlan(planData?.plan || 'free')

      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      const { count } = await supabase
        .from('leads')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .gte('scanned_at', twentyFourHoursAgo)
      setLeadsToday(count || 0)
    } catch (e) {
      console.log('[settings] load error:', e.message)
    } finally {
      setLoading(false)
    }
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.push('/')
  }

  const formatRelativeTime = ts => {
    if (!ts) return 'never'
    const mins = Math.floor((Date.now() - new Date(ts).getTime()) / 60000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins}m ago`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return `${hours}h ago`
    return `${Math.floor(hours / 24)}d ago`
  }

  const handleSaveUrl = async () => {
    if (!urlInput.trim()) return
    try {
      const clean = urlInput.startsWith('http') ? urlInput.trim() : `https://${urlInput.trim()}`
      // Save URL only — does NOT trigger a re-analysis or scan.
      // The next cron cycle will continue using the existing saved analysis
      // until the user explicitly re-scans from onboarding.
      await supabase.from('product_profiles').update({ url: clean }).eq('user_id', user.id)
      setUrlSaved(true)
      setTimeout(() => setUrlSaved(false), 2500)
    } catch (e) {
      console.log('[settings] save url error:', e.message)
    }
  }

  const handleDeleteAccount = async () => {
    if (!deleteConfirm) { setDeleteConfirm(true); return }
    try {
      // Cascade deletes handle leads, profiles, settings via FK constraints
      await supabase.auth.admin?.deleteUser?.(user.id) // may not be available client-side
      await supabase.auth.signOut()
      router.push('/')
    } catch (e) {
      // Fallback: sign out even if admin delete isn't available client-side
      alert('Please contact support to fully delete your account data. Signing you out now.')
      await supabase.auth.signOut()
      router.push('/')
    }
  }

  const limit = PLAN_LIMITS[plan] ?? 3
  const quotaUsed = Math.min(leadsToday, limit)

  if (authLoading || loading) {
    return (
      <div className="dash-loading">
        <div className="dash-loading-inner">
          <p>Loading settings...</p>
        </div>
      </div>
    )
  }

  return (
    <>
      <Head>
        <title>Settings — Kairo</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,700;0,900;1,700&family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet" />
      </Head>

      <div className="dash-page">
        <AppNav user={user} plan={plan} active="settings" onSignOut={handleSignOut} />

        <div className="settings-container">
          <h1 className="settings-page-title">Settings</h1>

          {/* Account */}
          <section className="settings-section">
            <h2 className="settings-section-title">Account</h2>
            <div className="settings-row">
              <span className="settings-label">Email</span>
              <span className="settings-value">{user?.email}</span>
            </div>
          </section>

          {/* Product Profile */}
          <section className="settings-section">
            <h2 className="settings-section-title">Product Profile</h2>
            <div className="settings-row">
              <span className="settings-label">Current product</span>
              <span className="settings-value">{profile?.analysis?.name || '—'}</span>
            </div>
            <div className="settings-row">
              <span className="settings-label">Description</span>
              <span className="settings-value settings-value-small">{profile?.analysis?.description || '—'}</span>
            </div>
            <div className="settings-row">
              <span className="settings-label">Last scanned</span>
              <span className="settings-value">{formatRelativeTime(profile?.last_scan_at)}</span>
            </div>
            <div className="settings-field">
              <label className="settings-field-label">Product URL</label>
              <input
                className="settings-input"
                value={urlInput}
                onChange={e => setUrlInput(e.target.value)}
                placeholder="yourproduct.com"
              />
              <p className="settings-hint">
                Saving a new URL does not trigger an instant re-scan. Kairo re-analyzes your product automatically every 7 days, and scans Reddit hourly using your current analysis.
              </p>
              <button className="settings-btn" onClick={handleSaveUrl}>
                {urlSaved ? '✓ Saved' : 'Save URL'}
              </button>
            </div>
          </section>

          {/* Subreddits */}
          <section className="settings-section">
            <h2 className="settings-section-title">Subreddits</h2>
            <p className="settings-hint">
              Kairo picks and updates these automatically based on your product analysis — refreshed every 7 days. Not manually editable.
            </p>
            <div className="settings-subreddit-tags">
              {(profile?.analysis?.subreddits || []).length > 0 ? (
                profile.analysis.subreddits.map(sub => (
                  <span key={sub} className="settings-subreddit-tag">r/{sub}</span>
                ))
              ) : (
                <span className="settings-value">—</span>
              )}
            </div>
          </section>

          {/* Plan & Quota */}
          <section className="settings-section">
            <h2 className="settings-section-title">Plan & Quota</h2>
            <div className="settings-row">
              <span className="settings-label">Current plan</span>
              <span className="settings-value settings-plan-pill">{PLAN_LABELS[plan]}</span>
            </div>
            <div className="settings-row">
              <span className="settings-label">Today's usage</span>
              <span className="settings-value">{quotaUsed} / {limit === 999999 ? '∞' : limit} leads</span>
            </div>
            {plan !== 'unlimited' && (
              <Link href="/billing" className="settings-btn settings-btn-upgrade">
                Upgrade plan →
              </Link>
            )}
          </section>

          {/* Notifications */}
          <section className="settings-section">
            <h2 className="settings-section-title">Notifications</h2>

            <div className="settings-notif-row settings-notif-disabled">
              <div>
                <span className="settings-label">Email alerts</span>
                <p className="settings-hint">Coming soon</p>
              </div>
              <span className="settings-coming-soon">Coming soon</span>
            </div>
          </section>

          {/* Danger zone */}
          <section className="settings-section settings-danger">
            <h2 className="settings-section-title">Danger Zone</h2>
            <button className="settings-btn-danger" onClick={handleDeleteAccount}>
              {deleteConfirm ? 'Click again to confirm — this cannot be undone' : 'Delete my account'}
            </button>
          </section>
        </div>
      </div>
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
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none">
      <rect x="10" y="38" width="45" height="10" rx="5" fill="#c0584a" opacity="0.6" />
      <rect x="20" y="52" width="45" height="10" rx="5" fill="#c0584a" opacity="0.8" />
      <rect x="15" y="66" width="45" height="10" rx="5" fill="#c0584a" opacity="0.7" />
      <circle cx="76" cy="57" r="18" fill="#c0584a" />
    </svg>
  )
}
