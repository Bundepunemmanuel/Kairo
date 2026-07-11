import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import Head from 'next/head'
import { supabase } from '../lib/supabase'
import { useAuth } from './_app'

const STATS = [
  { value: '2 min', label: 'To your first lead' },
  { value: '847', label: 'Posts scanned daily' },
  { value: '9.2', label: 'Avg intent score' },
  { value: '23m', label: 'Avg lead window' },
]

const STEPS = [
  { n: '01', title: 'Paste your site URL', desc: 'Drop your landing page URL. Kairo reads your product, understands your customer, and maps the subreddits where they hang out.' },
  { n: '02', title: 'Kairo hunts', desc: 'Our engine scans Reddit every 15 minutes. Every post is scored for buying intent, pain signals, and competitor frustration.' },
  { n: '03', title: 'You see real leads', desc: 'Active or passive demand — each lead is labeled, scored, and comes with a decay timer so you know exactly how long you have.' },
  { n: '04', title: 'Reply with confidence', desc: 'Kairo drafts the reply for you. Value-first, human-sounding, calibrated to the signal type. One click opens the Reddit thread.' },
]

const OUTCOMES = [
  { icon: '⏱', title: 'Hours back every week', desc: 'Manual Reddit searching takes 2–3 hours daily. Kairo does it in the background while you build.' },
  { icon: '📈', title: 'Your first $1,000 MRR', desc: 'One well-timed reply in the right thread can be worth hundreds in MRR. Kairo finds those threads before they go cold.' },
  { icon: '🌍', title: 'Distribution on autopilot', desc: 'Wake up to customers already found. Your product gets seen by people actively looking for it — every single day.' },
]

const PRICING = [
  {
    name: 'Starter', price: '$29', period: '/month',
    desc: 'For founders just getting traction',
    features: ['10 leads per day', '3 subreddits monitored', 'Active & passive demand labels', 'Decay timers', 'Karma Builder'],
    highlight: false,
  },
  {
    name: 'Pro', price: '$49', period: '/month',
    desc: 'For founders ready to scale',
    features: ['50 leads per day', '10 subreddits monitored', 'Everything in Starter', 'AI draft replies', 'Email alerts for critical leads'],
    highlight: true,
  },
  {
    name: 'Unlimited', price: '$99', period: '/month',
    desc: 'For founders going all in',
    features: ['Unlimited leads', 'Unlimited subreddits', 'Everything in Pro', 'Competitor tracking', 'Priority support'],
    highlight: false,
  },
]

export default function Home() {
  const { user } = useAuth()
  const [scrolled, setScrolled] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const sectionsRef = useRef([])

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20)
    window.addEventListener('scroll', onScroll)
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('visible') }),
      { threshold: 0.15 }
    )
    document.querySelectorAll('.section').forEach(el => observer.observe(el))
    return () => observer.disconnect()
  }, [])

  return (
    <>
      <Head>
        <title>Kairo — Find Customers Already Looking For You</title>
        <meta name="description" content="Kairo scans Reddit 24/7 and surfaces people actively looking for products like yours. Stop searching manually. Start waking up to customers." />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      {/* Announcement */}
      <div className="announcement">
        <span>🔴 Try the live demo free</span>
        <span style={{ opacity: 0.4 }}>·</span>
        <span>Sign up free to scan automatically every day.</span>
      </div>

      {/* Nav */}
      <nav className={`nav${scrolled ? ' scrolled' : ''}`}>
        <div className="nav-inner">
          <Link href="/" className="nav-logo">
            <KairoLogo size={26} />
            Kairo
          </Link>
          <div className="nav-links">
            <a href="#how-it-works" className="nav-link">How It Works</a>
            <a href="#pricing" className="nav-link">Pricing</a>
            <a href="https://subscan-omega.vercel.app" target="_blank" rel="noopener noreferrer" className="nav-link">SubScan</a>
            {user ? (
              <>
                <Link href="/dashboard" className="nav-link">Dashboard</Link>
                <button
                  onClick={async () => { await supabase.auth.signOut() }}
                  className="nav-link"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
                >
                  Sign out
                </button>
              </>
            ) : (
              <>
                <Link href="/login" className="nav-link">Login</Link>
                <Link href="/signup" className="nav-cta">Sign up free</Link>
              </>
            )}
          </div>
          <button className="menu-toggle" onClick={() => setMenuOpen(!menuOpen)} aria-label="Menu">
            <span className="menu-bar" style={menuOpen ? { transform: 'rotate(45deg) translate(5px,5px)' } : {}} />
            <span className="menu-bar" style={menuOpen ? { opacity: 0 } : {}} />
            <span className="menu-bar" style={menuOpen ? { transform: 'rotate(-45deg) translate(5px,-5px)' } : {}} />
          </button>
        </div>
        {menuOpen && (
          <div className="mobile-menu">
            <a href="#how-it-works" onClick={() => setMenuOpen(false)}>How It Works</a>
            <a href="#pricing" onClick={() => setMenuOpen(false)}>Pricing</a>
            <a href="https://subscan-omega.vercel.app" target="_blank" rel="noopener noreferrer">SubScan</a>
            <Link href="/onboarding" className="mobile-menu-cta" onClick={() => setMenuOpen(false)}>Try Kairo Free →</Link>
          </div>
        )}
      </nav>

      {/* Hero */}
      <div className="hero">
        <div className="hero-content">
          <div className="hero-badge">
            <span className="badge-dot" />
            Reddit is leaking customer intent right now
          </div>
          <h1 className="hero-headline">
            Stop searching.<br />
            <em>Start waking up</em><br />
            to customers.
          </h1>
          <p className="hero-sub">
            Your next 10 customers are on Reddit right now — frustrated, asking for recommendations, ready to buy. Kairo finds them, scores their intent, and writes your reply. Before your competitors even open their laptop.
          </p>
          <div className="hero-ctas">
            <Link href="/onboarding" className="btn-primary">Find My First Customer →</Link>
            <a href="#how-it-works" className="btn-ghost">See how it works</a>
          </div>
          <div className="hero-proof">
            <span className="proof-dot" />
            <span>No credit card · Results in 2 minutes · Free to start</span>
          </div>
        </div>

        {/* Phone */}
        <div className="hero-phone">
          <div className="phone-float">
            <div className="phone-frame">
              <div className="phone-notch" />
              <div className="phone-screen">
                <div>
                  <div className="dash-logo-row">
                    <span className="dash-logo">Kairo</span>
                    <span className="dash-pro">PRO</span>
                  </div>
                  <div className="dash-sub">Scanning 3 subreddits for buyers right now</div>
                  <div className="dash-live"><span className="live-dot" />847 posts scanned today</div>
                </div>
                <div className="dash-grid">
                  <div className="dash-card">
                    <span className="dash-card-label">Today's Leads</span>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 2 }}>
                      <span className="dash-card-big">4</span>
                      <span className="dash-card-small">/10</span>
                    </div>
                    <span className="dash-card-meta">6 remaining</span>
                  </div>
                  <div className="dash-card dash-card-critical">
                    <span className="dash-card-label"><span className="critical-dot" />Critical</span>
                    <span className="dash-card-big">1</span>
                    <span className="dash-card-meta">Expires in 23 min</span>
                  </div>
                  <div className="dash-card">
                    <span className="dash-card-label">Avg Intent Score</span>
                    <span className="dash-card-big-white">8.1</span>
                    <span className="dash-card-positive">+1.2 vs yesterday</span>
                  </div>
                  <div className="dash-card">
                    <span className="dash-card-label">Next Scan</span>
                    <span className="dash-card-big">1:08</span>
                    <span className="dash-card-meta">Every 15 min</span>
                  </div>
                </div>
                <div className="dash-lead">
                  <div className="dash-lead-top">
                    <span className="dash-lead-active">🔴 ACTIVE DEMAND</span>
                    <span className="dash-lead-score">9.2</span>
                  </div>
                  <p className="dash-lead-title">Looking for a tool to find Reddit leads automatically</p>
                  <div className="dash-lead-meta">
                    <span className="dash-lead-sub">r/SaaS</span>
                    <span className="dash-lead-timer">⏱ 47 min</span>
                  </div>
                  <div className="dash-lead-actions">
                    <button className="dash-btn-primary">View Draft Reply</button>
                    <button className="dash-btn-secondary">Open Reddit</button>
                  </div>
                </div>
                <div className="dash-footer">Kairo is scanning r/SaaS, r/indiehackers, r/entrepreneur</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="stats-bar">
        <div className="stats-grid">
          {STATS.map(s => (
            <div key={s.label} className="stat-item">
              <span className="stat-value">{s.value}</span>
              <span className="stat-label">{s.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* How It Works */}
      <div id="how-it-works" className="section">
        <div className="container">
          <div className="section-label">How It Works</div>
          <h2 className="section-headline">From URL to customer<br /><em>in under 2 minutes</em></h2>
          <div className="steps-grid">
            {STEPS.map(s => (
              <div key={s.n} className="step">
                <div className="step-number">{s.n}</div>
                <h3 className="step-title">{s.title}</h3>
                <p className="step-desc">{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Outcomes */}
      <div className="section section-soft">
        <div className="container">
          <div className="section-label">Why Kairo</div>
          <h2 className="section-headline">Distribution is the only<br /><em>problem that matters</em></h2>
          <p className="section-sub">Most founders can build. Almost none can distribute. Kairo is your unfair advantage.</p>
          <div className="outcomes-grid">
            {OUTCOMES.map(o => (
              <div key={o.title} className="outcome-card">
                <span className="outcome-icon">{o.icon}</span>
                <h3 className="outcome-title">{o.title}</h3>
                <p className="outcome-desc">{o.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Signals */}
      <div className="section">
        <div className="container">
          <div className="section-label">What Kairo Finds</div>
          <h2 className="section-headline">Two types of demand.<br /><em>Both mean revenue.</em></h2>
          <div className="signals-grid">
            <div className="signal-card">
              <div className="signal-badge signal-active">🔴 Active Demand</div>
              <h3 className="signal-title">They're shopping right now</h3>
              <p className="signal-desc">"What tool do you use for X?" · "Looking for software that..." · "Can anyone recommend..."</p>
              <div className="signal-tip"><strong>Kairo says:</strong> High intent. Short window. Reply fast, be direct.</div>
            </div>
            <div className="signal-card">
              <div className="signal-badge signal-passive">🟡 Passive Demand</div>
              <h3 className="signal-title">They don't know you exist yet</h3>
              <p className="signal-desc">"I hate how long X takes" · "There has to be a better way" · "Why is this so expensive?"</p>
              <div className="signal-tip"><strong>Kairo says:</strong> Lead with empathy. Add value first. Don't pitch immediately.</div>
            </div>
          </div>
        </div>
      </div>

      {/* Pricing */}
      <div id="pricing" className="section section-dark">
        <div className="container">
          <div className="section-label">Pricing</div>
          <h2 className="section-headline">One customer pays for<br /><em>a year of Kairo</em></h2>
          <p className="section-sub">Start free. Upgrade when you're finding leads worth paying for.</p>
          <div className="pricing-grid">
            {PRICING.map(p => (
              <div key={p.name} className={`pricing-card${p.highlight ? ' pricing-card-highlight' : ''}`}>
                {p.highlight && <div className="pricing-popular">Most Popular</div>}
                <div className="pricing-name">{p.name}</div>
                <div className="pricing-price">
                  <span className="pricing-amount">{p.price}</span>
                  <span className="pricing-period">{p.period}</span>
                </div>
                <p className="pricing-desc">{p.desc}</p>
                <ul className="pricing-features">
                  {p.features.map(f => (
                    <li key={f} className="pricing-feature">
                      <span className="pricing-check">✓</span>{f}
                    </li>
                  ))}
                </ul>
                <Link href="/onboarding" className={`pricing-cta${p.highlight ? ' pricing-cta-highlight' : ''}`}>
                  Start Finding Leads
                </Link>
              </div>
            ))}
          </div>
          <p className="pricing-note">Start free · No credit card required · Upgrade anytime</p>
        </div>
      </div>

      {/* Final CTA */}
      <div className="final-cta">
        <div className="final-cta-inner">
          <h2 className="final-cta-headline">Your next customer<br /><em>posted 2 hours ago.</em></h2>
          <p className="final-cta-sub">They're still waiting for a reply. Kairo already found them.</p>
          <Link href="/onboarding" className="btn-primary">Find My First Customer →</Link>
        </div>
      </div>

      {/* Footer */}
      <footer className="footer">
        <div className="footer-inner">
          <div>
            <div className="footer-logo"><KairoLogo size={20} />Kairo</div>
            <p className="footer-tagline">Customer acquisition for solo founders.</p>
          </div>
          <div className="footer-links">
            <a href="https://subscan-omega.vercel.app" target="_blank" rel="noopener noreferrer">SubScan</a>
            <a href="#pricing">Pricing</a>
            <a href="#how-it-works">How It Works</a>
          </div>
        </div>
        <div className="footer-bottom">© 2026 Kairo. Built for solo founders.</div>
      </footer>
    </>
  )
}

function KairoLogo({ size = 24 }) {
  return <img src="/logo.png" alt="Kairo" width={size} height={size} style={{ objectFit: 'contain' }} />
}
