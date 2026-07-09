// admin.js — Admin-only actions: get-admin-data, force-scan, set-plan, cleanup-old-leads
// Restricted server-side to the hardcoded admin email, regardless of any
// client-side check, since this route touches the service role key.
// All data loading goes through here too, using the service role key,
// so RLS never filters out other users' rows from the admin's view.

import { createClient } from '@supabase/supabase-js'

const ADMIN_EMAIL = 'bundepunemmanuel@gmail.com'

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // server-side only, never exposed to browser
)

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { action, requesterEmail } = req.body

  if (requesterEmail !== ADMIN_EMAIL) {
    return res.status(403).json({ error: 'Not authorized' })
  }

  try {
    // ─── Load all admin data, bypassing RLS via service role ─────────────
    if (action === 'get-admin-data') {
      const { data: allPlans } = await supabaseAdmin.from('user_plans').select('user_id, plan, updated_at')
      const { data: allProfiles } = await supabaseAdmin.from('product_profiles').select('user_id, url, analysis, created_at, last_scan_at')
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
      const churnRisk = (allProfiles || []).filter(p => {
        const settings = (settingsRows || []).find(s => s.user_id === p.user_id)
        const lastActive = settings?.last_active_at || p.created_at
        return new Date(lastActive) < new Date(sevenDaysAgo)
      })

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

    return res.status(400).json({ error: 'Unknown action' })
  } catch (err) {
    console.error('[admin] error:', err.message)
    return res.status(500).json({ error: err.message })
  }
}
