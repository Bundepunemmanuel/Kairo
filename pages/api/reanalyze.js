// reanalyze.js — Manual "Re-analyze product" trigger from Settings.
// Paid plans only, capped at once per 24h, enforced server-side (not just
// hidden in the UI) since client-side checks alone can be bypassed.

import { createClient } from '@supabase/supabase-js'

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const COOLDOWN_MS = 24 * 60 * 60 * 1000

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { userId } = req.body
  if (!userId) return res.status(400).json({ error: 'userId required' })

  try {
    const { data: planRow } = await supabaseAdmin
      .from('user_plans')
      .select('plan')
      .eq('user_id', userId)
      .single()

    const plan = planRow?.plan || 'free'
    if (plan === 'free') {
      return res.status(403).json({ error: 'Re-analyze is a paid-plan feature.' })
    }

    const { data: profile } = await supabaseAdmin
      .from('product_profiles')
      .select('url, last_analyzed_at')
      .eq('user_id', userId)
      .single()

    if (!profile?.url) return res.status(400).json({ error: 'No product URL on file.' })

    const lastAnalyzed = profile.last_analyzed_at ? new Date(profile.last_analyzed_at).getTime() : 0
    const msSinceLast = Date.now() - lastAnalyzed
    if (msSinceLast < COOLDOWN_MS) {
      const hoursLeft = Math.ceil((COOLDOWN_MS - msSinceLast) / (60 * 60 * 1000))
      return res.status(429).json({ error: `You can re-analyze again in ${hoursLeft}h.` })
    }

    const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || `https://${req.headers.host}`
    const analyzeRes = await fetch(`${baseUrl}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: profile.url }),
    })
    const analyzeData = await analyzeRes.json()

    if (analyzeData.isFallback) {
      // Same rule as the automatic weekly re-analyze: never let a failed
      // fallback overwrite a perfectly good existing analysis. Don't
      // update last_analyzed_at either, so the user can just try again
      // shortly instead of being locked out for 24h over a failed attempt.
      return res.status(502).json({ error: 'Re-analysis failed — your existing product data was kept unchanged. Try again shortly.' })
    }

    await supabaseAdmin
      .from('product_profiles')
      .update({ analysis: analyzeData.analysis, last_analyzed_at: new Date().toISOString() })
      .eq('user_id', userId)

    return res.status(200).json({ success: true, analysis: analyzeData.analysis })
  } catch (err) {
    console.error('[reanalyze] fatal:', err.message)
    return res.status(500).json({ error: 'Something went wrong. Please try again.' })
  }
}
