// admin.js — Admin-only actions: get-admin-data, force-scan, set-plan, cleanup-old-leads
// Restricted server-side to the hardcoded admin email, regardless of any
// client-side check, since this route touches the service role key.
// All data loading goes through here too, using the service role key,
// so RLS never filters out other users' rows from the admin's view.
//
// SECURITY: authorization is verified against a real Supabase session —
// the caller sends accessToken (session.access_token, see useAuth() in
// _app.js), which is resolved server-side via supabaseAdmin.auth.getUser()
// and checked against ADMIN_EMAIL. This used to accept a plain
// requesterEmail string straight from the request body with no
// verification at all — anyone who knew the admin's email (visible in
// plaintext throughout this app's own UI: the user list, upgrade
// requests) could call this endpoint directly and read or modify
// anything it touches, no login required. That's the actual
// vulnerability this replaces.

import { createClient } from '@supabase/supabase-js'

const ADMIN_EMAIL = 'bundepunemmanuel@gmail.com'

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // server-side only, never exposed to browser
)

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { action, accessToken } = req.body

  if (!accessToken) {
    return res.status(401).json({ error: 'Not signed in' })
  }

  const { data: { user: requester }, error: authErr } = await supabaseAdmin.auth.getUser(accessToken)
  if (authErr || !requester || requester.email !== ADMIN_EMAIL) {
    return res.status(403).json({ error: 'Not authorized' })
  }

  try {
    // ─── Load all admin data, bypassing RLS via service role ─────────────
    if (action === 'get-admin-data') {
      const { data: allPlans } = await supabaseAdmin.from('user_plans').select('user_id, plan, updated_at')
      const { data: allProfiles } = await supabaseAdmin.from('product_profiles').select('user_id, url, analysis, created_at, last_scan_at, is_held, held_at')
      const { data: settingsRows } = await supabaseAdmin.from('user_settings').select('user_id, last_active_at')

      // Emails live in auth.users, not any table we can query directly —
      // service-role-only admin API call, then join by user_id.
      let emailByUserId = {}
      try {
        const { data: authList, error: authErr } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
        if (authErr) throw authErr
        ;(authList?.users || []).forEach(u => { emailByUserId[u.id] = u.email })
      } catch (e) {
        console.error('[admin] listUsers failed:', e.message)
      }

      const { data: upgradeRequestRows } = await supabaseAdmin
        .from('upgrade_requests')
        .select('user_id, requested_plan, created_at')
        .order('created_at', { ascending: false })
      const upgradeRequests = (upgradeRequestRows || []).map(r => ({
        ...r,
        email: emailByUserId[r.user_id] || null,
      }))

      const planCounts = { free: 0, starter: 0, pro: 0, unlimited: 0 }
      ;(allPlans || []).forEach(p => { planCounts[p.plan] = (planCounts[p.plan] || 0) + 1 })

      const totalUsers = allProfiles?.length || 0
      const plannedUsers = allPlans?.length || 0
      planCounts.free += Math.max(0, totalUsers - plannedUsers)

      const PLAN_PRICES = { free: 0, starter: 29, pro: 49, unlimited: 99 }
      const mrr = (planCounts.starter * PLAN_PRICES.starter) + (planCounts.pro * PLAN_PRICES.pro) + (planCounts.unlimited * PLAN_PRICES.unlimited)

      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      const { count: leadsLast24h } = await supabaseAdmin
        .from('leads')
        .select('id', { count: 'exact', head: true })
        .gte('scanned_at', twentyFourHoursAgo)

      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
      const { data: pushRows } = await supabaseAdmin.from('push_subscriptions').select('user_id')
      const pushEnabledUserIds = new Set((pushRows || []).map(r => r.user_id))

      const churnRisk = (allProfiles || [])
        .filter(p => {
          const settings = (settingsRows || []).find(s => s.user_id === p.user_id)
          const lastActive = settings?.last_active_at || p.created_at
          return new Date(lastActive) < new Date(sevenDaysAgo)
        })
        .map(p => {
          const settings = (settingsRows || []).find(s => s.user_id === p.user_id)
          const lastActive = settings?.last_active_at || p.created_at
          const planRow = (allPlans || []).find(pl => pl.user_id === p.user_id)
          const plan = planRow?.plan || 'free'
          const pushEnabled = pushEnabledUserIds.has(p.user_id)
          const daysInactive = Math.floor((Date.now() - new Date(lastActive).getTime()) / (24 * 60 * 60 * 1000))
          return {
            user_id: p.user_id,
            url: p.url,
            name: p.analysis?.name || p.url,
            plan,
            pushEnabled,
            daysInactive,
            // A paying user sitting quietly with push OFF is a real risk —
            // nothing will bring them back. A paying user with push ON is
            // just being served the way the product is designed to work
            // (no reason to open the dashboard until there's a real lead),
            // not actually at risk. Free users matter far less either way.
            riskScore: (plan !== 'free' ? 2 : 0) + (!pushEnabled ? 1 : 0),
          }
        })
        .sort((a, b) => b.riskScore - a.riskScore || b.daysInactive - a.daysInactive)

      const subredditCounts = {}
      ;(allProfiles || []).forEach(p => {
        (p.analysis?.subreddits || []).forEach(s => {
          subredditCounts[s] = (subredditCounts[s] || 0) + 1
        })
      })
      const topSubreddits = Object.entries(subredditCounts).sort((a, b) => b[1] - a[1]).slice(0, 8)

      const userList = (allProfiles || []).map(p => {
        const planRow = (allPlans || []).find(pl => pl.user_id === p.user_id)
        return {
          user_id: p.user_id,
          url: p.url,
          name: p.analysis?.name || p.url,
          email: emailByUserId[p.user_id] || null,
          plan: planRow?.plan || 'free',
          created_at: p.created_at,
          last_scan_at: p.last_scan_at,
          is_held: p.is_held || false,
          held_at: p.held_at || null,
        }
      })

      const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
      const { count: oldArchivedCount } = await supabaseAdmin
        .from('leads')
        .select('id', { count: 'exact', head: true })
        .or('deleted.eq.true,replied.eq.true')
        .lt('scanned_at', ninetyDaysAgo)

      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
      const { count: oldSeenPostsCount } = await supabaseAdmin
        .from('seen_posts')
        .select('id', { count: 'exact', head: true })
        .lt('scored_at', thirtyDaysAgo)

      // Cron runs every 30 min via pg_cron. Give a 15-min buffer for scan
      // duration + clock drift before flagging it unhealthy.
      const lastCronRun = userList
        .map(u => u.last_scan_at)
        .filter(Boolean)
        .sort((a, b) => new Date(b) - new Date(a))[0] || null

      const CRON_HEALTHY_WINDOW_MS = 45 * 60 * 1000 // 45 minutes
      const cronHealthy = lastCronRun
        ? (Date.now() - new Date(lastCronRun).getTime()) < CRON_HEALTHY_WINDOW_MS
        : false

      return res.status(200).json({
        totalUsers,
        planCounts,
        mrr,
        leadsLast24h: leadsLast24h || 0,
        topSubreddits,
        userList,
        churnRisk,
        oldArchivedCount: oldArchivedCount || 0,
        oldSeenPostsCount: oldSeenPostsCount || 0,
        cronHealthy,
        lastCronRun,
        upgradeRequests,
      })
    }

    // ─── Force a scan across all users ────────────────────────────────────
    if (action === 'force-scan') {
      const edgeFunctionUrl = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/cron-scan`
      let triggerRes
      try {
        triggerRes = await fetch(edgeFunctionUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          },
          body: JSON.stringify({}),
          signal: AbortSignal.timeout(45000),
        })
      } catch (fetchErr) {
        console.error('[admin] force-scan fetch failed:', fetchErr.message)
        return res.status(200).json({ message: 'Could not reach the scan function. Check it is deployed and the URL is correct.', error: fetchErr.message })
      }

      // Never blindly call .json() — the Edge Function might return HTML on auth/404 errors
      const rawText = await triggerRes.text()
      let data
      try {
        data = JSON.parse(rawText)
      } catch {
        console.error('[admin] force-scan returned non-JSON:', rawText.slice(0, 200))
        return res.status(200).json({
          message: `Scan function returned an unexpected response (status ${triggerRes.status}). Check Edge Function logs.`,
          error: rawText.slice(0, 200),
        })
      }

      return res.status(200).json({ message: `Scan complete: ${data.processed || 0} processed, ${data.skipped || 0} skipped`, ...data })
    }

    // ─── Bulk cleanup of old archived leads (90+ days, replied/deleted) ──
    if (action === 'cleanup-old-leads') {
      const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
      const { error, count } = await supabaseAdmin
        .from('leads')
        .delete({ count: 'exact' })
        .or('deleted.eq.true,replied.eq.true')
        .lt('scanned_at', ninetyDaysAgo)
      if (error) throw error
      return res.status(200).json({ message: `Deleted ${count || 0} old archived leads`, deleted: count || 0 })
    }

    // ─── Bulk cleanup of old seen_posts (30+ days) ────────────────────────
    // These rows just prevent re-scoring the same post twice — anything
    // this old will never resurface in Reddit's "new" feed anyway, so
    // deleting them is safe and just reclaims storage.
    if (action === 'cleanup-seen-posts') {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
      const { error, count } = await supabaseAdmin
        .from('seen_posts')
        .delete({ count: 'exact' })
        .lt('scored_at', thirtyDaysAgo)
      if (error) throw error
      return res.status(200).json({ message: `Deleted ${count || 0} old seen_posts rows`, deleted: count || 0 })
    }

    // ─── Get one user's leads (for the expandable list in the user table) ──
    if (action === 'get-user-leads') {
      const { targetUserId } = req.body
      if (!targetUserId) return res.status(400).json({ error: 'targetUserId required' })

      const { data: leads, error } = await supabaseAdmin
        .from('leads')
        .select('id, title, subreddit, score, scanned_at, url, signal_type, specific_problem, reason, deleted, replied')
        .eq('user_id', targetUserId)
        .order('scanned_at', { ascending: false })
        .limit(200)
      if (error) throw error

      return res.status(200).json({ leads: leads || [] })
    }

    // ─── Change a user's plan ─────────────────────────────────────────────
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

    // ─── Manually hold or release an account (#5) ─────────────────────────
    // The admin-side half of the hold system — index.ts's daily job only
    // ever sets is_held TRUE (7+ days inactive); this is the only path
    // that can set it back to FALSE other than the user's own dashboard
    // Resume button. held_at is cleared on release so a later re-hold
    // starts a fresh clock rather than showing a stale date.
    if (action === 'set-hold') {
      const { targetUserId, held } = req.body
      if (!targetUserId || typeof held !== 'boolean') {
        return res.status(400).json({ error: 'targetUserId and a boolean held are required' })
      }

      const { error } = await supabaseAdmin
        .from('product_profiles')
        .update({ is_held: held, held_at: held ? new Date().toISOString() : null })
        .eq('user_id', targetUserId)
      if (error) throw error

      return res.status(200).json({ message: held ? 'Account held' : 'Account released' })
    }

    // ─── Admin X-lead watchlist (#4) ───────────────────────────────────────
    // Bulk-add — one pair per line, strictly `<productUrl> <xPostUrl>`
    // (whitespace-separated). Lines that don't parse into exactly two
    // URLs are reported back rather than silently dropped, so a typo'd
    // line doesn't just vanish from what was pasted.
    if (action === 'watchlist-add') {
      const { pairs } = req.body
      if (!pairs || typeof pairs !== 'string' || !pairs.trim()) {
        return res.status(400).json({ error: 'Nothing pasted' })
      }

      const isUrl = str => {
        try { new URL(str.startsWith('http') ? str : `https://${str}`); return true }
        catch { return false }
      }

      const lines = pairs.split('\n').map(l => l.trim()).filter(Boolean)
      const toInsert = []
      const skipped = []

      lines.forEach((line, i) => {
        const tokens = line.split(/\s+/).filter(Boolean)
        if (tokens.length !== 2) {
          skipped.push({ line: i + 1, text: line, reason: tokens.length < 2 ? 'Missing a URL — expected exactly 2 per line' : 'Too many URLs on this line — expected exactly 1 product URL + 1 X post URL' })
          return
        }
        const [productUrl, xPostUrl] = tokens
        if (!isUrl(productUrl) || !isUrl(xPostUrl)) {
          skipped.push({ line: i + 1, text: line, reason: 'One or both tokens aren\u2019t valid URLs' })
          return
        }
        toInsert.push({ product_url: productUrl, x_post_url: xPostUrl, status: 'pending' })
      })

      if (toInsert.length) {
        const { error } = await supabaseAdmin.from('watchlist_items').insert(toInsert)
        if (error) throw error
      }

      return res.status(200).json({ inserted: toInsert.length, skipped })
    }

    // List every watchlist item plus live control state and, for items
    // that reached 'done', their per-share view count/last-viewed time
    // (#6) pulled from visitor_events by matching share_token against
    // properties->>'token' on share_page_viewed rows.
    if (action === 'watchlist-list') {
      const { data: items, error: itemsErr } = await supabaseAdmin
        .from('watchlist_items')
        .select('id, product_url, x_post_url, status, share_token, lead_count, top_score, error_message, created_at, updated_at')
        .order('created_at', { ascending: false })
        .limit(500)
      if (itemsErr) throw itemsErr

      const { data: control } = await supabaseAdmin
        .from('watchlist_control')
        .select('is_running, cancel_requested, last_activity_at')
        .eq('id', 'global')
        .maybeSingle()

      // A slice is supposed to either finish or re-stamp the heartbeat
      // within well under the 2-minute self-reschedule interval. 3
      // minutes with no heartbeat while is_running is still true is a
      // real signal the chain died, not normal in-between-slices quiet.
      const isStalled = !!(
        control?.is_running &&
        (!control.last_activity_at || Date.now() - new Date(control.last_activity_at).getTime() > 3 * 60 * 1000)
      )

      const tokens = (items || []).map(i => i.share_token).filter(Boolean)
      let viewsByToken = {}
      if (tokens.length) {
        const { data: viewRows } = await supabaseAdmin
          .from('visitor_events')
          .select('properties, created_at')
          .eq('event_type', 'share_page_viewed')
          .in('properties->>token', tokens)
        ;(viewRows || []).forEach(r => {
          const t = r.properties?.token
          if (!t) return
          if (!viewsByToken[t]) viewsByToken[t] = { count: 0, lastViewedAt: null }
          viewsByToken[t].count++
          if (!viewsByToken[t].lastViewedAt || new Date(r.created_at) > new Date(viewsByToken[t].lastViewedAt)) {
            viewsByToken[t].lastViewedAt = r.created_at
          }
        })
      }

      const itemsWithViews = (items || []).map(i => ({
        ...i,
        viewCount: i.share_token ? (viewsByToken[i.share_token]?.count || 0) : 0,
        lastViewedAt: i.share_token ? (viewsByToken[i.share_token]?.lastViewedAt || null) : null,
      }))

      const pendingCount = (items || []).filter(i => i.status === 'pending').length

      return res.status(200).json({
        items: itemsWithViews,
        isRunning: control?.is_running || false,
        cancelRequested: control?.cancel_requested || false,
        lastActivityAt: control?.last_activity_at || null,
        isStalled,
        pendingCount,
      })
    }

    // Kicks off the batch by firing the first slice DIRECTLY, right now —
    // not through schedule_watchlist_followup. That RPC's delayed-cron
    // trick only exists to create a genuine future delay for the
    // 2-minute self-reschedule gap BETWEEN slices (see index.ts's
    // runWatchlistScan); there's no reason to delay the very first slice
    // at all, and doing so was the actual bug that left the batch
    // permanently stuck — a 5-second buffer was too tight for pg_cron's
    // minute-granularity scheduling to reliably land before the target
    // minute, and a missed minute on a day+month-specific one-shot
    // expression doesn't retry, it just waits up to a year.
    //
    // net.http_post isn't involved here at all for this call — this is a
    // plain fetch from Node straight to the Edge Function. The short
    // AbortSignal.timeout below is NOT an error condition: a slice can
    // take up to ~150s, and this handler has no reason to wait for it —
    // it only needs to confirm the request was actually dispatched before
    // returning, so Vercel doesn't freeze this function before the
    // request even leaves. A timeout is the expected outcome; only a
    // genuine connection-level failure (DNS, refused, immediate error
    // response) should roll back is_running.
    if (action === 'watchlist-run') {
      await supabaseAdmin.from('watchlist_control').upsert(
        { id: 'global', is_running: true, cancel_requested: false, updated_at: new Date().toISOString() },
        { onConflict: 'id' }
      )

      try {
        await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/cron-scan?task=watchlist-scan`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` },
          body: '{}',
          signal: AbortSignal.timeout(8000),
        })
      } catch (e) {
        if (e.name !== 'AbortError' && e.name !== 'TimeoutError') {
          await supabaseAdmin.from('watchlist_control').update({ is_running: false }).eq('id', 'global')
          throw e
        }
        // Expected: the 8s window closed before the slice finished its
        // own ~150s of work. The slice is still running server-side.
      }

      return res.status(200).json({ message: 'Batch starting' })
    }

    // Sets BOTH is_running=false (immediate, for the admin's own view of
    // reality) AND cancel_requested=true (for a genuinely live
    // invocation, checked before each item in its current slice — see
    // index.ts's runWatchlistScan — so a real in-flight batch still never
    // gets an item half-processed). Previously this only set
    // cancel_requested and left is_running for some future invocation to
    // clear — which meant a chain that had already died (e.g. from the
    // schema-cron permission error) left is_running stuck true forever,
    // since nothing was left running to ever read the flag. Pressing Stop
    // should always be able to make the UI stop claiming a batch is
    // running, whether or not anything is actually still executing.
    if (action === 'watchlist-stop') {
      const { error } = await supabaseAdmin
        .from('watchlist_control')
        .update({ is_running: false, cancel_requested: true, updated_at: new Date().toISOString() })
        .eq('id', 'global')
      if (error) throw error

      return res.status(200).json({ message: 'Stopped' })
    }

    // Recovery for exactly the stuck-state scenario above: clears
    // is_running/cancel_requested AND resets any item still marked
    // 'scanning' back to 'pending'. The 'scanning' reset matters because
    // if the Edge Function's whole process gets killed mid-item (a hard
    // platform-level timeout, not a caught exception — processWatchlistItem's
    // own try/catch already handles every other failure by marking the
    // item 'error'), that item would otherwise sit on 'scanning' forever:
    // the pending-only query in runWatchlistScan would never pick it up
    // again, and it wouldn't show as failed either — just invisible.
    if (action === 'watchlist-force-reset') {
      const { error: controlErr } = await supabaseAdmin
        .from('watchlist_control')
        .update({ is_running: false, cancel_requested: false, updated_at: new Date().toISOString() })
        .eq('id', 'global')
      if (controlErr) throw controlErr

      const { data: resetItems, error: itemsErr } = await supabaseAdmin
        .from('watchlist_items')
        .update({ status: 'pending', updated_at: new Date().toISOString() })
        .eq('status', 'scanning')
        .select('id')
      if (itemsErr) throw itemsErr

      return res.status(200).json({ message: 'Reset', itemsRequeued: resetItems?.length || 0 })
    }

    // Deletes one item outright. Blocked for 'scanning' status — that's
    // the one state where an in-flight invocation might still write back
    // to this exact row (processWatchlistItem's final status/token
    // update), so deleting it out from under that write could leave a
    // confusing half-state. pending/done/error are always safe to remove.
    if (action === 'watchlist-delete') {
      const { id } = req.body
      if (!id) return res.status(400).json({ error: 'id is required' })

      const { data: existing, error: fetchErr } = await supabaseAdmin
        .from('watchlist_items')
        .select('status')
        .eq('id', id)
        .maybeSingle()
      if (fetchErr) throw fetchErr
      if (existing?.status === 'scanning') {
        return res.status(400).json({ error: 'This item is actively being scanned right now — wait for it to finish or error out before deleting it' })
      }

      const { error: deleteErr } = await supabaseAdmin.from('watchlist_items').delete().eq('id', id)
      if (deleteErr) throw deleteErr

      return res.status(200).json({ message: 'Deleted' })
    }

    // ─── Self-hosted analytics (#5) ─────────────────────────────────────────
    // Everything computed here server-side from visitor_events, filtered
    // by time window and whether to include the owner's own browser(s).
    if (action === 'get-analytics-data') {
      const hoursBack = Number(req.body.hoursBack) || 168 // default 7 days
      const includeOwner = !!req.body.includeOwner
      const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString()

      let query = supabaseAdmin
        .from('visitor_events')
        .select('event_type, visitor_id, device_type, is_owner, properties, created_at')
        .gte('created_at', since)
        .limit(20000)
      if (!includeOwner) query = query.eq('is_owner', false)

      const { data: events, error: eventsErr } = await query
      if (eventsErr) throw eventsErr
      const rows = events || []

      const uniqueVisitorsFor = eventType => new Set(rows.filter(r => r.event_type === eventType).map(r => r.visitor_id)).size

      // Per-visitor event-type sets, built once — this is what makes the
      // funnel below a real sequential cohort instead of independent
      // per-step counts. The old version counted "anyone who did step N
      // this window," which could include a visitor who did step 1 last
      // month and step 4 this week — falsely implying they progressed
      // through the funnel within this window when the two events may be
      // completely unrelated. This version only counts a visitor at step
      // N if they're still in the cohort that made it through step N-1.
      const eventTypesByVisitor = {}
      rows.forEach(r => {
        if (!eventTypesByVisitor[r.visitor_id]) eventTypesByVisitor[r.visitor_id] = new Set()
        eventTypesByVisitor[r.visitor_id].add(r.event_type)
      })

      function sequentialFunnel(steps) {
        let cohort = null // null = no filter yet (first step)
        let prevCount = null
        return steps.map(step => {
          const qualifying = new Set()
          Object.entries(eventTypesByVisitor).forEach(([visitorId, types]) => {
            if (cohort && !cohort.has(visitorId)) return
            if (types.has(step)) qualifying.add(visitorId)
          })
          cohort = qualifying
          const count = qualifying.size
          const dropOffPct = prevCount === null || prevCount === 0 ? 0 : Math.round((1 - count / prevCount) * 1000) / 10
          prevCount = count
          return { step, uniqueVisitors: count, dropOffPct }
        })
      }

      // Main conversion funnel. zero_results_shown is deliberately NOT in
      // this list (see branchRate below) — it's a fork after
      // scan_completed, not a step on the way to signup.
      // monitoring_activated is the real finish line — an account with no
      // product_profiles row never gets scanned again, so
      // notify_me_completed alone overstates activation.
      // signup_completed (the separate direct /signup page path) isn't
      // folded in here yet — it's a materially different entry point than
      // the scan-first onboarding flow this funnel describes, and merging
      // them needs a closer look at how the two actually relate before
      // changing what this funnel measures. It still shows up in the
      // "other events" bucket below for now.
      const MAIN_FUNNEL = ['page_view', 'hero_cta_clicked', 'scan_started', 'scan_completed', 'notify_me_completed', 'monitoring_activated']
      const funnel = sequentialFunnel(MAIN_FUNNEL)

      const scanCompletedCount = uniqueVisitorsFor('scan_completed')
      const zeroResultsCount = uniqueVisitorsFor('zero_results_shown')
      const branchRate = {
        scanCompleted: scanCompletedCount,
        zeroResultsShown: zeroResultsCount,
        zeroResultsPct: scanCompletedCount === 0 ? 0 : Math.round((zeroResultsCount / scanCompletedCount) * 1000) / 10,
      }

      // Share-link sub-funnel — the /share/[token] page's own flow,
      // separate from the main funnel above (#6 ties view counts to the
      // same share_page_viewed event, per-token, in watchlist-list). Same
      // sequential-cohort fix applied here.
      const SHARE_FUNNEL = ['share_page_viewed', 'share_notify_opened', 'share_notify_submitted', 'share_notify_completed']
      const shareFunnel = sequentialFunnel(SHARE_FUNNEL)

      // Which product URLs most often show zero results — requires
      // zero_results_shown to carry a `url` property (added in
      // onboarding.js alongside this feature).
      const zeroResultUrlCounts = {}
      rows.filter(r => r.event_type === 'zero_results_shown').forEach(r => {
        const url = r.properties?.url || '(unknown — scanned before url tracking was added)'
        zeroResultUrlCounts[url] = (zeroResultUrlCounts[url] || 0) + 1
      })
      const topZeroResultUrls = Object.entries(zeroResultUrlCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([url, count]) => ({ url, count }))

      // Device breakdown — unique visitors per device type, measured off
      // page_view (the most representative baseline of real traffic,
      // rather than raw event counts which one active visitor can skew).
      const deviceCounts = {}
      const seenForDevice = new Set()
      rows.filter(r => r.event_type === 'page_view').forEach(r => {
        const key = r.visitor_id
        if (seenForDevice.has(key)) return
        seenForDevice.add(key)
        const d = r.device_type || 'unknown'
        deviceCounts[d] = (deviceCounts[d] || 0) + 1
      })

      // Any event type not already covered above.
      const coveredTypes = new Set([...MAIN_FUNNEL, ...SHARE_FUNNEL, 'zero_results_shown'])
      const otherCounts = {}
      rows.forEach(r => {
        if (coveredTypes.has(r.event_type)) return
        if (!otherCounts[r.event_type]) otherCounts[r.event_type] = { count: 0, visitors: new Set() }
        otherCounts[r.event_type].count++
        otherCounts[r.event_type].visitors.add(r.visitor_id)
      })
      const otherEvents = Object.entries(otherCounts)
        .map(([eventType, v]) => ({ eventType, count: v.count, uniqueVisitors: v.visitors.size }))
        .sort((a, b) => b.count - a.count)

      // Real recent visitor journeys — actual event sequences, not just
      // aggregate counts. Most-recently-active 20 visitors, each with
      // their events in this window in order.
      const lastSeenByVisitor = {}
      rows.forEach(r => {
        if (!lastSeenByVisitor[r.visitor_id] || new Date(r.created_at) > new Date(lastSeenByVisitor[r.visitor_id])) {
          lastSeenByVisitor[r.visitor_id] = r.created_at
        }
      })
      const recentVisitorIds = Object.entries(lastSeenByVisitor)
        .sort((a, b) => new Date(b[1]) - new Date(a[1]))
        .slice(0, 20)
        .map(([id]) => id)

      const recentJourneys = recentVisitorIds.map(visitorId => {
        const visitorEvents = rows
          .filter(r => r.visitor_id === visitorId)
          .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
          .map(r => ({ eventType: r.event_type, createdAt: r.created_at, deviceType: r.device_type, properties: r.properties }))
        return { visitorId, deviceType: visitorEvents[0]?.deviceType || 'unknown', events: visitorEvents }
      })

      // Compact data-quality indicator — honest about gaps rather than
      // hiding them. missingSessionId/missingAttribution will be nonzero
      // for any event logged before Phase 1's schema additions — that's
      // expected, not a bug, and is exactly the kind of limitation this
      // is meant to surface rather than silently paper over.
      const missingSessionId = rows.filter(r => !r.session_id).length
      const missingDeviceType = rows.filter(r => !r.device_type).length
      const duplicateGroups = {}
      rows.forEach(r => {
        const bucket = Math.floor(new Date(r.created_at).getTime() / 2000) // 2-second buckets
        const key = `${r.visitor_id}|${r.event_type}|${bucket}`
        duplicateGroups[key] = (duplicateGroups[key] || 0) + 1
      })
      const possibleDuplicates = Object.values(duplicateGroups).filter(c => c > 1).length

      const dataQuality = {
        totalEvents: rows.length,
        missingSessionId,
        missingSessionIdPct: rows.length ? Math.round((missingSessionId / rows.length) * 1000) / 10 : 0,
        missingDeviceType,
        possibleDuplicateGroups: possibleDuplicates,
        note: missingSessionId > 0
          ? 'Events with no session_id predate the session-tracking schema (Phase 1) — not an error, just unattributable to a session.'
          : null,
      }

      return res.status(200).json({
        windowHours: hoursBack,
        includeOwner,
        totalEvents: rows.length,
        funnel,
        branchRate,
        shareFunnel,
        topZeroResultUrls,
        deviceBreakdown: deviceCounts,
        otherEvents,
        recentJourneys,
        dataQuality,
      })
    }

    // ─── Visitor explorer (#4) ───────────────────────────────────────────
    // Status is computed from each visitor's own event history within the
    // window — never just "clicked signup" counting as converted (the
    // brief is explicit about this). Pagination operates on the computed
    // visitor list, not raw events, since status requires each visitor's
    // full history to determine.
    if (action === 'get-visitor-list') {
      const hoursBack = Number(req.body.hoursBack) || 168
      const includeOwner = !!req.body.includeOwner
      const search = (req.body.search || '').trim().toLowerCase()
      const statusFilter = req.body.statusFilter || null
      const page = Math.max(1, Number(req.body.page) || 1)
      const pageSize = Math.min(100, Number(req.body.pageSize) || 25)
      const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString()

      let query = supabaseAdmin
        .from('visitor_events')
        .select('visitor_id, event_type, created_at, device_type, is_owner, referrer, utm_source, auth_user_id, landing_page')
        .gte('created_at', since)
        .limit(20000)
      if (!includeOwner) query = query.eq('is_owner', false)
      const { data: events, error: eventsErr } = await query
      if (eventsErr) throw eventsErr

      const byVisitor = {}
      ;(events || []).forEach(r => {
        if (!byVisitor[r.visitor_id]) byVisitor[r.visitor_id] = []
        byVisitor[r.visitor_id].push(r)
      })

      // Resolve emails for visitors with an associated auth_user_id, in
      // one batch rather than per-visitor — search-by-email needs this.
      const authUserIds = [...new Set(Object.values(byVisitor).flat().map(r => r.auth_user_id).filter(Boolean))]
      let emailByUserId = {}
      if (authUserIds.length) {
        const { data: authUsers } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
        ;(authUsers?.users || []).forEach(u => { if (authUserIds.includes(u.id)) emailByUserId[u.id] = u.email })
      }

      const computeStatus = visitorEvents => {
        const types = new Set(visitorEvents.map(e => e.event_type))
        const sessionCount = new Set(visitorEvents.map(e => e.session_id).filter(Boolean)).size
        if (types.has('monitoring_activated')) return 'monitoring_activated'
        if (types.has('scan_completed') && !types.has('zero_results_shown')) return 'first_scan_completed'
        if (types.has('zero_results_shown')) return 'zero_result_visitor'
        if (types.has('notify_me_completed') || types.has('signup_completed')) return 'signup_completed'
        if (types.has('hero_cta_clicked') || types.has('scan_started')) return 'signup_started'
        if (sessionCount > 1) return 'returning'
        if (types.size > 1) return 'engaged'
        return 'new'
      }

      const visitors = Object.entries(byVisitor).map(([visitorId, visitorEvents]) => {
        const sorted = [...visitorEvents].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
        const authUserId = visitorEvents.find(e => e.auth_user_id)?.auth_user_id || null
        const lastSeenAt = sorted[sorted.length - 1]?.created_at
        const isInactive = Date.now() - new Date(lastSeenAt).getTime() > 7 * 24 * 60 * 60 * 1000
        return {
          visitorId,
          email: authUserId ? emailByUserId[authUserId] || null : null,
          status: isInactive && !['monitoring_activated'].includes(computeStatus(visitorEvents)) ? 'inactive' : computeStatus(visitorEvents),
          firstVisit: sorted[0]?.created_at,
          lastVisit: lastSeenAt,
          sessionCount: new Set(visitorEvents.map(e => e.session_id).filter(Boolean)).size,
          eventCount: visitorEvents.length,
          deviceType: sorted[0]?.device_type || 'unknown',
          referrer: sorted[0]?.referrer || null,
          utmSource: sorted[0]?.utm_source || null,
          landingPage: sorted[0]?.landing_page || null,
        }
      })

      let filtered = visitors
      if (statusFilter) filtered = filtered.filter(v => v.status === statusFilter)
      if (search) filtered = filtered.filter(v => v.visitorId.toLowerCase().includes(search) || (v.email || '').toLowerCase().includes(search))
      filtered.sort((a, b) => new Date(b.lastVisit) - new Date(a.lastVisit))

      const total = filtered.length
      const pageStart = (page - 1) * pageSize
      const pageItems = filtered.slice(pageStart, pageStart + pageSize)

      return res.status(200).json({ visitors: pageItems, total, page, pageSize })
    }

    // Full timeline for one visitor — human-readable event names, not
    // just raw event_type strings, and whether each milestone action
    // succeeded or failed where a confirmed outcome event exists.
    if (action === 'get-visitor-profile') {
      const { visitorId } = req.body
      if (!visitorId) return res.status(400).json({ error: 'visitorId is required' })

      const { data: events, error } = await supabaseAdmin
        .from('visitor_events')
        .select('*')
        .eq('visitor_id', visitorId)
        .order('created_at', { ascending: true })
        .limit(2000)
      if (error) throw error
      if (!events?.length) return res.status(404).json({ error: 'No events found for this visitor' })

      const EVENT_LABELS = {
        page_view: 'Viewed a page',
        hero_cta_clicked: 'Clicked the main call-to-action',
        scan_started: 'Started a scan',
        scan_completed: 'Scan completed',
        scan_failed: 'Scan failed (confirmed error)',
        zero_results_shown: 'Scan completed with zero qualified leads',
        zero_result_feedback: 'Gave feedback on a zero-result scan',
        notify_me_completed: 'Completed the notify-me signup',
        signup_completed: 'Completed account signup',
        signup_failed: 'Signup failed (confirmed error)',
        monitoring_activated: 'Activated ongoing monitoring',
        share_page_viewed: 'Viewed a shared report',
        share_notify_opened: 'Opened the share-page signup form',
        share_notify_submitted: 'Submitted the share-page signup form',
        share_notify_completed: 'Completed signup from a shared report',
        save_share_clicked: 'Clicked Save & Share',
        save_share_completed: 'Share link created',
      }

      const authUserId = events.find(e => e.auth_user_id)?.auth_user_id || null
      let email = null
      if (authUserId) {
        const { data: authUsers } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
        email = authUsers?.users?.find(u => u.id === authUserId)?.email || null
      }

      const timeline = events.map(e => ({
        eventType: e.event_type,
        label: EVENT_LABELS[e.event_type] || e.event_type,
        timestamp: e.created_at,
        page: e.path,
        device: e.device_type,
        outcome: e.event_type.endsWith('_failed') ? 'failed' : (e.event_source === 'server' ? 'confirmed' : null),
        properties: e.properties,
      }))

      return res.status(200).json({
        visitorId,
        authUserId,
        email,
        firstVisit: events[0].created_at,
        lastVisit: events[events.length - 1].created_at,
        sessionCount: new Set(events.map(e => e.session_id).filter(Boolean)).size,
        deviceType: events[0].device_type,
        referrer: events[0].referrer,
        utmSource: events[0].utm_source,
        landingPage: events[0].landing_page,
        timeline,
      })
    }

    // ─── Abandonment intelligence (#6) ───────────────────────────────────
    // Last meaningful completed action per visitor, with inactivity
    // threshold configurable (not hardcoded) and confirmed-error vs
    // inferred-abandonment kept strictly separate, per the brief.
    if (action === 'get-abandonment-data') {
      const hoursBack = Number(req.body.hoursBack) || 168
      const includeOwner = !!req.body.includeOwner
      const inactivityThresholdHours = Number(req.body.inactivityThresholdHours) || 48
      const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString()

      let query = supabaseAdmin
        .from('visitor_events')
        .select('visitor_id, event_type, created_at, device_type, referrer, utm_source')
        .gte('created_at', since)
        .limit(20000)
      if (!includeOwner) query = query.eq('is_owner', false)
      const { data: events, error } = await query
      if (error) throw error

      const byVisitor = {}
      ;(events || []).forEach(r => {
        if (!byVisitor[r.visitor_id]) byVisitor[r.visitor_id] = []
        byVisitor[r.visitor_id].push(r)
      })

      // Ordered milestones — a visitor's "last completed action" is the
      // furthest one reached, regardless of what else fired around it.
      const MILESTONES = [
        { key: 'page_view', label: 'Visited homepage but never clicked the CTA' },
        { key: 'hero_cta_clicked', label: 'Clicked CTA but never reached signup/scan' },
        { key: 'scan_started', label: 'Started a scan but it never completed' },
        { key: 'scan_completed', label: 'Completed a scan' },
        { key: 'zero_results_shown', label: 'Completed a scan with zero qualified leads' },
        { key: 'notify_me_completed', label: 'Signed up' },
        { key: 'monitoring_activated', label: 'Activated monitoring but never returned' },
      ]

      const buckets = {}
      const nowMs = Date.now()
      const inactivityMs = inactivityThresholdHours * 60 * 60 * 1000

      Object.entries(byVisitor).forEach(([visitorId, visitorEvents]) => {
        const types = new Set(visitorEvents.map(e => e.event_type))
        const lastEventAt = Math.max(...visitorEvents.map(e => new Date(e.created_at).getTime()))
        const withinThreshold = nowMs - lastEventAt < inactivityMs

        if (withinThreshold) return // still within the observation window — not abandoned yet, per the brief

        let lastMilestone = MILESTONES[0]
        for (const m of MILESTONES) { if (types.has(m.key)) lastMilestone = m }

        const hasConfirmedError = types.has('scan_failed') || types.has('signup_failed')

        const key = lastMilestone.key
        if (!buckets[key]) buckets[key] = { label: lastMilestone.label, visitors: [], confirmedErrors: 0, devices: {}, sources: {} }
        buckets[key].visitors.push(visitorId)
        if (hasConfirmedError) buckets[key].confirmedErrors++
        const device = visitorEvents[0]?.device_type || 'unknown'
        buckets[key].devices[device] = (buckets[key].devices[device] || 0) + 1
        const source = visitorEvents[0]?.utm_source || (visitorEvents[0]?.referrer ? 'referral' : 'direct')
        buckets[key].sources[source] = (buckets[key].sources[source] || 0) + 1
      })

      const totalEligible = Object.values(byVisitor).length
      const abandonment = Object.entries(buckets).map(([key, b]) => ({
        milestone: key,
        label: b.label,
        affectedVisitors: b.visitors.length,
        pctOfEligible: totalEligible ? Math.round((b.visitors.length / totalEligible) * 1000) / 10 : 0,
        confirmedErrors: b.confirmedErrors,
        inferredAbandonment: b.visitors.length - b.confirmedErrors,
        deviceBreakdown: b.devices,
        sourceBreakdown: b.sources,
        sampleVisitorIds: b.visitors.slice(0, 10),
      })).sort((a, b) => b.affectedVisitors - a.affectedVisitors)

      return res.status(200).json({ inactivityThresholdHours, totalEligible, abandonment })
    }

    // ─── Acquisition intelligence (#8) ───────────────────────────────────
    if (action === 'get-acquisition-data') {
      const hoursBack = Number(req.body.hoursBack) || 168
      const includeOwner = !!req.body.includeOwner
      const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString()

      let query = supabaseAdmin
        .from('visitor_events')
        .select('visitor_id, event_type, created_at, referrer, utm_source, session_id')
        .gte('created_at', since)
        .limit(20000)
      if (!includeOwner) query = query.eq('is_owner', false)
      const { data: events, error } = await query
      if (error) throw error

      const classifySource = (referrer, utmSource) => {
        if (utmSource) return utmSource
        if (!referrer) return 'Direct / Unknown'
        try {
          const host = new URL(referrer).hostname.replace(/^www\./, '')
          if (/twitter\.com|x\.com/.test(host)) return 'X'
          if (/google\.|bing\.|duckduckgo\./.test(host)) return 'Search'
          if (host.includes('kairo-omega.vercel.app')) return 'Internal'
          return host
        } catch {
          return 'Direct / Unknown'
        }
      }

      const byVisitor = {}
      ;(events || []).forEach(r => {
        if (!byVisitor[r.visitor_id]) byVisitor[r.visitor_id] = []
        byVisitor[r.visitor_id].push(r)
      })

      const bySource = {}
      Object.values(byVisitor).forEach(visitorEvents => {
        const first = [...visitorEvents].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0]
        const source = classifySource(first.referrer, first.utm_source)
        if (!bySource[source]) bySource[source] = { visitors: new Set(), signups: new Set(), activated: new Set(), sessions: new Set(), returning: new Set() }
        bySource[source].visitors.add(first.visitor_id)
        const types = new Set(visitorEvents.map(e => e.event_type))
        if (types.has('notify_me_completed') || types.has('signup_completed')) bySource[source].signups.add(first.visitor_id)
        if (types.has('monitoring_activated')) bySource[source].activated.add(first.visitor_id)
        const sessions = new Set(visitorEvents.map(e => e.session_id).filter(Boolean))
        sessions.forEach(s => bySource[source].sessions.add(s))
        if (sessions.size > 1) bySource[source].returning.add(first.visitor_id)
      })

      const acquisition = Object.entries(bySource).map(([source, d]) => ({
        source,
        uniqueVisitors: d.visitors.size,
        signups: d.signups.size,
        signupPct: d.visitors.size ? Math.round((d.signups.size / d.visitors.size) * 1000) / 10 : 0,
        activated: d.activated.size,
        activationPct: d.visitors.size ? Math.round((d.activated.size / d.visitors.size) * 1000) / 10 : 0,
        returningVisitors: d.returning.size,
      })).sort((a, b) => b.uniqueVisitors - a.uniqueVisitors)

      return res.status(200).json({ acquisition })
    }

    // ─── JSON export (#10) ────────────────────────────────────────────────
    // Honest limitation: this loads up to 20,000 raw events into memory
    // and returns them inline in one response — real pagination/streaming
    // for datasets larger than that doesn't exist yet. truncated: true
    // signals when the cap was hit, rather than silently dropping records
    // with no indication.
    if (action === 'export-analytics-json') {
      const hoursBack = Number(req.body.hoursBack) || 168
      const includeOwner = !!req.body.includeOwner
      const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString()
      const EXPORT_CAP = 20000

      let query = supabaseAdmin
        .from('visitor_events')
        .select('*')
        .gte('created_at', since)
        .order('created_at', { ascending: true })
        .limit(EXPORT_CAP + 1)
      if (!includeOwner) query = query.eq('is_owner', false)
      const { data: events, error } = await query
      if (error) throw error

      const truncated = (events || []).length > EXPORT_CAP
      const rawEvents = truncated ? events.slice(0, EXPORT_CAP) : (events || [])

      const byVisitor = {}
      rawEvents.forEach(r => {
        if (!byVisitor[r.visitor_id]) byVisitor[r.visitor_id] = []
        byVisitor[r.visitor_id].push(r)
      })
      const visitorProfiles = Object.entries(byVisitor).map(([visitorId, visitorEvents]) => {
        const sorted = [...visitorEvents].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
        return {
          visitorId,
          firstVisit: sorted[0]?.created_at,
          lastVisit: sorted[sorted.length - 1]?.created_at,
          eventCount: visitorEvents.length,
          deviceType: sorted[0]?.device_type,
          referrer: sorted[0]?.referrer,
          utmSource: sorted[0]?.utm_source,
        }
      })

      return res.status(200).json({
        exportMetadata: {
          exportedAt: new Date().toISOString(),
          timezone: 'UTC',
          schemaVersion: 1,
          dateRangeHours: hoursBack,
          dateRangeSince: since,
          ownerActivityIncluded: includeOwner,
          truncated,
          recordCount: rawEvents.length,
          truncationNote: truncated ? `Capped at ${EXPORT_CAP} events — narrow the date range for a complete export of a larger window.` : null,
        },
        rawEvents,
        visitorProfiles,
      })
    }

    return res.status(400).json({ error: 'Unknown action' })
  } catch (err) {
    console.error('[admin] error:', err.message)
    return res.status(500).json({ error: err.message })
  }
}
