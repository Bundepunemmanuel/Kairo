// Supabase Edge Function — cron-scan
// Runs hourly via pg_cron
// For each user under their daily quota: fetch fresh Reddit posts via the
// Next.js /api/reddit proxy (fixes Reddit blocking direct Deno fetches),
// dedup against already-scored posts, score using their SAVED analysis,
// append new leads. Also refreshes each product's analysis weekly.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const NEXTJS_BASE_URL = Deno.env.get('NEXTJS_BASE_URL')! // e.g. https://kairo-omega.vercel.app

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

const PLAN_LIMITS: Record<string, number> = {
  free: 3,
  starter: 10,
  pro: 50,
  unlimited: 999999,
}

const UNLIMITED_EMAIL = 'bundepunemmanuel@gmail.com'

// ─── Reddit fetching — via Next.js proxy, NOT direct from Deno ───────────
// Reddit blocks/throttles requests from Supabase Edge Function IPs.
// The Next.js /api/reddit route already works reliably from Vercel's infra.
async function fetchSubreddit(subreddit: string) {
  try {
    const res = await fetch(
      `${NEXTJS_BASE_URL}/api/reddit?sub=${encodeURIComponent(subreddit)}&sort=new`,
      { signal: AbortSignal.timeout(15000) }
    )
    if (!res.ok) {
      console.log(`[cron-scan] reddit proxy failed for r/${subreddit}: ${res.status}`)
      return []
    }
    const xml = await res.text()
    if (!xml.includes('<entry>')) return []
    return parseAtom(xml, subreddit)
  } catch (e) {
    console.log(`[cron-scan] reddit proxy error for r/${subreddit}:`, e.message)
    return []
  }
}

function parseAtom(xml: string, subreddit: string) {
  const posts = []
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)]
  for (const m of entries) {
    const entry = m[1]
    const title = (entry.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1]
      ?.replace(/<!\[CDATA\[|\]\]>/g, '')?.trim() ?? ''
    const link = (entry.match(/<link[^>]*href="([^"]+)"/) || [])[1]?.trim() ?? ''
    const rawContent = (entry.match(/<content[^>]*>([\s\S]*?)<\/content>/) || [])[1] || ''
    const content = rawContent
      .replace(/<!\[CDATA\[|\]\]>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&[^;]{1,6};/g, ' ').replace(/<!--.*?-->/gs, '')
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600)
    const published = (entry.match(/<published>([\s\S]*?)<\/published>/) || [])[1] || ''
    if (!title || !link.includes('/comments/')) continue
    const urlParts = link.split('/')
    const commentsIdx = urlParts.indexOf('comments')
    const postId = commentsIdx !== -1 ? urlParts[commentsIdx + 1] : urlParts.filter(Boolean).pop()
    posts.push({
      id: postId || Math.random().toString(36).slice(2),
      title: title.trim(),
      body: content,
      url: link.trim(),
      subreddit,
      createdAt: published ? new Date(published).getTime() : Date.now(),
    })
  }
  return posts
}

// ─── Scoring — calls existing Next.js /api/score route ──────────────────
async function scorePosts(posts: any[], analysis: any) {
  try {
    const res = await fetch(`${NEXTJS_BASE_URL}/api/score`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ posts, analysis }),
      signal: AbortSignal.timeout(30000),
    })
    const data = await res.json()
    return { leads: data.leads || [], scoredUrls: data.scoredUrls || [] }
  } catch (e) {
    console.log('[cron-scan] score error:', e.message)
    return { leads: [], scoredUrls: [] }
  }
}

// ─── Weekly re-analyze — calls existing Next.js /api/analyze route ──────
// Refreshes name/description/subreddits so scoring stays accurate as a
// product evolves. Subreddits are no longer user-editable, so it's safe
// to overwrite the full analysis object here.
async function reanalyzeProduct(url: string) {
  try {
    const res = await fetch(`${NEXTJS_BASE_URL}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(30000),
    })
    const data = await res.json()
    return data.analysis || null
  } catch (e) {
    console.log('[cron-scan] re-analyze error:', e.message)
    return null
  }
}

// ─── Main handler ──────────────────────────────────────────────────────
Deno.serve(async (req) => {
  console.log('[cron-scan] starting run at', new Date().toISOString())

  try {
    const { data: profiles, error: profilesErr } = await supabase
      .from('product_profiles')
      .select('user_id, url, analysis, last_analyzed_at')

    if (profilesErr) throw profilesErr
    if (!profiles?.length) {
      console.log('[cron-scan] no profiles found')
      return new Response(JSON.stringify({ processed: 0 }), { status: 200 })
    }

    console.log(`[cron-scan] found ${profiles.length} profiles to check`)

    // Ensure the hardcoded unlimited account always has the right plan
    const { data: unlimitedUser } = await supabase.auth.admin.listUsers()
    const unlimitedAccount = unlimitedUser?.users?.find((u: any) => u.email === UNLIMITED_EMAIL)
    if (unlimitedAccount) {
      await supabase.from('user_plans').upsert(
        { user_id: unlimitedAccount.id, plan: 'unlimited', updated_at: new Date().toISOString() },
        { onConflict: 'user_id' }
      )
    }

    let processedCount = 0
    let skippedCount = 0
    let noPostsCount = 0
    let noLeadsCount = 0
    let allSeenCount = 0
    let insertErrorCount = 0
    const debug: any[] = []

    // Groq's free-tier limit is 8,000 tokens/minute, shared across ALL
    // calls on this account. If two users' scoring calls land in the same
    // ~60s window, the second one gets rejected outright. Staggering by
    // ~20s keeps each call in a different slice of that rolling window.
    //
    // NOTE — scaling ceiling: Supabase's free-tier Edge Functions have a
    // hard 150s wall-clock limit per run. At a 20s stagger, that leaves
    // room for roughly 7 users before the delays alone exceed the budget
    // (before counting actual fetch/score time). If you grow past ~5-6
    // users, this loop will need to move to smaller batches (e.g. a
    // separate invocation per user, or per few users) instead of one
    // single run looping through everyone.
    const STAGGER_MS = 20000
    let isFirstScoredUser = true

    for (const profile of profiles) {
      const userId = profile.user_id

      const { data: planRow } = await supabase
        .from('user_plans')
        .select('plan')
        .eq('user_id', userId)
        .single()

      const plan = planRow?.plan || 'free'
      const limit = PLAN_LIMITS[plan] ?? 3

      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      const { count } = await supabase
        .from('leads')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .gte('scanned_at', twentyFourHoursAgo)

      const leadsToday = count || 0

      if (leadsToday >= limit) {
        console.log(`[cron-scan] user ${userId} (${plan}) at quota: ${leadsToday}/${limit} — skipping`)
        skippedCount++
        continue
      }

      // Only stagger between users that actually reach a scoring call —
      // no point burning time budget delaying in front of a skip.
      if (!isFirstScoredUser) {
        console.log(`[cron-scan] waiting ${STAGGER_MS / 1000}s before next user (rate-limit spacing)`)
        await new Promise(r => setTimeout(r, STAGGER_MS))
      }
      isFirstScoredUser = false

      const remainingQuota = limit - leadsToday

      // Weekly re-analyze — refresh name/description/subreddits so scoring
      // stays accurate as the product evolves. Runs before this user's
      // scan so a freshly-updated subreddit list is used immediately.
      let analysis = profile.analysis
      const REANALYZE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000
      const lastAnalyzed = profile.last_analyzed_at ? new Date(profile.last_analyzed_at).getTime() : 0
      if (Date.now() - lastAnalyzed > REANALYZE_INTERVAL_MS) {
        console.log(`[cron-scan] user ${userId}: re-analyzing product (last analyzed ${profile.last_analyzed_at || 'never'})`)
        const freshAnalysis = await reanalyzeProduct(profile.url)
        if (freshAnalysis) {
          analysis = freshAnalysis
          await supabase
            .from('product_profiles')
            .update({ analysis: freshAnalysis, last_analyzed_at: new Date().toISOString() })
            .eq('user_id', userId)
          console.log(`[cron-scan] user ${userId}: analysis refreshed`)
        } else {
          console.log(`[cron-scan] user ${userId}: re-analyze failed, using existing analysis`)
        }
      }

      const subreddits = (analysis.subreddits || []).slice(0, 6)
      const postArrays = await Promise.all(subreddits.map(fetchSubreddit))
      const filteredArrays = postArrays.map((arr: any[]) =>
        arr.filter((p: any) => p.body && p.body.length > 40 && !p.body.includes('[comments]'))
      )

      // Dedup — skip any post already sent to an AI for scoring before,
      // regardless of whether it qualified as a lead. This was the single
      // biggest source of wasted tokens: the same posts were being
      // re-scored every run since Reddit's "new" feed doesn't fully
      // refresh every 30-60 minutes on smaller subreddits.
      const { data: seenRows } = await supabase
        .from('seen_posts')
        .select('post_url')
        .eq('user_id', userId)
      const seenUrls = new Set((seenRows || []).map((r: any) => r.post_url))
      const freshArrays = filteredArrays.map((arr: any[]) => arr.filter((p: any) => !seenUrls.has(p.url)))

      // Round-robin interleave across subreddits (one post from sub A, one
      // from sub B, one from sub C... then back to A) instead of
      // concatenating in order. Otherwise, when we only score the first N
      // posts downstream, whichever subreddit is listed first silently
      // hogs every scoring slot and the rest are never evaluated at all.
      const allPosts: any[] = []
      const maxLen = Math.max(0, ...freshArrays.map(a => a.length))
      for (let i = 0; i < maxLen; i++) {
        for (const arr of freshArrays) {
          if (arr[i]) allPosts.push(arr[i])
        }
      }

      const totalFetched = filteredArrays.reduce((sum, arr) => sum + arr.length, 0)
      console.log(`[cron-scan] user ${userId}: fetched ${totalFetched} posts, ${allPosts.length} genuinely new across ${subreddits.length} subreddits`)

      if (!totalFetched) {
        console.log(`[cron-scan] user ${userId}: no posts fetched`)
        noPostsCount++
        debug.push({ userId, reason: 'no_posts_fetched', subreddits, nextjsBaseUrl: NEXTJS_BASE_URL })
        continue
      }

      if (!allPosts.length) {
        console.log(`[cron-scan] user ${userId}: ${totalFetched} posts fetched, all already scored before — nothing new`)
        noPostsCount++
        debug.push({ userId, reason: 'all_posts_already_seen', totalFetched })
        continue
      }

      const { leads: scoredLeads, scoredUrls } = await scorePosts(allPosts, analysis)

      // Record every post actually sent to scoring as seen — whether it
      // qualified as a lead or not — so it's never re-scored again.
      if (scoredUrls.length) {
        const { error: seenErr } = await supabase
          .from('seen_posts')
          .upsert(
            scoredUrls.map((url: string) => ({ user_id: userId, post_url: url })),
            { onConflict: 'user_id,post_url', ignoreDuplicates: true }
          )
        if (seenErr) console.log(`[cron-scan] user ${userId}: seen_posts write error:`, seenErr.message)
      }

      if (!scoredLeads.length) {
        console.log(`[cron-scan] user ${userId}: no qualifying leads this run`)
        noLeadsCount++
        debug.push({ userId, reason: 'no_qualifying_leads', postsScanned: allPosts.length })
        continue
      }

      const leadsToInsert = scoredLeads.slice(0, remainingQuota)

      const { data: existingLeads } = await supabase
        .from('leads')
        .select('post_id')
        .eq('user_id', userId)

      const existingIds = new Set((existingLeads || []).map((l: any) => l.post_id))
      const newLeads = leadsToInsert.filter((lead: any) => !existingIds.has(lead.id || lead.url))

      if (!newLeads.length) {
        console.log(`[cron-scan] user ${userId}: all leads already seen, no new inserts`)
        allSeenCount++
        debug.push({ userId, reason: 'all_leads_already_seen', scoredCount: leadsToInsert.length })
        continue
      }

      const { error: insertErr } = await supabase.from('leads').insert(
        newLeads.map((lead: any) => ({
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
          deleted: false,
          replied: false,
        }))
      )

      if (insertErr) {
        console.log(`[cron-scan] user ${userId} insert error:`, insertErr.message)
        insertErrorCount++
        debug.push({ userId, reason: 'insert_error', message: insertErr.message })
        continue
      }

      console.log(`[cron-scan] user ${userId} (${plan}): added ${newLeads.length} new leads (${leadsToday + newLeads.length}/${limit} today)`)
      processedCount++
    }

    console.log(`[cron-scan] run complete: ${processedCount} processed, ${skippedCount} skipped (quota)`)

    return new Response(
      JSON.stringify({
        processed: processedCount,
        skipped: skippedCount,
        total: profiles.length,
        noPostsFetched: noPostsCount,
        noQualifyingLeads: noLeadsCount,
        allLeadsAlreadySeen: allSeenCount,
        insertErrors: insertErrorCount,
        debug,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    console.error('[cron-scan] fatal error:', err.message)
    return new Response(JSON.stringify({ error: err.message }), { status: 500 })
  }
})
