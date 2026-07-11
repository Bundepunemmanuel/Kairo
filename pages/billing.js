import { useState, useEffect } from 'react'
import Link from 'next/link'
import Head from 'next/head'
import { useRouter } from 'next/router'
import { supabase } from '../lib/supabase'
import { useAuth } from './_app'

const PLAN_LABELS = { free: 'Free', starter: 'Starter', pro: 'Pro', unlimited: 'Unlimited' }
const ADMIN_EMAIL = 'bundepunemmanuel@gmail.com'

const TIERS = [
  {
    id: 'starter',
    name: 'Starter',
    price: '$29',
    period: '/mo',
    blurb: 'For founders just starting to find their first customers.',
    features: ['10 scans / day', 'All subreddit signals', 'Draft replies', 'Email support'],
  },
  {
    id: 'pro',
    name: 'Pro',
    price: '$49',
    period: '/mo',
    blurb: 'For founders actively growing and replying daily.',
    features: ['50 scans / day', 'Priority scanning', 'Draft replies', 'Priority support'],
    highlight: true,
  },
  {
    id: 'unlimited',
    name: 'Unlimited',
    price: '$99',
    period: '/mo',
    blurb: 'For agencies and teams managing multiple products.',
    features: ['Unlimited scans', 'Priority scanning', 'Draft replies', 'Priority support'],
  },
]

export default function Billing() {
  const { user, loading: authLoading } = useAuth()
  const router = useRouter()

  const [plan, setPlan] = useState('free')
  const [loading, setLoading] = useState(true)
  const [requestedPlans, setRequestedPlans] = useState([]) // plan ids already requested
  const [submitting, setSubmitting] = useState(null) // plan id currently submitting

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

      const { data: existingRequests } = await supabase
        .from('upgrade_requests')
        .select('requested_plan')
        .eq('user_id', user.id)
      setRequestedPlans((existingRequests || []).map(r => r.requested_plan))
    } catch (e) {
      console.log('[billing] load error:', e.message)
    } finally {
      setLoading(false)
    }
  }

  const handleUpgradeClick = async (tierId) => {
    setSubmitting(tierId)
    try {
      const { error } = await supabase.from('upgrade_requests').insert({
        user_id: user.id,
        requested_plan: tierId,
      })
      if (error) throw error
      setRequestedPlans(prev => [...prev, tierId])
    } catch (e) {
      console.log('[billing] upgrade request error:', e.message)
    } finally {
      setSubmitting(null)
    }
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.push('/')
  }

  if (authLoading || loading) {
    return <div className="dash-loading">Loading...</div>
  }

  return (
    <>
      <Head>
        <title>Billing — Kairo</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,700;0,900;1,700&family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet" />
      </Head>

      <div className="dash-page">
        <AppNav user={user} plan={plan} active="billing" onSignOut={handleSignOut} />

        <div className="settings-container">
          <div className="billing-header">
            <h1 className="settings-page-title">Billing</h1>
            <p className="billing-sub">
              You're currently on the <strong>{PLAN_LABELS[plan] || 'Free'}</strong> plan.
              Paid plans aren't live yet — tap a plan below to be notified the moment they are.
            </p>
          </div>

          <div className="billing-tiers">
            {TIERS.map(tier => {
              const alreadyRequested = requestedPlans.includes(tier.id)
              return (
                <div key={tier.id} className={`billing-tier-card ${tier.highlight ? 'billing-tier-highlight' : ''}`}>
                  {tier.highlight && <div className="billing-tier-badge">Most popular</div>}
                  <h3 className="billing-tier-name">{tier.name}</h3>
                  <div className="billing-tier-price">
                    {tier.price}<span className="billing-tier-period">{tier.period}</span>
                  </div>
                  <p className="billing-tier-blurb">{tier.blurb}</p>
                  <ul className="billing-tier-features">
                    {tier.features.map(f => <li key={f}>{f}</li>)}
                  </ul>

                  {alreadyRequested ? (
                    <div className="billing-tier-confirmed">
                      ✓ Thanks — we'll email you the moment paid plans go live.
                    </div>
                  ) : (
                    <button
                      className="billing-tier-btn"
                      onClick={() => handleUpgradeClick(tier.id)}
                      disabled={submitting === tier.id}
                    >
                      {submitting === tier.id ? 'Saving...' : `Get ${tier.name} →`}
                    </button>
                  )}
                </div>
              )
            })}
          </div>

          <p className="billing-footnote">
            Have questions about pricing or need a plan sooner? Reach out anytime — we're happy to help.
          </p>
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
  return <img src="/logo.png" alt="Kairo" width={size} height={size} style={{ objectFit: 'contain' }} />
}
