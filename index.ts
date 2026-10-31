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
//
// source distinguishes which quota bucket to wait on — 'direct' (this
// app's own egress, row id 'direct'), 'worker' (the live-traffic
// Cloudflare Worker's separate IP, row id 'worker'), or 'watchlist-worker'
// (the admin batch's own dedicated Worker, row id 'watchlist-worker') —
// three independent buckets, not one shared one, since the whole point of
// each worker is that it resets on its own clock. Waiting on the wrong
// one would either wait too long (checking 'direct' before a worker-
// routed fetch) or not long enough (checking nothing at all).
async function waitForRedditQuota(source: 'direct' | 'worker' | 'watchlist-worker' = 'direct') {
  const { data, error } = await supabase
    .from('reddit_rate_limit')
    .select('reset_at')
    .eq('id', source)
    .maybeSingle()

  if (error) {
    console.log(`[cron-scan] reddit_rate_limit[${source}] read error (proceeding without a wait):`, error.message)
    return
  }
  if (!data?.reset_at) return // nothing persisted yet for this bucket — first run ever, or that path hasn't been hit since deploy

  const waitMs = new Date(data.reset_at).getTime() - Date.now()
  if (waitMs <= 0) return // already past reset

  // Capped so one stale or implausibly-far-future reset value can't stall
  // a whole batch past Supabase's 150s execution ceiling — 60s already
  // covers the upper end of the real window (~30-60s), so this cap should
  // only ever bind on bad data, not a genuine wait.
  const cappedWaitMs = Math.min(waitMs, 60000)
  console.log(`[cron-scan] waiting ${Math.ceil(cappedWaitMs / 1000)}s for [${source}] Reddit quota to reset`)
  await new Promise(r => setTimeout(r, cappedWaitMs))
}

// ─── Reddit fetching — via Next.js proxy, NOT direct from Deno ───────────
// Reddit blocks/throttles requests from Supabase Edge Function IPs.
// The Next.js /api/reddit route already works reliably from Vercel's infra.
// `subreddit` may be several names joined with "+" — a Reddit multireddit,
// one combined request instead of one per subreddit (see the main handler
// below), matching onboarding.js / share/[token].js.
//
// source='direct' (default), 'worker', or 'watchlist-worker' — passed
// straight through to /api/reddit.js's own source param, which decides
// whether that request goes to Reddit directly or through one of the two
// Cloudflare Worker proxies. The caller (the main handler, or
// runWatchlistScan below) is what decides which subreddits go through
// which path.
async function fetchSubreddit(subreddit: string, source: 'direct' | 'worker' | 'watchlist-worker' = 'direct') {
  try {
    const res = await fetch(
      `${NEXTJS_BASE_URL}/api/reddit?sub=${encodeURIComponent(subreddit)}&sort=new&source=${source}`,
      { signal: AbortSignal.timeout(15000) }
    )
    if (!res.ok) {
      console.log(`[cron-scan] [${source}] reddit proxy failed for r/${subreddit}: ${res.status}`)
      return []
    }
    const xml = await res.text()
    if (!xml.includes('<entry>')) return []
    return parseAtom(xml, subreddit)
  } catch (e) {
    console.log(`[cron-scan] [${source}] reddit proxy error for r/${subreddit}:`, e.message)
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
// includeCloseMatches defaults to false, matching the main loop's existing
// behavior exactly (it only ever wanted qualified leads). The watchlist
// batch (runWatchlistScan below) passes true, same as onboarding.js does,
// since save-share.js's `leads` array is meant to hold everything (qualified
// + close), with qualified-vs-close filtering happening at display/count
// time, not at save time.
async function scorePosts(posts: any[], analysis: any, includeCloseMatches = false) {
  try {
    const res = await fetch(`${NEXTJS_BASE_URL}/api/score`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ posts, analysis, includeCloseMatches }),
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

// ─── Daily maintenance (#5 hold system, #6 push engagement sweep) ───────
// Both pieces are daily, inactivity-themed, and cheap (no Reddit calls, no
// AI calls) — kept in one function triggered by one daily cron entry
// rather than two, but the two jobs below are independent of each other:
// neither reads the other's output, and either can be edited without
// touching the other.
async function runDailyMaintenance() {
  console.log('[cron-scan:daily] starting daily maintenance at', new Date().toISOString())
  const holdResult = await holdInactiveAccounts()
  const pushResult = await sweepPushEngagement()
  console.log('[cron-scan:daily] complete —', JSON.stringify({ hold: holdResult, push: pushResult }))
  return new Response(JSON.stringify({ hold: holdResult, push: pushResult }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

// ── #5: hold accounts inactive 7+ days ──────────────────────────────────
// Only HOLDS here — never releases. Release is always a deliberate action
// (the dashboard's Resume button, or the admin toggle), never automatic,
// since silently un-holding someone the moment a date rolls over could
// resume burning their AI quota without anyone deciding that should
// happen. held_at is set once, on the hold itself, so it reflects when
// the hold actually started rather than being re-derived from
// last_active_at (which keeps moving and would make "how long have they
// been held" impossible to answer later).
async function holdInactiveAccounts() {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

    const { data: inactiveSettings, error: settingsErr } = await supabase
      .from('user_settings')
      .select('user_id, last_active_at')
      .lt('last_active_at', sevenDaysAgo)

    if (settingsErr) {
      console.log('[cron-scan:daily:hold] read error:', settingsErr.message)
      return { held: 0, error: settingsErr.message }
    }
    if (!inactiveSettings?.length) return { held: 0 }

    const inactiveUserIds = inactiveSettings.map((s: any) => s.user_id)

    // Only touch profiles that aren't already held — re-updating an
    // already-held row would reset held_at every single day they stay
    // inactive, which breaks "how long has this account been held" for
    // both the dashboard banner and the admin view.
    const { data: toHold, error: profilesErr } = await supabase
      .from('product_profiles')
      .select('user_id')
      .in('user_id', inactiveUserIds)
      .eq('is_held', false)

    if (profilesErr) {
      console.log('[cron-scan:daily:hold] profiles read error:', profilesErr.message)
      return { held: 0, error: profilesErr.message }
    }
    if (!toHold?.length) return { held: 0 }

    const { error: updateErr } = await supabase
      .from('product_profiles')
      .update({ is_held: true, held_at: new Date().toISOString() })
      .in('user_id', toHold.map((p: any) => p.user_id))

    if (updateErr) {
      console.log('[cron-scan:daily:hold] update error:', updateErr.message)
      return { held: 0, error: updateErr.message }
    }

    console.log(`[cron-scan:daily:hold] held ${toHold.length} account(s) inactive 7+ days`)
    return { held: toHold.length }
  } catch (e: any) {
    console.log('[cron-scan:daily:hold] fatal:', e.message)
    return { held: 0, error: e.message }
  }
}

// ── #6: warn then delete push subscriptions for inactive passwordless
// accounts ─────────────────────────────────────────────────────────────
// Scoped specifically to accounts created via capture-lead.js
// (product_profiles.password_set = false) — a user who set a real
// password opted into the product deliberately and keeps their push
// subscription regardless of how long they've gone without opening one.
// A separate trigger from #5 on purpose: #5 counts user_settings.
// last_active_at (dashboard visits), but a passwordless user may never
// open the dashboard at all — they only ever interact via push. So this
// counts push_subscriptions.last_opened_at (or last_sent_at if never
// opened) instead, and only even starts the clock once a push has
// actually been sent — a user who's received zero notifications so far
// (no leads yet) isn't "ignoring" anything.
async function sweepPushEngagement() {
  try {
    const { data: passwordlessProfiles, error: profilesErr } = await supabase
      .from('product_profiles')
      .select('user_id')
      .eq('password_set', false)

    if (profilesErr) {
      console.log('[cron-scan:daily:push] profiles read error:', profilesErr.message)
      return { warned: 0, deleted: 0, error: profilesErr.message }
    }
    if (!passwordlessProfiles?.length) return { warned: 0, deleted: 0 }

    const passwordlessUserIds = passwordlessProfiles.map((p: any) => p.user_id)

    const { data: subs, error: subsErr } = await supabase
      .from('push_subscriptions')
      .select('id, user_id, endpoint, p256dh, auth_key, last_sent_at, last_opened_at, warned_at')
      .in('user_id', passwordlessUserIds)
      .not('last_sent_at', 'is', null) // never sent anything yet — nothing to be "ignoring"

    if (subsErr) {
      console.log('[cron-scan:daily:push] subscriptions read error:', subsErr.message)
      return { warned: 0, deleted: 0, error: subsErr.message }
    }
    if (!subs?.length) return { warned: 0, deleted: 0 }

    const sixDaysAgo = Date.now() - 6 * 24 * 60 * 60 * 1000
    const oneDayAgo = Date.now() - 1 * 24 * 60 * 60 * 1000

    const toWarn: any[] = []
    const toDelete: any[] = []

    for (const sub of subs) {
      // Baseline for "last engaged" — last_opened_at if they've ever
      // opened one, otherwise last_sent_at (the first push they were ever
      // sent, since that's the only thing we know happened).
      const lastEngaged = sub.last_opened_at || sub.last_sent_at
      const lastEngagedMs = new Date(lastEngaged).getTime()

      if (!sub.warned_at) {
        // Not warned yet — Day 6 check.
        if (lastEngagedMs < sixDaysAgo) toWarn.push(sub)
      } else {
        // Already warned — Day 7 check. Only deletes if they genuinely
        // haven't opened anything SINCE the warning went out (opening an
        // older push before the warning doesn't count) and the warning
        // itself is at least a day old, so Day 6 and Day 7 are always
        // distinct runs, never the same day.
        const openedSinceWarning = sub.last_opened_at && new Date(sub.last_opened_at).getTime() > new Date(sub.warned_at).getTime()
        const warnedAtMs = new Date(sub.warned_at).getTime()
        if (!openedSinceWarning && warnedAtMs < oneDayAgo) toDelete.push(sub)
      }
    }

    let warned = 0
    if (toWarn.length) {
      try {
        const warnRes = await fetch(`${NEXTJS_BASE_URL}/api/send-push`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // One batched call — send-push.js's 'send-custom' action (new,
          // see that file) sends the same message to every subscription
          // id given, and stamps last_sent_at + warned_at on each on
          // success, rather than this function reaching into
          // push_subscriptions directly to do that bookkeeping itself.
          body: JSON.stringify({
            action: 'send-custom',
            subscriptionIds: toWarn.map((s: any) => s.id),
            title: 'Still there?',
            body: "We've been sending you leads but haven't seen you open one in a while — we'll stop in a day if that doesn't change.",
            url: 'https://kairo-omega.vercel.app/dashboard',
            markWarned: true,
          }),
          signal: AbortSignal.timeout(15000),
        })
        const warnData = await warnRes.json()
        warned = warnData.sent || 0
      } catch (e: any) {
        console.log('[cron-scan:daily:push] warning send error (non-fatal):', e.message)
      }
    }

    let deleted = 0
    if (toDelete.length) {
      const { error: deleteErr, count } = await supabase
        .from('push_subscriptions')
        .delete({ count: 'exact' })
        .in('id', toDelete.map((s: any) => s.id))
      if (deleteErr) {
        console.log('[cron-scan:daily:push] delete error:', deleteErr.message)
      } else {
        deleted = count || 0
      }
    }

    console.log(`[cron-scan:daily:push] warned ${warned}, deleted ${deleted} (checked ${subs.length} passwordless subscriptions)`)
    return { warned, deleted }
  } catch (e: any) {
    console.log('[cron-scan:daily:push] fatal:', e.message)
    return { warned: 0, deleted: 0, error: e.message }
  }
}

// ─── Admin X-lead watchlist batch (#4) ───────────────────────────────────
// Routed here by ?task=watchlist-scan, triggered by the admin panel's Run
// button (via schedule_watchlist_followup with run_at a few seconds out —
// see pages/api/admin.js's 'watchlist-run' action) and then self-
// scheduling its own follow-up slices the same way, under its own pg_cron
// job name, deliberately separate from the main loop's own
// schedule_followup_batch/job name below.
//
// Mirrors the main loop's own direct/worker split (see the subreddit
// split comment further down in Deno.serve), but swaps the live-traffic
// 'worker' bucket for the dedicated 'watchlist-worker' bucket — the whole
// point being this batch never competes with real visitors for the
// 'worker' quota. It only shares 'direct' with live traffic, which is
// unavoidable (single Vercel egress IP).
//
// Self-reschedules via schedule_watchlist_followup (see phase2-schema.sql),
// a dedicated RPC scheduled under its own pg_cron job name
// ('kairo-watchlist-followup') rather than reusing schedule_followup_batch
// — that RPC's own comment elsewhere in this file says it "upserts" its
// job, which would mean a single fixed job name shared across every
// caller. Two self-rescheduling chains (this one and the main loop below)
// both landing on that one name around the same time could silently
// overwrite each other's pending follow-up. schedule_watchlist_followup
// sidesteps that entirely by never touching whatever name the original
// RPC uses.
const WATCHLIST_BATCH_SIZE = 3

async function runWatchlistScan(): Promise<Response> {
  console.log('[watchlist-scan] starting slice at', new Date().toISOString())

  try {
    const { data: control } = await supabase
      .from('watchlist_control')
      .select('cancel_requested')
      .eq('id', 'global')
      .maybeSingle()

    if (control?.cancel_requested) {
      console.log('[watchlist-scan] cancel_requested was set before this slice started — stopping, not processing anything')
      await supabase.from('watchlist_control').update({ is_running: false, cancel_requested: false, updated_at: new Date().toISOString() }).eq('id', 'global')
      return new Response(JSON.stringify({ cancelled: true, processed: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    const { data: pendingItems, error: pendingErr } = await supabase
      .from('watchlist_items')
      .select('id, product_url, x_post_url')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(WATCHLIST_BATCH_SIZE)

    if (pendingErr) throw pendingErr

    if (!pendingItems?.length) {
      console.log('[watchlist-scan] no pending items — marking not running')
      await supabase.from('watchlist_control').update({ is_running: false, updated_at: new Date().toISOString() }).eq('id', 'global')
      return new Response(JSON.stringify({ processed: 0, message: 'queue empty' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    let processed = 0
    let cancelledMidSlice = false

    for (let i = 0; i < pendingItems.length; i++) {
      // Checked before EVERY item, not just once at the top of this
      // invocation — a cancel requested while item 1 of 3 was still
      // mid-flight must not let items 2 and 3 start, but must also never
      // abort item 1 itself partway through (that's what "not just the
      // start" + "doesn't leave an item half-processed" both require).
      const { data: freshControl } = await supabase
        .from('watchlist_control')
        .select('cancel_requested')
        .eq('id', 'global')
        .maybeSingle()
      if (freshControl?.cancel_requested) {
        console.log(`[watchlist-scan] cancel detected before item ${i + 1}/${pendingItems.length} — stopping this slice here`)
        cancelledMidSlice = true
        break
      }

      const item = pendingItems[i]
      await processWatchlistItem(item)
      processed++
    }

    if (cancelledMidSlice) {
      await supabase.from('watchlist_control').update({ is_running: false, cancel_requested: false, updated_at: new Date().toISOString() }).eq('id', 'global')
      return new Response(JSON.stringify({ processed, cancelled: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    const { count: remainingPending } = await supabase
      .from('watchlist_items')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending')

    if ((remainingPending || 0) > 0) {
      const nextRunAt = new Date(Date.now() + 2 * 60 * 1000)
      console.log(`[watchlist-scan] ${remainingPending} item(s) still pending — scheduling next slice at ${nextRunAt.toISOString()}`)
      const { error: scheduleErr } = await supabase.rpc('schedule_watchlist_followup', {
        target_url: `${SUPABASE_URL}/functions/v1/cron-scan?task=watchlist-scan`,
        auth_header: `Bearer ${SERVICE_ROLE_KEY}`,
        run_at: nextRunAt.toISOString(),
      })
      if (scheduleErr) console.log('[watchlist-scan] failed to schedule next slice:', scheduleErr.message)
    } else {
      console.log('[watchlist-scan] queue empty after this slice — done')
      await supabase.from('watchlist_control').update({ is_running: false, updated_at: new Date().toISOString() }).eq('id', 'global')
    }

    return new Response(
      JSON.stringify({ processed, remainingPending: remainingPending || 0 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  } catch (err: any) {
    console.error('[watchlist-scan] fatal error:', err.message)
    // Leave is_running true on a fatal error rather than silently clearing
    // it — an admin staring at a stuck "Running..." state is a much
    // louder, more honest signal that something broke than a batch that
    // quietly looks finished when it isn't.
    return new Response(JSON.stringify({ error: err.message }), { status: 500 })
  }
}

async function processWatchlistItem(item: { id: string; product_url: string; x_post_url: string }) {
  const { id, product_url } = item
  const mark = async (fields: Record<string, any>) =>
    supabase.from('watchlist_items').update({ ...fields, updated_at: new Date().toISOString() }).eq('id', id)

  try {
    await mark({ status: 'scanning', error_message: null })

    // Step 1: analyze — same /api/analyze route used everywhere else.
    const analysis = await reanalyzeProduct(product_url)
    if (!analysis) {
      await mark({ status: 'error', error_message: 'Could not analyze this product URL (all AI providers failed or returned a fallback)' })
      return
    }

    const subreddits = (analysis.subreddits || []).slice(0, 6)
    if (!subreddits.length) {
      await mark({ status: 'error', error_message: 'Analysis returned no subreddits to scan' })
      return
    }

    // Step 2: fetch — direct + watchlist-worker split, same pattern as the
    // main loop's direct + worker split (see Deno.serve below), just with
    // the dedicated watchlist worker instead of the live-traffic one.
    const directSubs = subreddits.slice(0, 3)
    const watchlistWorkerSubs = subreddits.slice(3, 6)

    await Promise.all([
      directSubs.length ? waitForRedditQuota('direct') : Promise.resolve(),
      watchlistWorkerSubs.length ? waitForRedditQuota('watchlist-worker') : Promise.resolve(),
    ])

    const [directPosts, workerPosts] = await Promise.all([
      directSubs.length ? fetchSubreddit(directSubs.join('+'), 'direct') : Promise.resolve([] as any[]),
      watchlistWorkerSubs.length ? fetchSubreddit(watchlistWorkerSubs.join('+'), 'watchlist-worker') : Promise.resolve([] as any[]),
    ])

    console.log(`[watchlist-scan] item ${id}: direct ${directPosts.length} posts, watchlist-worker ${workerPosts.length} posts`)
    const combinedPosts = [...directPosts, ...workerPosts]
    const freshPosts = combinedPosts.filter((p: any) => p.body && p.body.length > 40)

    if (!freshPosts.length) {
      await mark({ status: 'error', error_message: 'No Reddit posts found across this product\u2019s matched subreddits' })
      return
    }

    // Step 3: score — existing /api/score flow, unchanged, with
    // includeCloseMatches so save-share gets the same full leads array
    // onboarding.js's own Save & Share button would produce.
    const { leads: scoredLeads } = await scorePosts(freshPosts, analysis, true)

    if (!scoredLeads.length) {
      await mark({ status: 'error', error_message: 'No matching leads found for this product right now' })
      return
    }

    // Step 4: save-share — hands back the /share/<token> link to reply
    // with. qualified (non-'close') count/top-score mirrors how the
    // ticker and share page itself report these numbers elsewhere.
    const shareRes = await fetch(`${NEXTJS_BASE_URL}/api/save-share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: product_url, analysis, leads: scoredLeads }),
      signal: AbortSignal.timeout(60000),
    })
    const shareData = await shareRes.json()

    if (!shareRes.ok || !shareData.token) {
      await mark({ status: 'error', error_message: shareData.error || 'save-share did not return a token' })
      return
    }

    const qualified = scoredLeads.filter((l: any) => l.tier !== 'close')
    const leadCount = qualified.length || scoredLeads.length
    const topScore = Math.max(0, ...scoredLeads.map((l: any) => l.score || 0))

    await mark({ status: 'done', share_token: shareData.token, lead_count: leadCount, top_score: topScore, error_message: null })
    console.log(`[watchlist-scan] item ${id}: done — token ${shareData.token}, ${leadCount} qualified leads`)
  } catch (e: any) {
    console.log(`[watchlist-scan] item ${id} error:`, e.message)
    await mark({ status: 'error', error_message: e.message || 'Unknown error' })
  }
}

// ─── Main handler ──────────────────────────────────────────────────────
Deno.serve(async (req) => {
  // Daily maintenance — holds 7+ day inactive accounts (#5) and sweeps
  // passwordless-account push engagement (#6). Routed here by a *second*
  // pg_cron entry hitting this same deployed function with
  // ?task=daily-maintenance once a day (see pg-cron-schedule.sql) — one
  // function covers both the 30-min scan and the daily checks, so nothing
  // new needs deploying, and this branch returns before any of the normal
  // scan logic below even runs.
  const requestUrl = new URL(req.url)
  if (requestUrl.searchParams.get('task') === 'daily-maintenance') {
    return runDailyMaintenance()
  }

  // Admin X-lead watchlist batch (#4) — routed here by ?task=watchlist-scan,
  // same one-function-covers-everything approach as daily-maintenance
  // above. Returns before any of the normal scan logic below runs.
  if (requestUrl.searchParams.get('task') === 'watchlist-scan') {
    return runWatchlistScan()
  }

  console.log('[cron-scan] starting run at', new Date().toISOString())

  try {
    const { data: profiles, error: profilesErr } = await supabase
      .from('product_profiles')
      .select('user_id, url, analysis, last_analyzed_at, last_cron_attempt_at, is_held')

    if (profilesErr) throw profilesErr
    if (!profiles?.length) {
      console.log('[cron-scan] no profiles found')
      return new Response(JSON.stringify({ processed: 0 }), { status: 200 })
    }

    // Skip-check for held accounts (#5) — filtered out here, before any
    // batching math, so a held user never occupies a BATCH_SIZE slot or
    // counts toward "remaining this hour"; they're not queued-then-
    // skipped, they're just not queued. is_held is set by the daily
    // maintenance task below (?task=daily-maintenance) after 7+ days of
    // user_settings.last_active_at inactivity, and cleared by the
    // dashboard's Resume button or the admin toggle — never by this path.
    const heldCount = profiles.filter((p: any) => p.is_held).length
    const eligibleProfiles = profiles.filter((p: any) => !p.is_held)
    if (heldCount) console.log(`[cron-scan] ${heldCount} account(s) held (7+ days inactive) — excluded from this run`)

    if (!eligibleProfiles.length) {
      console.log('[cron-scan] no eligible (non-held) profiles found')
      return new Response(JSON.stringify({ processed: 0, held: heldCount, total: profiles.length }), { status: 200 })
    }

    console.log(`[cron-scan] found ${eligibleProfiles.length} eligible profiles to check (${heldCount} held)`)

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

    const notYetAttemptedThisHour = eligibleProfiles.filter((p: any) => {
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

      // The actual quota wait now happens right before the Reddit fetch
      // itself, below — moved there because it's dual-path (direct +
      // worker, two independent buckets) and the subreddit split isn't
      // known yet at this point in the loop. Still happens before the
      // very first user in the batch, not just between users: the quota
      // is shared across the whole app (any visitor's browser scan, any
      // share-page notify, could have used it moments ago), so "first
      // user in this batch" was never the same thing as "quota is
      // definitely open."

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

      // Split into two groups of up to 3 — one fetched directly, one
      // through the Cloudflare Worker proxy, a genuinely separate IP with
      // its own independent quota bucket (confirmed separately; see
      // reddit.js's WORKER_BASE_URL comment). Fetched concurrently instead
      // of one 6-subreddit combined request sharing a single ~1-request-
      // per-window budget — roughly double the posts per cycle for the
      // same wait. Still one combined multireddit request PER PATH, same
      // batching reasoning as before (onboarding.js / share/[token].js
      // match this): the old one-at-a-time loop cost up to 6 Reddit
      // requests per user, most of them doomed before they were even sent.
      const directSubs = subreddits.slice(0, 3)
      const workerSubs = subreddits.slice(3, 6)

      // Wait for BOTH buckets before firing, not just whichever one
      // happens to gate this user's turn — run in parallel since they're
      // independent clocks and waiting on one does nothing for the other.
      await Promise.all([
        directSubs.length ? waitForRedditQuota('direct') : Promise.resolve(),
        workerSubs.length ? waitForRedditQuota('worker') : Promise.resolve(),
      ])

      const [directPosts, workerPosts] = await Promise.all([
        directSubs.length ? fetchSubreddit(directSubs.join('+'), 'direct') : Promise.resolve([] as any[]),
        workerSubs.length ? fetchSubreddit(workerSubs.join('+'), 'worker') : Promise.resolve([] as any[]),
      ])

      // The worker is a bonus, not a hard dependency — if it fails, times
      // out, or comes back empty, proceed with whatever the direct half
      // returned rather than treating the whole fetch as failed. Logged
      // explicitly here (not just inside fetchSubreddit's own per-path
      // logs) so a worker-side failure is never silently absorbed into
      // "the fetch succeeded" just because direct worked.
      console.log(`[cron-scan] user ${userId}: direct ${directPosts.length} posts, worker ${workerPosts.length} posts (combined ${directPosts.length + workerPosts.length})`)
      const combinedPosts = [...directPosts, ...workerPosts]

      // parseAtom tags each entry with its own subreddit via <category>
      // (see parseAtom above), so split the merged response back out per
      // subreddit here — downstream code (filteredArrays, freshArrays, the
      // round-robin interleave below) still expects one array per
      // subreddit, same shape as before batching, regardless of which of
      // the two paths a given post actually came through.
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
        held: heldCount,
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
