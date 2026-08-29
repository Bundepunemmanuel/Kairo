// save-share.js — Snapshots a scan's results into a public, expiring link.
//
// Called from onboarding.js's "Save & Share Leads" button. Works with zero
// account, same as the free scan itself — no user_id anywhere in this
// table. Generates a reply for every lead up front, since the public share
// page (/share/[token]) is read-only with no "View Reply" button to click —
// unlike onboarding.js/dashboard.js, where replies still generate on demand.

import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const REPLY_FALLBACK = "Couldn't generate a reply for this one right now."
const SHARE_TTL_DAYS = 7

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { url, analysis, leads } = req.body
  if (!url || !analysis || !Array.isArray(leads) || leads.length === 0) {
    return res.status(400).json({ error: 'Missing scan data — please rescan and try again' })
  }

  try {
    // Same-deployment call to the existing reply endpoint — reuses all of
    // its model fallback logic as-is rather than duplicating it here.
    // Isolated per-lead with allSettled so one bad reply can't take the
    // rest of the share down with it.
    const origin = `https://${req.headers.host}`
    const replyResults = await Promise.allSettled(
      leads.map(lead =>
        fetch(`${origin}/api/reply`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            post: { title: lead.title, body: lead.body, subreddit: lead.subreddit },
            analysis,
            signalType: lead.signalType,
            specificProblem: lead.specificProblem,
          }),
        }).then(r => r.json())
      )
    )

    const leadsWithReplies = leads.map((lead, i) => {
      const result = replyResults[i]
      const reply = result.status === 'fulfilled' ? (result.value?.reply || '').trim() : ''
      return { ...lead, reply: reply || REPLY_FALLBACK, replyFailed: !reply }
    })

    const token = crypto.randomBytes(20).toString('hex')
    const expiresAt = new Date(Date.now() + SHARE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString()

    const { error: insertErr } = await supabaseAdmin.from('shared_scans').insert({
      token,
      url,
      analysis,
      leads: leadsWithReplies,
      expires_at: expiresAt,
    })

    if (insertErr) {
      console.log('[save-share] insert error:', insertErr.message)
      return res.status(500).json({ error: 'Could not save your share link. Please try again.' })
    }

    return res.status(200).json({ token, expiresAt })
  } catch (err) {
    console.error('[save-share] fatal:', err.message)
    return res.status(500).json({ error: 'Something went wrong. Please try again.' })
  }
}
