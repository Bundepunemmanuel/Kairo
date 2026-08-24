import { useState } from 'react'
import { supabase } from '../lib/supabase'

// Blocks the entire dashboard for accounts created passwordlessly via the
// zero-results email capture on onboarding (see /api/capture-lead). Those
// accounts start with a random throwaway password nobody knows, including
// the user — this is the only way in, and it's mandatory, not skippable.
export default function PasswordGateModal({ onDone }) {
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const handleSubmit = async e => {
    e.preventDefault()
    setError('')

    if (!password || !confirmPassword) {
      setError('Please fill in both fields')
      return
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters')
      return
    }
    if (password !== confirmPassword) {
      setError('Passwords don\u2019t match')
      return
    }

    setSaving(true)
    try {
      const { error: updateErr } = await supabase.auth.updateUser({ password })
      if (updateErr) {
        setError(updateErr.message || 'Could not set your password. Please try again.')
        setSaving(false)
        return
      }

      const { data: { user } } = await supabase.auth.getUser()
      const { error: profileErr } = await supabase
        .from('product_profiles')
        .update({ password_set: true })
        .eq('user_id', user.id)

      if (profileErr) {
        console.log('[PasswordGateModal] profile flag update error:', profileErr.message)
        // Non-fatal for this session — password is set either way, so let
        // them through. Worst case the gate reappears once more next visit.
      }

      onDone()
    } catch (err) {
      console.log('[PasswordGateModal] error:', err.message)
      setError('Something went wrong. Please try again.')
      setSaving(false)
    }
  }

  return (
    <div className="pw-gate-overlay">
      <div className="pw-gate-card">
        <div className="pw-gate-icon">🔐</div>
        <h2 className="pw-gate-headline">Set a password to secure your account</h2>
        <p className="pw-gate-sub">
          You signed up without one. Add a password now so you can log in from any device.
        </p>

        <form className="pw-gate-form" onSubmit={handleSubmit}>
          <div className="pw-gate-field">
            <input
              type="password"
              className="pw-gate-input"
              placeholder="New password"
              value={password}
              onChange={e => { setPassword(e.target.value); setError('') }}
              autoFocus
            />
          </div>
          <div className="pw-gate-field">
            <input
              type="password"
              className="pw-gate-input"
              placeholder="Confirm password"
              value={confirmPassword}
              onChange={e => { setConfirmPassword(e.target.value); setError('') }}
            />
          </div>
          {error && <p className="pw-gate-error">{error}</p>}
          <button type="submit" className="pw-gate-submit" disabled={saving}>
            {saving ? 'Saving...' : 'Set password'}
          </button>
        </form>
      </div>
    </div>
  )
}
