import { useState } from 'react'
import Link from 'next/link'
import Head from 'next/head'
import { supabase } from '../lib/supabase'

export default function Signup() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async () => {
    if (!email.trim() || !email.includes('@')) {
      setError('Please enter a valid email address')
      return
    }
    setLoading(true)
    setError('')
    try {
      const { error: err } = await supabase.auth.signInWithOtp({
        email: email.trim().toLowerCase(),
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback`,
        },
      })
      if (err) throw err
      setSent(true)
    } catch (e) {
      setError(e.message || 'Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <Head>
        <title>Sign Up — Kairo</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,700;0,900;1,700&family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet" />
      </Head>

      <div className="auth-page">
        <nav className="auth-nav">
          <Link href="/" className="nav-logo" style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 8 }}>
            <KairoLogo size={22} />
            <span style={{ fontFamily: 'var(--font-display)', fontSize: '1.15rem', fontWeight: 700, color: 'var(--ink)' }}>Kairo</span>
          </Link>
        </nav>

        <div className="auth-content">
          {!sent ? (
            <div className="auth-card">
              <div className="auth-header">
                <div className="auth-badge">Free · No credit card</div>
                <h1 className="auth-headline">Find your first customer</h1>
                <p className="auth-sub">Enter your email to create your account. We'll send you a magic link — no password needed.</p>
              </div>

              <div className="auth-form">
                <div className="auth-field">
                  <label className="auth-label">Email address</label>
                  <input
                    className="auth-input"
                    type="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={e => { setEmail(e.target.value); setError('') }}
                    onKeyDown={e => e.key === 'Enter' && handleSubmit()}
                    autoFocus
                    autoComplete="email"
                  />
                </div>

                {error && <p className="auth-error">{error}</p>}

                <button
                  className="auth-btn"
                  onClick={handleSubmit}
                  disabled={loading}
                >
                  {loading ? 'Sending...' : 'Create Account →'}
                </button>

                <p className="auth-terms">
                  By signing up you agree to our terms of service.
                </p>
              </div>

              <p className="auth-switch">
                Already have an account?{' '}
                <Link href="/login" className="auth-switch-link">Sign in</Link>
              </p>
            </div>
          ) : (
            <div className="auth-card">
              <div className="auth-sent-icon">📬</div>
              <h2 className="auth-headline">Check your inbox</h2>
              <p className="auth-sub">
                We sent a magic link to <strong>{email}</strong>.<br />
                Click it to activate your account — no password needed.
              </p>
              <p className="auth-resend">
                Wrong email?{' '}
                <button className="auth-switch-link" onClick={() => { setSent(false); setEmail('') }}>
                  Try again
                </button>
              </p>
            </div>
          )}
        </div>
      </div>
    </>
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
