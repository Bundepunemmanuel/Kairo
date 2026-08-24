// capture-lead.js — Turns a zero-results onboarding visitor into a real,
// watched account without ever showing them a signup form.
//
// Called from onboarding.js's "Notify me" flow after the browser has
// already been granted push permission and produced a subscription object.
// This endpoint:
//   1. Creates a passwordless Supabase user for their email (or reuses one,
//      see the duplicate-email handling below)
//   2. Saves their already-computed product_profiles row (no re-scan)
//   3. Saves the push subscription directly, bypassing RLS via the
//      service-role key since there's no logged-in session yet
//   4. Mints a real session and returns it, so the browser can call
//      supabase.auth.setSession() and be quietly logged in
//
// From here on, cron-scan and send-push.js need zero changes — this user
// has a normal product_profiles row and a normal push_subscriptions row,
// so the existing pipeline just picks them up on its regular schedule.

import { createClient } from '@supabase/supabase-js'

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// Separate anon-key client used only to mint a session via password
// sign-in — admin.createUser() doesn't return a session by itself, and
// this avoids ever emailing a magic link (the whole point of this flow
// is no email sending at all).
const supabaseAnon = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
)

const isValidEmail = str => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str)

// Generated server-side, never shown to the user, never sent anywhere.
// Exists only so we can immediately sign in as the new user and hand back
// a real session. Fully overwritten the moment they set a real password
// via PasswordGateModal — this value is never meant to be memorable or
// reused.
const randomThrowawayPassword = () =>
  crypto.randomUUID() + crypto.randomUUID()

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { email, url, analysis, leads, subscription } = req.body

  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ error: 'Please enter a valid email' })
  }
  if (!url || !analysis) {
    return res.status(400).json({ error: 'Missing scan data — please rescan and try again' })
  }
  // Subscription is optional — Safari/iOS visitors following the
  // add-to-home-screen instructions won't have one on this request; they
  // still get an account + profile so cron-scan starts watching for them,
  // they just won't receive a push until they enable it later in Settings.

  try {
    let userId
    let session = null
    let existingAccount = false
    const throwawayPassword = randomThrowawayPassword()

    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email,
      password: throwawayPassword,
      email_confirm: true, // required for password sign-in to work immediately below
    })

    if (createErr) {
      // Most likely cause: this email already has an account (a returning
      // visitor, or someone who separately signed up for real). Look up
      // the existing user via generateLink — it returns the user object
      // for any existing email without actually sending anything, so we
      // never email a link we don't intend to use.
      if (/already.*registered|already exists/i.test(createErr.message || '')) {
        const { data: linked, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
          type: 'magiclink',
          email,
        })
        if (linkErr || !linked?.user?.id) {
          console.log('[capture-lead] could not resolve existing user:', linkErr?.message)
          return res.status(500).json({ error: 'Something went wrong. Please try again.' })
        }
        userId = linked.user.id
        existingAccount = true
        // Do NOT attempt to sign in as this user — we don't know their
        // real password, and silently minting a session for an account we
        // didn't just create would be a real account-takeover risk. They
        // keep using whatever login they already have.
      } else {
        console.log('[capture-lead] createUser error:', createErr.message)
        return res.status(500).json({ error: 'Something went wrong. Please try again.' })
      }
    } else {
      userId = created.user.id
      // Fresh account — safe to sign in with the throwaway password we
      // just set, purely to hand back a working session.
      const { data: signInData, error: signInErr } = await supabaseAnon.auth.signInWithPassword({
        email,
        password: throwawayPassword,
      })
      if (signInErr) {
        console.log('[capture-lead] sign-in after create failed:', signInErr.message)
        // Non-fatal — account + profile still get saved below, they just
        // won't be auto-logged-in this visit. They can use "forgot
        // password" later if this ever happens.
      } else {
        session = signInData.session
      }
    }

    // Save the scan they already watched run — no re-scan needed.
    const { error: profileErr } = await supabaseAdmin.from('product_profiles').upsert(
      { user_id: userId, url, analysis, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    )
    if (profileErr) console.log('[capture-lead] profile save error:', profileErr.message)

    // Only ever set to false on first creation — an existing account may
    // already have a real password, so never downgrade it back to false.
    if (!existingAccount) {
      await supabaseAdmin.from('product_profiles')
        .update({ password_set: false })
        .eq('user_id', userId)
    }

    // Same qualified-only rule used elsewhere — close matches are for the
    // onboarding preview, not the real leads table.
    const qualifiedOnly = (leads || []).filter(l => l.tier !== 'close')
    if (qualifiedOnly.length > 0) {
      const leadsToSave = qualifiedOnly.map(lead => ({
        user_id: userId,
        post_id: lead.id || lead.url,
        title: lead.title,
        body: lead.body || '',
        url: lead.url,
        subreddit: lead.subreddit,
        score: lead.score,
        signal_type: lead.signalType,
        specific_problem: lead.specificProblem || '',
        reason: lead.reason || '',
        created_at_post: lead.createdAt || Date.now(),
      }))
      await supabaseAdmin.from('leads').insert(leadsToSave)
    }

    if (subscription?.endpoint && subscription?.keys) {
      const { error: pushErr } = await supabaseAdmin.from('push_subscriptions').upsert(
        {
          user_id: userId,
          endpoint: subscription.endpoint,
          p256dh: subscription.keys.p256dh,
          auth_key: subscription.keys.auth,
        },
        { onConflict: 'user_id,endpoint' }
      )
      if (pushErr) console.log('[capture-lead] push subscription save error:', pushErr.message)
    }

    return res.status(200).json({
      session: session
        ? { access_token: session.access_token, refresh_token: session.refresh_token }
        : null,
      existingAccount,
    })
  } catch (err) {
    console.error('[capture-lead] fatal:', err.message)
    return res.status(500).json({ error: 'Something went wrong. Please try again.' })
  }
}
