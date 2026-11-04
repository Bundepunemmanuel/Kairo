// register-push.js — Registers a push subscription for an ALREADY
// signed-in user, as its own explicit action. Previously this only ever
// happened as an automatic side effect of submitting the signup/notify-me
// form (onboarding.js and share/[token].js both called subscribeToPush()
// inline, before the person had actually chosen to turn on browser
// notifications — just typing an email could trigger the browser's native
// permission prompt). This endpoint is what those flows call AFTER
// account creation succeeds, only when the person taps a separate
// explicit "turn on alerts" button.
//
// Requires the caller's own Supabase access token so this can only ever
// register a subscription for whoever is actually signed in — never an
// arbitrary user_id passed in the body.

import { createClient } from '@supabase/supabase-js'

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { subscription, accessToken } = req.body
  if (!subscription?.endpoint || !subscription?.keys) {
    return res.status(400).json({ error: 'Invalid subscription' })
  }
  if (!accessToken) return res.status(401).json({ error: 'Not signed in' })

  try {
    const { data: { user }, error: userErr } = await supabaseAdmin.auth.getUser(accessToken)
    if (userErr || !user) return res.status(401).json({ error: 'Not signed in' })

    // Same shape as capture-lead.js's own push_subscriptions write, kept
    // in sync intentionally — this is the same table, just written to at
    // a different point in the flow now.
    const { error } = await supabaseAdmin.from('push_subscriptions').upsert(
      {
        user_id: user.id,
        endpoint: subscription.endpoint,
        p256dh: subscription.keys.p256dh,
        auth_key: subscription.keys.auth,
      },
      { onConflict: 'user_id,endpoint' }
    )
    if (error) throw error

    return res.status(200).json({ ok: true })
  } catch (e) {
    console.log('[register-push] error:', e.message)
    return res.status(500).json({ error: 'Could not save push subscription' })
  }
}
