// getShareData.js — Server-only lookup for a shared scan by token.
//
// Used by getServerSideProps on pages/share/[token].js. This app fetches
// almost everything client-side, but that doesn't work for THIS page:
// link-preview bots (Slack, Twitter, iMessage, Facebook) read only the
// server-rendered HTML on first request — they don't run client JS or wait
// for a fetch to resolve. Without real SSR data, og:title/og:image would
// always reflect an empty loading state, never the actual scan. Also used
// by /api/get-share.js so both call sites share one lookup implementation.

import { createClient } from '@supabase/supabase-js'

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

export async function getShareByToken(token) {
  if (!token) return { status: 'not_found' }
  try {
    const { data, error } = await supabaseAdmin
      .from('shared_scans')
      .select('url, analysis, leads, created_at, expires_at')
      .eq('token', token)
      .single()

    if (error || !data) return { status: 'not_found' }
    if (new Date(data.expires_at) < new Date()) return { status: 'expired' }
    return { status: 'ready', data }
  } catch {
    return { status: 'not_found' }
  }
}
