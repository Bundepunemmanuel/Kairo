import { useState, useEffect } from 'react'
import Link from 'next/link'
import Head from 'next/head'
import { useRouter } from 'next/router'
import { supabase } from '../lib/supabase'
import { useAuth } from './_app'

const PLAN_LABELS = { free: 'Free', starter: 'Starter', pro: 'Pro', unlimited: 'Unlimited' }
const ADMIN_EMAIL = 'bundepunemmanuel@gmail.com'

export default function Archive() {
  const { user, loading: authLoading } = useAuth()
  const router = useRouter()

  const [plan, setPlan] = useState('free')
  const [repliedLeads, setRepliedLeads] = useState([])
  const [deletedLeads, setDeletedLeads] = useState([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('replied')

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
      const { data: planData } = await supabase
        .from('user_plans')
        .select('plan')
        .eq('user_id', user.id)
        .single()
      setPlan(planData?.plan || 'free')

      const { data: replied } = await supabase
        .from('leads')
        .select('*')
        .eq('user_id', user.id)
        .eq('replied', true)
        .order('scanned_at', { ascending: false })
      setRepliedLeads(replied || [])

      const { data: deleted } = await supabase
        .from('leads')
        .select('*')
        .eq('user_id', user.id)
        .eq('deleted', true)
        .eq('replied', false)
        .order('scanned_at', { ascending: false })
      setDeletedLeads(deleted || [])
    } catch (e) {
      console.log('[archive] load error:', e.message)
    } finally {
      setLoading(false)
    }
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.push('/')
  }

  const handleRestore = async (leadId) => {
    setRepliedLeads(prev => prev.filter(l => l.id !== leadId))
    setDeletedLeads(prev => prev.filter(l => l.id !== leadId))
    const { error } = await supabase.from('leads').update({ replied: false, deleted: false }).eq('id', leadId)
    if (error) { console.log('[archive] restore error:', error.message); await loadData() }
  }

  const formatDate = ts => {
    const d = new Date(ts)
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  }

  if (authLoading || loading) {
    return (
      <div className="dash-loading">
        <div className="dash-loading-inner"><p>Loading archive...</p></div>
      </div>
    )
  }

  const currentList = tab === 'replied' ? repliedLeads : deletedLeads

  return (
    <>
      <Head>
        <title>Archive — Kairo</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,700;0,900;1,700&family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet" />
      </Head>

      <div className="dash-page">
        <AppNav user={user} plan={plan} active="archive" onSignOut={handleSignOut} />

        <div className="archive-container">
          <h1 className="settings-page-title">Archive</h1>
          <p className="archive-sub">Leads you've replied to or removed. Restoring a lead moves it back to your active dashboard.</p>

          <div className="archive-tabs">
            <button className={tab === 'replied' ? 'archive-tab active' : 'archive-tab'} onClick={() => setTab('replied')}>
              ✓ Replied ({repliedLeads.length})
            </button>
            <button className={tab === 'deleted' ? 'archive-tab active' : 'archive-tab'} onClick={() => setTab('deleted')}>
              ✕ Deleted ({deletedLeads.length})
            </button>
          </div>

          {currentList.length === 0 ? (
            <div className="dash-no-leads">
              <p>{tab === 'replied' ? "You haven't marked any leads as replied yet." : "You haven't deleted any leads yet."}</p>
            </div>
          ) : (
            <div className="archive-list">
              {currentList.map(lead => (
                <div key={lead.id} className="archive-card">
                  <div className="archive-card-meta">
                    <span className="dash-lead-sub">r/{lead.subreddit}</span>
                    <span className="dash-lead-score">Score: {Number(lead.score).toFixed(1)}</span>
                    <span className="archive-card-date">{formatDate(lead.scanned_at)}</span>
                  </div>
                  <p className="archive-card-title">{lead.title}</p>
                  <div className="archive-card-actions">
                    <a href={lead.url} target="_blank" rel="noopener noreferrer" className="archive-card-link">Open in Reddit ↗</a>
                    <button className="archive-restore-btn" onClick={() => handleRestore(lead.id)}>↺ Restore to active</button>
                  </div>
                </div>
              ))}
            </div>
          )}
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
      <div className="app-nav-tabs">
        <Link href="/dashboard" className={active === 'dashboard' ? 'app-nav-tab active' : 'app-nav-tab'}>Dashboard</Link>
        <Link href="/archive" className={active === 'archive' ? 'app-nav-tab active' : 'app-nav-tab'}>Archive</Link>
        <Link href="/settings" className={active === 'settings' ? 'app-nav-tab active' : 'app-nav-tab'}>Settings</Link>
        <Link href="/billing" className={active === 'billing' ? 'app-nav-tab active' : 'app-nav-tab'}>Billing</Link>
        {isAdmin && <Link href="/admin" className={active === 'admin' ? 'app-nav-tab active' : 'app-nav-tab'}>Admin</Link>}
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
