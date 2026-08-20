import { useState, useEffect } from 'react'
import Link from 'next/link'
import { supabase } from '../lib/supabase'

// Derives onboarding progress from tables that already exist — nothing
// new is stored, so this can never drift out of sync with reality.
// Step 1 (account created) is implicit: if this component is rendering
// at all, the user is already signed in.
async function getOnboardingProgress(userId) {
  const [{ data: profile }, { data: push }, { data: lead }] = await Promise.all([
    supabase.from('product_profiles').select('id').eq('user_id', userId).limit(1).maybeSingle(),
    supabase.from('push_subscriptions').select('id').eq('user_id', userId).limit(1).maybeSingle(),
    supabase.from('leads').select('id').eq('user_id', userId).limit(1).maybeSingle(),
  ])

  if (lead) return { step: 4, percent: 100 }
  if (push) return { step: 3, percent: 75 }
  if (profile) return { step: 2, percent: 50 }
  return { step: 1, percent: 25 }
}

const STEPS = {
  1: { label: 'Account created', next: 'Confirm your subreddits', href: '/settings' },
  2: { label: 'Subreddits confirmed', next: 'Turn on notifications', href: '/settings' },
  3: { label: 'Notifications on', next: 'First scan in progress — check back soon', href: null },
}

export default function OnboardingProgress({ userId }) {
  const [progress, setProgress] = useState(null)

  useEffect(() => {
    if (!userId) return
    getOnboardingProgress(userId).then(setProgress).catch(() => setProgress(null))
  }, [userId])

  // Nothing to show once fully set up, or while we don't have data yet —
  // no loading skeleton needed, this isn't critical-path content.
  if (!progress || progress.step === 4) return null

  const current = STEPS[progress.step]

  return (
    <div className="onboarding-progress">
      <div className="onboarding-progress-bar-track">
        <div className="onboarding-progress-bar-fill" style={{ width: `${progress.percent}%` }} />
      </div>
      <div className="onboarding-progress-row">
        <span className="onboarding-progress-label">{current.label} — {progress.percent}% set up</span>
        {current.href ? (
          <Link href={current.href} className="onboarding-progress-cta">{current.next} →</Link>
        ) : (
          <span className="onboarding-progress-waiting">{current.next}</span>
        )}
      </div>
    </div>
  )
}
