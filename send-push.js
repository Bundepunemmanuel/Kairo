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

// Marks last_opened_at on one subscription — pinged by sw.js's
// notificationclick handler (see public/sw.js), which is the only thing
// that actually knows a notification was opened. Without this, #6's
// warn/delete sweep (index.ts) would have no way to tell "opened" apart
// from "sent and ignored."
async function markOpened(req, res) {
  const { endpoint } = req.body
  if (!endpoint) return res.status(400).json({ error: 'endpoint required' })
  try {
    const { error } = await supabaseAdmin
      .from('push_subscriptions')
      .update({ last_opened_at: new Date().toISOString() })
      .eq('endpoint', endpoint)
    if (error) {
      console.log('[send-push:mark-opened] update error:', error.message)
      return res.status(200).json({ ok: false })
    }
    return res.status(200).json({ ok: true })
  } catch (e) {
    console.log('[send-push:mark-opened] fatal:', e.message)
    return res.status(200).json({ ok: false })
  }
}

// Sends one arbitrary notification to a specific set of subscription ids
// — used by index.ts's daily #6 sweep for the Day 6 warning push, where
// there's no "lead" to build a notification from, just a plain message.
// Stamps last_sent_at on every subscription it's asked to send to
// (success or failure — the attempt itself is what starts/continues the
// clock, same as the default action below), and warned_at specifically
// when markWarned is set, so index.ts doesn't need a second round-trip
// just to record that the warning went out.
async function sendCustom(req, res) {
  const { subscriptionIds, title, body, url, markWarned } = req.body
  if (!Array.isArray(subscriptionIds) || !subscriptionIds.length || !title || !body) {
    return res.status(400).json({ error: 'subscriptionIds, title, and body are required' })
  }

  try {
    const { data: subscriptions } = await supabaseAdmin
      .from('push_subscriptions')
      .select('id, endpoint, p256dh, auth_key')
      .in('id', subscriptionIds)

    if (!subscriptions?.length) return res.status(200).json({ sent: 0 })

    const payload = JSON.stringify({
      title,
      body,
      url: url || 'https://kairo-omega.vercel.app/dashboard',
      tag: 'kairo-engagement-warning',
    })

    let sent = 0
    const sentIds = []

    for (const sub of subscriptions) {
      const pushSubscription = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_key } }
      try {
        await webpush.sendNotification(pushSubscription, payload)
        sent++
        sentIds.push(sub.id)
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await supabaseAdmin.from('push_subscriptions').delete().eq('id', sub.id)
          console.log(`[send-push:send-custom] removed dead subscription ${sub.id}`)
        } else {
          console.log(`[send-push:send-custom] send error for subscription ${sub.id}:`, err.message)
        }
      }
    }

    if (sentIds.length) {
      const update = { last_sent_at: new Date().toISOString() }
      if (markWarned) update.warned_at = new Date().toISOString()
      await supabaseAdmin.from('push_subscriptions').update(update).in('id', sentIds)
    }

    return res.status(200).json({ sent })
  } catch (e) {
    console.log('[send-push:send-custom] fatal:', e.message)
    return res.status(500).json({ error: 'Failed to send notification' })
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  if (req.body?.action === 'mark-opened') return markOpened(req, res)
  if (req.body?.action === 'send-custom') return sendCustom(req, res)

  // Default action (also action: 'send-leads', same thing) — the
  // original per-lead notification behavior, unchanged below except for
  // the last_sent_at stamping at the end, added for #6's engagement clock.
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
    const sentSubscriptionIds = new Set()

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
          sentSubscriptionIds.add(sub.id)
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

    // Feeds #6's engagement clock (index.ts's daily sweep) — a user with
    // last_sent_at still null has never been sent anything and is
    // correctly excluded from that sweep entirely.
    if (sentSubscriptionIds.size) {
      await supabaseAdmin
        .from('push_subscriptions')
        .update({ last_sent_at: new Date().toISOString() })
        .in('id', [...sentSubscriptionIds])
    }

    return res.status(200).json({ sent, failed })
  } catch (err) {
    console.error('[send-push] fatal:', err.message)
    return res.status(500).json({ error: 'Failed to send notifications' })
  }
}
