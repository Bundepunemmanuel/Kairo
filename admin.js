// admin.js — Admin-only actions: force-scan, set-plan
// Restricted server-side to the hardcoded admin email, regardless of any
// client-side check, since this route touches the service role key.

import { createClient } from '@supabase/supabase-js'

const ADMIN_EMAIL = 'bundepunemmanuel@gmail.com'

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // server-side only, never exposed to browser
)

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { action, requesterEmail } = req.body

  // Server-side admin check — never trust the client alone
  if (requesterEmail !== ADMIN_EMAIL) {
    return res.status(403).json({ error: 'Not authorized' })
  }

  try {
    if (action === 'force-scan') {
      const edgeFunctionUrl = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/cron-scan`
      const triggerRes = await fetch(edgeFunctionUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({}),
      })
      const data = await triggerRes.json()
      return res.status(200).json({ message: `Scan complete: ${data.processed || 0} processed, ${data.skipped || 0} skipped`, ...data })
    }

    if (action === 'set-plan') {
      const { targetUserId, newPlan } = req.body
      if (!targetUserId || !newPlan) {
        return res.status(400).json({ error: 'targetUserId and newPlan required' })
      }
      const validPlans = ['free', 'starter', 'pro', 'unlimited']
      if (!validPlans.includes(newPlan)) {
        return res.status(400).json({ error: 'Invalid plan' })
      }

      const { error } = await supabaseAdmin.from('user_plans').upsert(
        { user_id: targetUserId, plan: newPlan, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' }
      )
      if (error) throw error

      return res.status(200).json({ message: `Plan updated to ${newPlan}` })
    }

    return res.status(400).json({ error: 'Unknown action' })
  } catch (err) {
    console.error('[admin] error:', err.message)
    return res.status(500).json({ error: err.message })
  }
}
