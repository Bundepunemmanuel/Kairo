import { useState, useEffect, createContext, useContext } from 'react'
import { useRouter } from 'next/router'
import { supabase } from '../lib/supabase'
import { track, markOwnerDeviceIfRequested } from '../lib/analytics'
import '../styles/globals.css'

// Auth context — available to all pages
export const AuthContext = createContext({ user: null, loading: true })
export const useAuth = () => useContext(AuthContext)

// Self-hosted analytics (replaces PostHog) — the actual implementation
// lives in lib/analytics.js; re-exported here so every existing call site
// across the app (`import { track } from './_app'` / `'../_app'`) keeps
// working unchanged.
export { track }

export default function App({ Component, pageProps }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const router = useRouter()

  useEffect(() => {
    // Mirrors what PostHog's capture_pageview did: a page_view on initial
    // load, then one more on every client-side route change (Next's Pages
    // Router doesn't full-reload, so route changes need this fired
    // manually or every page after the first is invisible to the funnel).
    // markOwnerDeviceIfRequested runs on the same two triggers so
    // ?kairo_owner=1 is caught whichever page it lands on, not just the
    // homepage.
    markOwnerDeviceIfRequested()
    track('page_view')

    const handleRouteChange = () => {
      markOwnerDeviceIfRequested()
      track('page_view')
    }
    router.events.on('routeChangeComplete', handleRouteChange)
    return () => router.events.off('routeChangeComplete', handleRouteChange)
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
