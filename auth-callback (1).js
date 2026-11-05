import { useEffect } from 'react'
import { useRouter } from 'next/router'
import { supabase } from '../../lib/supabase'
import { track } from '../_app'

export default function AuthCallback() {
  const router = useRouter()

  useEffect(() => {
    // Supabase handles the token from the URL automatically
    // We just need to check the session and redirect
    const handleCallback = async () => {
      const { data: { session }, error } = await supabase.auth.getSession()

      if (error || !session) {
        // Something went wrong — send back to login
        router.replace('/login')
        return
      }

      // This page is also where a returning user's magic-link login lands,
      // not just a fresh signup's email confirmation — so signup_completed
      // only fires when the account itself was created very recently.
      // created_at vs now, rather than "no product profile yet" (a
      // returning user who never finished onboarding would also have no
      // profile, and would wrongly count as a new signup otherwise).
      const accountAgeMs = Date.now() - new Date(session.user.created_at).getTime()
      if (accountAgeMs < 15 * 60 * 1000) {
        track('signup_completed', { method: 'email_confirmation' }, { accessToken: session.access_token })
      }

      // Check if user has a saved product profile
      const { data: profile } = await supabase
        .from('product_profiles')
        .select('id')
        .eq('user_id', session.user.id)
        .limit(1)
        .single()

      if (profile) {
        // Returning user with saved profile — go to dashboard
        router.replace('/dashboard')
      } else {
        // New user — go to onboarding to scan their product
        router.replace('/onboarding')
      }
    }

    handleCallback()
  }, [router])

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100vh',
      fontFamily: 'DM Sans, sans-serif',
      color: '#1a1208',
      background: '#f5f0eb',
    }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: '1.5rem', marginBottom: 12 }}>⏳</div>
        <p style={{ fontSize: '1rem', opacity: 0.7 }}>Signing you in...</p>
      </div>
    </div>
  )
}
