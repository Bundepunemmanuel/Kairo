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

// ─── Shared Reddit quota wait ────────────────────────────────────────────
// Reddit enforces a real, numeric, per-IP rate limit — roughly one request
// per ~30-60 second reset window, shared across the ENTIRE app, not just
// this cron run. /api/reddit.js persists the latest X-Ratelimit-Reset (as
// an absolute timestamp) to reddit_rate_limit on every response it
// handles, anywhere in the app. Reading it here directly via the
// service-role client already in scope — no extra HTTP hop through the
// Next.js app just to ask what it already wrote to the same database.
async function waitForRedditQuota() {
  const { data, error } = await supabase
    .from('reddit_rate_limit')
    .select('reset_at')
    .eq('id', 'global')
    .maybeSingle()

  if (error) {
    console.log('[cron-scan] reddit_rate_limit read error (proceeding without a wait):', error.message)
    return
  }
  if (!data?.reset_at) return // nothing persisted yet — first run ever, or reddit.js hasn't been hit since deploy

  const waitMs = new Date(data.reset_at).getTime() - Date.now()
  if (waitMs <= 0) return // already past reset

  // Capped so one stale or implausibly-far-future reset value can't stall
  // a whole batch past Supabase's 150s execution ceiling — 60s already
  // covers the upper end of the real window (~30-60s), so this cap should
  // only ever bind on bad data, not a genuine wait.
  const cappedWaitMs = Math.min(waitMs, 60000)
  console.log(`[cron-scan] waiting ${Math.ceil(cappedWaitMs / 1000)}s for Reddit's shared quota to reset`)
  await new Promise(r => setTimeout(r, cappedWaitMs))
}

// ─── Reddit fetching — via Next.js proxy, NOT direct from Deno ───────────
// Reddit blocks/throttles requests from Supabase Edge Function IPs.
// The Next.js /api/reddit route already works reliably from Vercel's infra.
// `subreddit` may be several names joined with "+" — a Reddit multireddit,
// one combined request instead of one per subreddit (see the main handler
// below), matching onboarding.js / share/[token].js.
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

function parseAtom(xml: string, defaultSubreddit: string) {
  const posts = []
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)]
  for (const m of entries) {
    const entry = m[1]
    const title = (entry.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1]
      ?.replace(/<!\[CDATA\[|\]\]>/g, '')?.trim() ?? ''
    const link = (entry.match(/<link[^>]*href="([^"]+)"/) || [])[1]?.trim() ?? ''
    // Each entry carries its own subreddit via <category term="...">,
    // which matters now that fetchSubreddit may be called with several
    // subreddits joined by "+" (one combined multireddit request) — a
    // single defaultSubreddit would be wrong for most entries in that
    // case. Falls back to defaultSubreddit only if the tag is ever
    // missing. Matches onboarding.js / share/[token].js.
    const subreddit = (entry.match(/<category term="([^"]+)"/) || [])[1] || defaultSubreddit
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
    // isFallback means all 3 models failed and this is just a generic
    // placeholder — never let that overwrite a perfectly good existing
    // analysis. Treat it the same as a failed re-analyze.
    if (data.isFallback) {
      console.log('[cron-scan] re-analyze returned a fallback (all models failed) — keeping existing analysis')
      return null
    }
    return data.analysis || null
  } catch (e) {
    console.log('[cron-scan] re-analyze error:', e.message)
    return null
  }
}

// Phrases that indicate a subreddit bans vendor/promotional replies —
// checked against the subreddit's combined rules text + public
// description. Intentionally broad; a false positive here just means an
// extra subreddit writes plug-free replies, which is a safe failure mode.
// A false negative (missing a real ban) risks a removed comment instead.
const NO_PITCH_PHRASES = [
  'no self promo', 'no self-promo', 'no promotion', 'no advertising',
  'no vendor', 'no soliciting', 'no selling', 'vendor spam',
  'no ai content', 'no low effort', 'no low-effort',
  "i'll review your product", 'no marketing', 'sticky thread only',
  'stickied thread', 'no link dropping', 'no links to your',
]

const RULES_CACHE_DAYS = 30

// Auto-detects whether a subreddit bans self-promotion, caching the
// result for 30 days so we're not re-fetching rules on every run. Seeds
// from real evidence (r/SaaS, r/loseit, etc. all confirmed via actual
// removals or explicit posted rules) rather than a hardcoded guess list —
// this scales to any subreddit Kairo ever touches, not just the ones a
// user happens to notice a removal in.
async function checkSubredditRules(sub: string) {
  try {
    const { data: existing } = await supabase
      .from('subreddit_rules')
      .select('checked_at')
      .eq('subreddit', sub.toLowerCase())
      .single()

    if (existing?.checked_at) {
      const ageMs = Date.now() - new Date(existing.checked_at).getTime()
      if (ageMs < RULES_CACHE_DAYS * 24 * 60 * 60 * 1000) {
        return // cached and still fresh, nothing to do
      }
    }

    const res = await fetch(
      `${NEXTJS_BASE_URL}/api/reddit?sub=${encodeURIComponent(sub)}&mode=rules`,
      { signal: AbortSignal.timeout(15000) }
    )
    const data = await res.json()
    const rulesText = (data.rulesText || '').toLowerCase()
    const noPitch = NO_PITCH_PHRASES.some(phrase => rulesText.includes(phrase))

    // Real evidence instead of a silent guess — if rulesText comes back
    // empty or suspiciously short, this tells us exactly which upstream
    // call failed (and how) rather than defaulting to no_pitch: false
    // with no way to tell if that's because the subreddit genuinely has
    // no restrictions, or because the fetch itself was blocked.
    console.log(`[cron-scan] r/${sub} rules check: rulesStatus=${data.rulesStatus}, aboutStatus=${data.aboutStatus}, textLength=${rulesText.length}${data.errorMessage ? ', error=' + data.errorMessage : ''}`)

    await supabase.from('subreddit_rules').upsert(
      {
        subreddit: sub.toLowerCase(),
        no_pitch: noPitch,
        raw_rules_text: rulesText.slice(0, 2000),
        checked_at: new Date().toISOString(),
      },
      { onConflict: 'subreddit' }
    )

    if (noPitch) {
      console.log(`[cron-scan] r/${sub}: detected as no-pitch subreddit`)
    }
  } catch (e) {
    console.log(`[cron-scan] rules check error for r/${sub}:`, e.message)
    // Fail quiet — a missed rules-refresh just means we use whatever's
    // already cached (or no entry at all, which reply.js treats as safe
    // to pitch). Not worth failing the whole scan over.
  }
}

// ─── Main handler ──────────────────────────────────────────────────────
Deno.serve(async (req) => {
  console.log('[cron-scan] starting run at', new Date().toISOString())

  try {
    const { data: profiles, error: profilesErr } = await supabase
      .from('product_profiles')
      .select('user_id, url, analysis, last_analyzed_at, last_cron_attempt_at')

    if (profilesErr) throw profilesErr
    if (!profiles?.length) {
      console.log('[cron-scan] no profiles found')
      return new Response(JSON.stringify({ processed: 0 }), { status: 200 })
    }

    console.log(`[cron-scan] found ${profiles.length} profiles to check`)

    // ── Batching ──────────────────────────────────────────────────────
    // Only take a small batch per invocation, so we never risk hitting
    // Supabase's 150s function-execution ceiling as user count grows.
    // pg_cron triggers hourly as the main entrypoint; if users remain
    // unprocessed after this batch, we dynamically schedule a one-time
    // follow-up run ~2 minutes out via schedule_followup_batch(), which
    // repeats until the whole hour's queue is empty.
    //
    // Dropped from 3 to 2: waitForRedditQuota() (below) now waits for
    // Reddit's real reset before every user's fetch — capped at 60s, but
    // genuinely up to that long — instead of the old flat 20s stagger. A
    // batch of 3 could have two such waits back-to-back (worst case 120s)
    // plus three users' worth of actual fetch+scoring time on top, which
    // risks the 150s ceiling outright. A batch of 2 has at most one real
    // wait (worst case 60s), leaving comfortable room. If per-user work
    // time grows later (e.g. pass-1 relevance scoring in score.js adding a
    // second AI call per user), re-check this math before raising it back.
    const BATCH_SIZE = 2
    const now = new Date()
    const startOfHour = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours())

    const notYetAttemptedThisHour = profiles.filter((p: any) => {
      if (!p.last_cron_attempt_at) return true
      return new Date(p.last_cron_attempt_at) < startOfHour
    })

    // Oldest-attempted-first, so no one gets starved indefinitely if the
    // user count ever grows past what a single hour's batches can cover.
    notYetAttemptedThisHour.sort((a: any, b: any) => {
      const aTime = a.last_cron_attempt_at ? new Date(a.last_cron_attempt_at).getTime() : 0
      const bTime = b.last_cron_attempt_at ? new Date(b.last_cron_attempt_at).getTime() : 0
      return aTime - bTime
    })

    const batch = notYetAttemptedThisHour.slice(0, BATCH_SIZE)
    const remainingAfterThisBatch = notYetAttemptedThisHour.length - batch.length

    if (!batch.length) {
      console.log('[cron-scan] all profiles already attempted this hour — nothing to do')
      return new Response(JSON.stringify({ processed: 0, message: 'all done this hour' }), { status: 200 })
    }

    console.log(`[cron-scan] processing batch of ${batch.length} (${remainingAfterThisBatch} remaining this hour)`)

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

    for (const profile of batch) {
      const userId = profile.user_id

      // Stamp immediately, before any work — so if this profile throws
      // partway through, it doesn't get retried infinitely within the
      // same hour's batches. Worst case: it's skipped until next hour,
      // not stuck in a crash loop eating every batch slot.
      await supabase
        .from('product_profiles')
        .update({ last_cron_attempt_at: new Date().toISOString() })
        .eq('user_id', userId)

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

      // Wait for Reddit's actual shared quota to reset before this user's
      // fetch — not just between users within this batch, but ALSO before
      // the very first one. The quota is shared across the whole app (any
      // visitor's browser scan, any share-page notify, could have used it
      // moments ago), so "first user in this batch" isn't the same thing
      // as "quota is definitely open." waitForRedditQuota() resolves
      // immediately when the persisted reset is already in the past (the
      // common case), so this costs nothing extra when the quota's genuinely
      // free. This also comfortably covers whatever spacing Groq's scoring
      // calls still need from each other — the real reset wait is rarely
      // shorter than the old flat 20s stagger, and often longer.
      await waitForRedditQuota()

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

      // One combined multireddit request for this user's whole subreddit
      // list, instead of fetching each one separately — same treatment
      // onboarding.js / share/[token].js already got. The old
      // one-at-a-time loop cost up to 6 Reddit requests per user, with
      // waitForRedditQuota() (above) meaning every one of those beyond the
      // first would otherwise sit through its own ~30-60s reset wait; the
      // shared quota only reliably affords one request anyway, so this
      // spends it on a single request that comes back with everything
      // instead of 5 that are doomed before they're even sent.
      const combinedPosts = subreddits.length ? await fetchSubreddit(subreddits.join('+')) : []
      // parseAtom tags each entry with its own subreddit via <category>
      // (see parseAtom above), so split the merged response back out per
      // subreddit here — downstream code (filteredArrays, freshArrays, the
      // round-robin interleave below) still expects one array per
      // subreddit, same shape as before batching.
      const postArrays: any[][] = subreddits.map((sub: string) =>
        combinedPosts.filter((p: any) => p.subreddit === sub)
      )

      // Rules-checking is unrelated to the feed fetch above — different
      // Reddit endpoints (about.json / about/rules.json) — and still needs
      // its own per-subreddit request whenever its 30-day cache is stale,
      // so it keeps its own loop and pacing rather than riding along with
      // the now-batched feed fetch. NOTE: this still means a run touching
      // several stale subreddits can burn more than the one request the
      // shared quota reliably affords in a single window — out of scope
      // for this pass (not what waitForRedditQuota/batching above were
      // asked to fix), but worth knowing if 429s show up here specifically
      // in the logs rather than on the feed fetch.
      const FETCH_PAUSE_MS = 1500
      for (let i = 0; i < subreddits.length; i++) {
        const sub = subreddits[i]
        // Auto-detect this subreddit's no-pitch rules, cached for 30 days
        // so we're not re-fetching rules on every single run. reply.js
        // reads the result from subreddit_rules when drafting a reply.
        await checkSubredditRules(sub)

        if (i < subreddits.length - 1) {
          await new Promise(r => setTimeout(r, FETCH_PAUSE_MS))
        }
      }

      // ─── Karma-building (separate from lead pipeline, no pacing guard) ──
      // Job 1: this user's top lead-generating subreddit, reusing posts
      // already fetched above — no extra Reddit requests for this part.
      // Job 2: a fixed list of 5 generic high-traffic subs — these DO need
      // their own fetch since they're outside the user's normal monitored
      // list. Runs on the same hourly cron pass, no dedicated tight poll.
      //
      // KNOWN COST: Job 2 fetches the same 5 subs freshly for every user,
      // every run — with 5 users that's 25 extra Reddit requests/hour for
      const filteredArrays = postArrays.map((arr: any[]) =>
        arr.filter((p: any) => p.body && p.body.length > 40)
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

      // Fire-and-forget push notification — one per new lead, per user's
      // choice ("every new lead, no matter the score"). Never let a push
      // failure affect the scan result itself; log and move on.
      try {
        const pushRes = await fetch(`${NEXTJS_BASE_URL}/api/send-push`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, leads: newLeads }),
          signal: AbortSignal.timeout(15000),
        })
        const pushData = await pushRes.json()
        if (pushData.sent) console.log(`[cron-scan] user ${userId}: sent ${pushData.sent} push notification(s)`)
      } catch (e) {
        console.log(`[cron-scan] user ${userId}: push notification error (non-fatal):`, e.message)
      }
    }

    console.log(`[cron-scan] run complete: ${processedCount} processed, ${skippedCount} skipped (quota)`)

    // If more users still need processing this hour, schedule a one-time
    // follow-up batch ~2 minutes from now. Reuses the same job name every
    // time (schedule_followup_batch upserts it), so this naturally
    // replaces itself each call rather than piling up duplicate jobs —
    // no separate cleanup step needed.
    if (remainingAfterThisBatch > 0) {
      const nextRunAt = new Date(Date.now() + 2 * 60 * 1000)
      console.log(`[cron-scan] ${remainingAfterThisBatch} users remain this hour — scheduling follow-up batch at ${nextRunAt.toISOString()}`)
      const { error: scheduleErr } = await supabase.rpc('schedule_followup_batch', {
        target_url: `${SUPABASE_URL}/functions/v1/cron-scan`,
        auth_header: `Bearer ${SERVICE_ROLE_KEY}`,
        run_at: nextRunAt.toISOString(),
      })
      if (scheduleErr) console.log('[cron-scan] failed to schedule follow-up batch:', scheduleErr.message)
    } else {
      console.log('[cron-scan] no users remaining this hour — done until next hourly trigger')
    }

    return new Response(
      JSON.stringify({
        processed: processedCount,
        skipped: skippedCount,
        total: profiles.length,
        batchSize: batch.length,
        remainingThisHour: remainingAfterThisBatch,
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
