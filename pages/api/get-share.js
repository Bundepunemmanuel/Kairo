// get-share.js — Fetches a shared scan snapshot for the public /share/[token]
// page. Expiry is enforced here, server-side, every time — not just relied
// on the daily cleanup cron job, so a link is never viewable even a moment
// past its expires_at, regardless of when the cleanup job last ran.

import { createClient } from '@supabase/supabase-js'

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const { token } = req.query
  if (!token) return res.status(400).json({ error: 'Missing token' })

  try {
    const { data, error } = await supabaseAdmin
      .from('shared_scans')
      .select('url, analysis, leads, created_at, expires_at')
      .eq('token', token)
      .single()

    if (error || !data) {
      return res.status(404).json({ error: 'not_found' })
    }

    if (new Date(data.expires_at) < new Date()) {
      return res.status(410).json({ error: 'expired' })
    }

    return res.status(200).json(data)
  } catch (err) {
    console.error('[get-share] fatal:', err.message)
    return res.status(500).json({ error: 'Something went wrong.' })
  }
}
