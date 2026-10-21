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

  const { productName, leadCount, topScore, url } = req.body
  if (!productName || !leadCount || leadCount < 1) {
    // Zero-qualified scans never reach here by design — the caller only
    // logs when qualifiedOnly.length > 0 — but double-checked server-side
    // too, since this is a public, unauthenticated endpoint.
    return res.status(400).json({ error: 'Nothing to log' })
  }

  const cleanProductName = String(productName).slice(0, 120)
  const cleanLeadCount = Math.max(1, Math.floor(leadCount))
  const cleanTopScore = Number(topScore) || 0

  try {
    // url is the scanned product's own site (onboarding.js / share/[token].js
    // pass their `clean` variable through) — not a Reddit post URL,
    // scan_feed has never tracked individual posts. A caller without one
    // yet falls back to the old always-insert behavior rather than
    // erroring; it just won't dedupe for that row.
    if (!url) {
      const { error } = await supabaseAdmin.from('scan_feed').insert({
        product_name: cleanProductName,
        lead_count: cleanLeadCount,
        top_score: cleanTopScore,
      })
      if (error) {
        console.log('[log-scan] insert error:', error.message)
        return res.status(500).json({ error: 'Could not log scan' })
      }
      return res.status(200).json({ ok: true })
    }

    const { data: existing, error: readErr } = await supabaseAdmin
      .from('scan_feed')
      .select('id, top_score')
      .eq('url', url)
      .maybeSingle()
    if (readErr) {
      console.log('[log-scan] read error:', readErr.message)
      return res.status(500).json({ error: 'Could not log scan' })
    }

    if (!existing) {
      const { error } = await supabaseAdmin.from('scan_feed').insert({
        product_name: cleanProductName,
        lead_count: cleanLeadCount,
        top_score: cleanTopScore,
        url,
      })
      if (error) {
        console.log('[log-scan] insert error:', error.message)
        return res.status(500).json({ error: 'Could not log scan' })
      }
      return res.status(200).json({ ok: true, action: 'inserted' })
    }

    // Only update when the new scan is actually BETTER — a weaker
    // re-scan (fewer or lower-scoring leads this time, e.g. because posts
    // simply aged out) shouldn't make the ticker regress on something it
    // already showed for this product.
    if (cleanTopScore <= existing.top_score) {
      return res.status(200).json({ ok: true, action: 'unchanged' })
    }

    // created_at bumped to now on a real update, so the ticker's ordering
    // reflects when the best result was actually found, not just when
    // this product first ever got scanned.
    const { error: updateErr } = await supabaseAdmin
      .from('scan_feed')
      .update({
        product_name: cleanProductName,
        lead_count: cleanLeadCount,
        top_score: cleanTopScore,
        created_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
    if (updateErr) {
      console.log('[log-scan] update error:', updateErr.message)
      return res.status(500).json({ error: 'Could not log scan' })
    }

    return res.status(200).json({ ok: true, action: 'updated' })
  } catch (err) {
    console.error('[log-scan] fatal:', err.message)
    return res.status(500).json({ error: 'Something went wrong' })
  }
}
