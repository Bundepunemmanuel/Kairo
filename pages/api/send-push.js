// send-push.js — Sends a browser push notification for each new lead.
// Called from cron-scan (index.ts) right after new leads are inserted.
// Requires the 'web-push' npm package — add it to package.json if not
// already present: npm install web-push

import { createClient } from '@supabase/supabase-js'
import webpush from 'web-push'

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT, // e.g. 'mailto:you@example.com'
  process.env.NEXT_PUBLIC_VAPID_KEY,
  process.env.VAPID_PRIVATE_KEY
)

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { userId, leads } = req.body
  if (!userId || !Array.isArray(leads) || !leads.length) {
    return res.status(400).json({ error: 'userId and a non-empty leads array are required' })
  }

  try {
    const { data: subscriptions } = await supabaseAdmin
      .from('push_subscriptions')
      .select('id, endpoint, p256dh, auth_key')
      .eq('user_id', userId)

    if (!subscriptions?.length) {
      // No subscriptions for this user — not an error, just nothing to do.
      return res.status(200).json({ sent: 0, message: 'no subscriptions for this user' })
    }

    let sent = 0
    let failed = 0

    for (const lead of leads) {
      // specificProblem (e.g. "Looking for Mojo Auth alternatives") reads
      // like a real signal summary, unlike the raw post title which is
      // often noisy/clickbaity. Fall back to the title if it's missing.
      const summary = lead.specificProblem || (lead.title || '').slice(0, 120)

      const payload = JSON.stringify({
        title: '🔥 Fresh buying signal detected',
        body: `r/${lead.subreddit} • ${summary}`,
        // Absolute URL so the click-through always lands on the production
        // domain regardless of which origin this subscription/SW was
        // registered on. Note: this does NOT change the origin label Chrome
        // shows above the notification itself (e.g. "kairo-git-chunk-6-...")
        // — that's tied to where the push subscription was created, and can
        // only be fixed by subscribing from https://kairo-omega.vercel.app
        // directly, not from anything sent in this payload.
        url: `https://kairo-omega.vercel.app/dashboard`,
        tag: `lead-${lead.id || lead.post_id || ''}`, // dedup near-simultaneous notifications for the same lead
      })

      for (const sub of subscriptions) {
        const pushSubscription = {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth_key },
        }

        try {
          await webpush.sendNotification(pushSubscription, payload)
          sent++
        } catch (err) {
          failed++
          // 404/410 means the browser subscription is gone (uninstalled,
          // permission revoked, etc.) — clean it up rather than retrying
          // forever on a dead endpoint.
          if (err.statusCode === 404 || err.statusCode === 410) {
            await supabaseAdmin.from('push_subscriptions').delete().eq('id', sub.id)
            console.log(`[send-push] removed dead subscription ${sub.id}`)
          } else {
            console.log(`[send-push] send error for subscription ${sub.id}:`, err.message)
          }
        }
      }
    }

    return res.status(200).json({ sent, failed })
  } catch (err) {
    console.error('[send-push] fatal:', err.message)
    return res.status(500).json({ error: 'Failed to send notifications' })
  }
}
