// log-scan.js — Logs one row to scan_feed for the homepage ticker, OR one
// row to visitor_events for the self-hosted analytics system (replaces
// PostHog — see lib/analytics.js). The two are kept in one file as two
// separate branches, keyed on whether eventType is present in the body,
// rather than as two separate routes, since both are the same shape of
// thing: a public, unauthenticated, fire-and-forget logging endpoint.
//
// scan_feed branch: called from every scan path (onboarding.js's main
// flow, share/[token].js's notify-me flow) right after scoring completes
// — deliberately not tied to signup, email capture, or Save & Share, so
// the ticker reflects every scan that found something, not just ones
// that led to an account. Fire-and-forget from the caller; never blocks
// showing results to the person who just scanned.
//
// visitor_events branch: called from lib/analytics.js's track() on every
// tracked event across the app, same fire-and-forget philosophy.

import { createClient } from '@supabase/supabase-js'

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  // ─── Analytics event branch ──────────────────────────────────────────
  // Events that must be server-confirmed, not merely client-claimed —
  // the client's own belief that it succeeded isn't proof. For these
  // specifically, accessToken must resolve to a real Supabase user (and,
  // for monitoring_activated, that user must actually have a
  // product_profiles row) or the event is rejected outright rather than
  // silently accepted as unverified.
  const SERVER_CONFIRMED_EVENTS = new Set(['signup_completed', 'monitoring_activated'])

  if (req.body && req.body.eventType) {
    const {
      eventType, visitorId, deviceType, isOwner, path, properties,
      sessionId, referrer, utmSource, utmMedium, utmCampaign, landingPage,
      accessToken,
    } = req.body
    if (!eventType || !visitorId) {
      return res.status(400).json({ error: 'eventType and visitorId are required' })
    }

    try {
      // Resolved server-side from the token, never trusted from a
      // client-claimed field — this is what makes auth_user_id and the
      // owner check both non-spoofable. Only attempted when a token is
      // actually present, so the vast majority of anonymous traffic
      // (page_view etc.) skips this round-trip entirely.
      let resolvedUserId = null
      let serverConfirmedOwner = false

      if (accessToken) {
        const { data: { user: resolvedUser } } = await supabaseAdmin.auth.getUser(accessToken)
        if (resolvedUser) {
          resolvedUserId = resolvedUser.id
          const { data: ownerRow } = await supabaseAdmin
            .from('owner_identities')
            .select('user_id')
            .eq('user_id', resolvedUser.id)
            .maybeSingle()
          serverConfirmedOwner = !!ownerRow
        }
      }

      if (SERVER_CONFIRMED_EVENTS.has(eventType) && !resolvedUserId) {
        // No real, verifiable identity behind this claim — refuse it
        // rather than recording an unconfirmed "signup" or "monitoring
        // activated" that never actually happened server-side.
        console.log(`[log-scan:event] rejected unconfirmed ${eventType} — accessToken missing or did not resolve`)
        return res.status(401).json({ error: 'Could not verify this event' })
      }

      if (eventType === 'monitoring_activated' && resolvedUserId) {
        // Doubly confirmed: a real user AND an actual product_profiles
        // row for them, read fresh here rather than trusting the
        // client's "I just upserted it" claim.
        const { data: profile } = await supabaseAdmin
          .from('product_profiles')
          .select('user_id')
          .eq('user_id', resolvedUserId)
          .maybeSingle()
        if (!profile) {
          console.log('[log-scan:event] rejected monitoring_activated — no product_profiles row found for resolved user')
          return res.status(409).json({ error: 'No monitoring profile found yet' })
        }
      }

      // Owner is true if EITHER signal says so: the server-verified
      // identity check (strongest, non-spoofable) or the client's
      // browser-flag fallback (for owner activity while signed out).
      const finalIsOwner = serverConfirmedOwner || !!isOwner

      const { error } = await supabaseAdmin.from('visitor_events').insert({
        event_type: String(eventType).slice(0, 120),
        visitor_id: String(visitorId).slice(0, 200),
        device_type: deviceType ? String(deviceType).slice(0, 20) : null,
        is_owner: finalIsOwner,
        path: path ? String(path).slice(0, 300) : null,
        properties: properties && typeof properties === 'object' ? properties : {},
        session_id: sessionId ? String(sessionId).slice(0, 200) : null,
        referrer: referrer ? String(referrer).slice(0, 500) : null,
        utm_source: utmSource ? String(utmSource).slice(0, 200) : null,
        utm_medium: utmMedium ? String(utmMedium).slice(0, 200) : null,
        utm_campaign: utmCampaign ? String(utmCampaign).slice(0, 200) : null,
        landing_page: landingPage ? String(landingPage).slice(0, 300) : null,
        auth_user_id: resolvedUserId,
        event_source: SERVER_CONFIRMED_EVENTS.has(eventType) ? 'server' : 'client',
      })
      if (error) {
        console.log('[log-scan:event] insert error:', error.message)
        return res.status(500).json({ error: 'Could not log event' })
      }

      // Upserts the session row (first-touch attribution preserved —
      // only set on insert, never overwritten by a later event in the
      // same session) so Phase 2's session-level queries don't need to
      // derive sessions from raw events.
      if (sessionId) {
        const { data: existingSession } = await supabaseAdmin
          .from('visitor_sessions')
          .select('session_id')
          .eq('session_id', sessionId)
          .maybeSingle()
        if (!existingSession) {
          await supabaseAdmin.from('visitor_sessions').insert({
            session_id: String(sessionId).slice(0, 200),
            visitor_id: String(visitorId).slice(0, 200),
            device_type: deviceType ? String(deviceType).slice(0, 20) : null,
            landing_page: landingPage ? String(landingPage).slice(0, 300) : null,
            referrer: referrer ? String(referrer).slice(0, 500) : null,
            utm_source: utmSource ? String(utmSource).slice(0, 200) : null,
            utm_medium: utmMedium ? String(utmMedium).slice(0, 200) : null,
            utm_campaign: utmCampaign ? String(utmCampaign).slice(0, 200) : null,
          })
        } else {
          await supabaseAdmin.from('visitor_sessions').update({ last_seen_at: new Date().toISOString() }).eq('session_id', sessionId)
        }
      }

      return res.status(200).json({ ok: true })
    } catch (err) {
      console.error('[log-scan:event] fatal:', err.message)
      return res.status(500).json({ error: 'Something went wrong' })
    }
  }

  // ─── scan_feed branch (unchanged) ────────────────────────────────────
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

    // Every re-scan refreshes the row — created_at bumped to now so the
    // ticker's ordering always reflects the most recent scan for this
    // product, not just whichever scan happened to find the best score.
    // (Previously this only updated when the new top score beat the old
    // one, which let a same-or-lower-scoring re-scan leave a stale entry
    // sitting at the top of the ticker.)
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
