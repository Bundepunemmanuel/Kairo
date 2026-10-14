import { useState, useEffect, createContext, useContext } from 'react'
import { useRouter } from 'next/router'
import { supabase } from '../lib/supabase'
import posthog from 'posthog-js'
import '../styles/globals.css'

// Auth context — available to all pages
export const AuthContext = createContext({ user: null, loading: true })
export const useAuth = () => useContext(AuthContext)

// Analytics — kept here rather than a new lib/ file. Requires
// NEXT_PUBLIC_POSTHOG_KEY to be set in Vercel; silently does nothing
// without it (dev/preview environments, or before the key is added),
// rather than throwing.
let posthogReady = false

export function track(event, properties = {}) {
  if (typeof window === 'undefined' || !posthogReady) return
  posthog.capture(event, properties)
}

export default function App({ Component, pageProps }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const router = useRouter()

  useEffect(() => {
    if (typeof window !== 'undefined' && process.env.NEXT_PUBLIC_POSTHOG_KEY && !posthogReady) {
      posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY, {
        api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com',
        capture_pageview: true,
      })
      posthogReady = true

      // capture_pageview only fires on the initial load — Next's Pages
      // Router doesn't full-reload on navigation, so route changes need
      // to be captured manually or every page after the first is invisible.
      const handleRouteChange = () => posthog.capture('$pageview')
      router.events.on('routeChangeComplete', handleRouteChange)
      return () => router.events.off('routeChangeComplete', handleRouteChange)
    }
  }, [router.events])

  useEffect(() => {
    // Get initial session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null)
      setLoading(false)
    })

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
    })

    return () => subscription.unsubscribe()
  }, [])

  return (
    <AuthContext.Provider value={{ user, loading }}>
      <Component {...pageProps} />
    </AuthContext.Provider>
  )
}
