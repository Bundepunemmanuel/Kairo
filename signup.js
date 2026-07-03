import { useState } from 'react'
import Link from 'next/link'
import Head from 'next/head'
import { useRouter } from 'next/router'
import { supabase } from '../lib/supabase'

export default function Signup() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async () => {
    if (!email.trim() || !email.includes('@')) {
      setError('Please enter a valid email address')
      return
    }
    if (!password || password.length < 10) {
      setError('Password must be at least 10 characters')
      return
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match')
      return
    }
    setLoading(true)
    setError('')
    try {
      const { data, error: err } = await supabase.auth.signUp({
        email: email.trim().toLowerCase(),
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback`,
        },
      })
      if (err) throw err

      // If email confirmations are OFF in Supabase, signUp returns a session
      // immediately and the user is already logged in — skip straight to onboarding.
      if (data?.session) {
        router.push('/onboarding')
        return
      }

      // A user object with an empty identities array means this email is
      // already registered (Supabase's standard way of signalling this
      // without leaking account existence to attackers).
      if (data?.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
        setError('An account with this email already exists. Try signing in instead.')
        setLoading(false)
        return
      }

      // Otherwise, email confirmation is required — show the "check inbox" screen.
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
                <p className="auth-sub">Create your account with an email and password.</p>
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

                <div className="auth-field">
                  <label className="auth-label">Password</label>
                  <input
                    className="auth-input"
                    type="password"
                    placeholder="At least 10 characters"
                    value={password}
                    onChange={e => { setPassword(e.target.value); setError('') }}
                    onKeyDown={e => e.key === 'Enter' && handleSubmit()}
                    autoComplete="new-password"
                  />
                </div>

                <div className="auth-field">
                  <label className="auth-label">Confirm password</label>
                  <input
                    className="auth-input"
                    type="password"
                    placeholder="Re-enter your password"
                    value={confirmPassword}
                    onChange={e => { setConfirmPassword(e.target.value); setError('') }}
                    onKeyDown={e => e.key === 'Enter' && handleSubmit()}
                    autoComplete="new-password"
                  />
                </div>

                {error && <p className="auth-error">{error}</p>}

                <button
                  className="auth-btn"
                  onClick={handleSubmit}
                  disabled={loading}
                >
                  {loading ? 'Creating account...' : 'Create Account →'}
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
                We sent a confirmation link to <strong>{email}</strong>.<br />
                Click it to activate your account, then sign in with your password.
              </p>
              <p className="auth-resend">
                Wrong email?{' '}
                <button className="auth-switch-link" onClick={() => { setSent(false); setEmail(''); setPassword(''); setConfirmPassword('') }}>
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
