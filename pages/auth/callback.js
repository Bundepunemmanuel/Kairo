import { useEffect } from 'react'
import { useRouter } from 'next/router'
import { supabase } from '../../lib/supabase'

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
