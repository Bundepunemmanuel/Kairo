import { useState, useEffect } from 'react'
import Link from 'next/link'
import { supabase } from '../lib/supabase'
import { useAuth } from '../pages/_app'

export function KairoLogo({ size = 36 }) {
  return <img src="/logo.png" alt="Kairo" width={size} height={size} style={{ objectFit: 'contain' }} />
}

export default function Nav({ solid = false }) {
  const { user } = useAuth()
  const [scrolled, setScrolled] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20)
    window.addEventListener('scroll', onScroll)
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <>
      {/* Announcement */}
      <div className="announcement">
        <span>🔴 Try the live demo free</span>
        <span style={{ opacity: 0.4 }}>·</span>
        <span>Sign up free to scan automatically every day.</span>
      </div>

      <nav className={`nav${scrolled || solid ? ' scrolled' : ''}`}>
        <div className="nav-inner">
          <Link href="/" className="nav-logo">
            <KairoLogo size={34} />
            Kairo
          </Link>
          <div className="nav-links">
            <Link href="/#how-it-works" className="nav-link">How It Works</Link>
            <Link href="/guides/how-to-get-your-first-100-users" className="nav-link">Guides</Link>
            <Link href="/#pricing" className="nav-link">Pricing</Link>
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
            <Link href="/#how-it-works" onClick={() => setMenuOpen(false)}>How It Works</Link>
            <Link href="/guides/how-to-get-your-first-100-users" onClick={() => setMenuOpen(false)}>Guides</Link>
            <Link href="/#pricing" onClick={() => setMenuOpen(false)}>Pricing</Link>
            <a href="https://subscan-omega.vercel.app" target="_blank" rel="noopener noreferrer">SubScan</a>
            <Link href="/onboarding" className="mobile-menu-cta" onClick={() => setMenuOpen(false)}>Try Kairo Free →</Link>
          </div>
        )}
      </nav>
    </>
  )
}
