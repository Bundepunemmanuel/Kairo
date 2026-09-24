// scan-feed.js — Returns the most recent public scan_feed entries for the
// homepage ticker. Unauthenticated, read-only, and deliberately narrow —
// only the columns the ticker actually needs, nothing from product_profiles
// or leads itself.

import { createClient } from '@supabase/supabase-js'

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const { data, error } = await supabaseAdmin
      .from('scan_feed')
      .select('id, product_name, lead_count, top_score, created_at')
      .order('created_at', { ascending: false })
      .limit(20)

    if (error) {
      console.log('[scan-feed] fetch error:', error.message)
      return res.status(500).json({ error: 'Could not load scan feed' })
    }
    res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate')
    return res.status(200).json({ scans: data || [] })
  } catch (err) {
    console.error('[scan-feed] fatal:', err.message)
    return res.status(500).json({ error: 'Something went wrong' })
  }
}
