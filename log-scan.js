// log-scan.js — Logs one row to scan_feed for the homepage ticker.
// Called from every scan path (onboarding.js's main flow, share/[token].js's
// notify-me flow) right after scoring completes — deliberately not tied to
// signup, email capture, or Save & Share, so the ticker reflects every scan
// that found something, not just ones that led to an account. Fire-and-
// forget from the caller; never blocks showing results to the person
// who just scanned.

import { createClient } from '@supabase/supabase-js'

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { productName, leadCount, topScore } = req.body
  if (!productName || !leadCount || leadCount < 1) {
    // Zero-qualified scans never reach here by design — the caller only
    // logs when qualifiedOnly.length > 0 — but double-checked server-side
    // too, since this is a public, unauthenticated endpoint.
    return res.status(400).json({ error: 'Nothing to log' })
  }

  try {
    const { error } = await supabaseAdmin.from('scan_feed').insert({
      product_name: String(productName).slice(0, 120),
      lead_count: Math.max(1, Math.floor(leadCount)),
      top_score: Number(topScore) || 0,
    })
    if (error) {
      console.log('[log-scan] insert error:', error.message)
      return res.status(500).json({ error: 'Could not log scan' })
    }
    return res.status(200).json({ ok: true })
  } catch (err) {
    console.error('[log-scan] fatal:', err.message)
    return res.status(500).json({ error: 'Something went wrong' })
  }
}
