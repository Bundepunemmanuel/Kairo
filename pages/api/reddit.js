// reddit.js — Proxy for Reddit RSS feeds, post comment JSON, subreddit
// rules, and the persisted shared-quota reset time.
//
// Core finding this file is built around: Reddit enforces a real, numeric,
// per-IP rate limit — roughly one request allowed per ~30-60 second reset
// window, shared across this entire app (every visitor's browser scan,
// every share-page notify, every cron-scan run all draw from the SAME
// budget, since they all land on the same outbound IP). It is not a
// per-user or per-endpoint quota. Every change below assumes that.

import { createClient } from '@supabase/supabase-js'

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// The Cloudflare Worker proxy — its own IP, its own independent quota
// bucket with Reddit (confirmed separately from this app's direct Vercel
// egress). Lets a user's subreddit list be split into two groups fetched
// concurrently through two genuinely different IPs instead of one combined
// request sharing a single ~1-request-per-window budget — roughly double
// the posts per cycle for the same wait. Source of truth for whether this
// is really paying off is the two reddit_rate_limit rows below (direct vs
// worker) drifting independently over time in the logs, not assumed once
// and forgotten.
const WORKER_BASE_URL = 'https://kairo-reddit-proxy.bundepunemmanuel.workers.dev/'

// Logs whatever rate-limit-related headers Reddit sends — on every
// response, not just 429s. Logging it on success too lets us watch
// X-Ratelimit-Remaining actually decrease request to request, instead of
// only ever seeing the quota at the moment it hits zero.
//
// rowId distinguishes which quota bucket this response belongs to —
// 'direct' (this app's own egress) or 'worker' (the Cloudflare Worker's
// separate IP). Logged explicitly alongside the usual headers so a run
// touching both paths never has an ambiguous log line about which bucket
// a given 429 or success actually came from.
//
// AWAITED, not fire-and-forget. It used to be fire-and-forget on the
// reasoning that persistence shouldn't slow down the real Reddit
// response — but in production that let the handler finish and return
// before the write landed, and a serverless runtime can freeze/tear down
// the function the instant its response is sent. An in-flight fetch that
// gets cut off that way surfaces as a bare "TypeError: fetch failed" —
// which is exactly what showed up intermittently in prod logs (including
// on a couple of clean 200s, not just 429s), and it's what let
// waitForRedditQuota() elsewhere read a stale reset_at and let a request
// fire seconds after a window had just been consumed. The latency cost
// of awaiting one Supabase upsert is well worth not losing writes.
async function logRateLimitHeaders(tag, response, rowId = 'direct') {
  const retryAfter = response.headers.get('retry-after')
  const remaining = response.headers.get('x-ratelimit-remaining')
  const reset = response.headers.get('x-ratelimit-reset')
  console.log(`${tag} [${rowId}] status ${response.status} — Retry-After: ${retryAfter ?? 'none'}, X-Ratelimit-Remaining: ${remaining ?? 'none'}, X-Ratelimit-Reset: ${reset ?? 'none'}`)
  try {
    await persistRateLimit(response, rowId)
  } catch (e) {
    console.log(`[reddit:rate-limit:${rowId}] persist exception:`, e.message)
  }
}

// Persists the latest X-Ratelimit-Reset to a durable row, keyed by rowId
// ('direct' or 'worker') — two independent rows for two independent
// quota buckets, not one shared row, since they reset on their own
// separate clocks. Read back by onboarding.js / share/[token].js (via
// mode=status below, a plain DB read that costs nothing against Reddit's
// own quota) and by cron-scan (direct DB read). X-Ratelimit-Reset is
// SECONDS UNTIL reset, not a timestamp — converted to an absolute time
// here since a relative number is meaningless by the time something reads
// this row back later.
async function persistRateLimit(response, rowId = 'direct') {
  const resetSeconds = response.headers.get('x-ratelimit-reset')
  if (resetSeconds == null) {
    // The worker may not relay Reddit's rate-limit headers through
    // unmodified — unconfirmed either way yet. If this fires consistently
    // for rowId === 'worker' while 'direct' keeps reporting real values,
    // that's the signal the worker path needs its own header pass-through
    // fix before its quota tracking can be trusted the same way direct's is.
    if (rowId === 'worker') console.log('[reddit:rate-limit:worker] no X-Ratelimit-Reset header on this response — worker may not be relaying it')
    return // nothing Reddit told us this time — leave the existing row alone
  }

  const remaining = response.headers.get('x-ratelimit-remaining')
  const resetAt = new Date(Date.now() + parseFloat(resetSeconds) * 1000).toISOString()

  const { error } = await supabaseAdmin.from('reddit_rate_limit').upsert(
    {
      id: rowId,
      reset_at: resetAt,
      remaining: remaining != null ? parseFloat(remaining) : null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'id' }
  )
  if (error) console.log(`[reddit:rate-limit:${rowId}] persist error:`, error.message)
}

export default async function handler(req, res) {
  const { sub, sort = 'new', mode, postId, source = 'direct' } = req.query

  // Mode: 'status' — read the persisted rate-limit reset time(s). No
  // outbound Reddit request, so checking this never costs part of the
  // shared quota.
  if (mode === 'status') {
    return fetchRateLimitStatus(req, res)
  }

  // Mode: 'comments' — fetch comments for a specific post
  if (mode === 'comments' && postId && sub) {
    return fetchComments(req, res, sub, postId)
  }

  // Mode: 'rules' — fetch a subreddit's stated rules + description
  if (mode === 'rules' && sub) {
    return fetchRules(req, res, sub)
  }

  // Default mode: fetch subreddit feed. source='direct' (default) hits
  // Reddit straight from this app's own egress; source='worker' routes
  // the same request through the Cloudflare Worker proxy instead — two
  // separate IPs, two separate quota buckets (see WORKER_BASE_URL above).
  if (!sub) return res.status(400).json({ error: 'sub required' })
  return fetchSubredditFeed(req, res, sub, sort, source)
}

async function fetchRateLimitStatus(req, res) {
  try {
    // Both rows in one query — callers that use both paths (onboarding.js,
    // share/[token].js, index.ts) need to know whichever one is the
    // binding constraint, not just one of them.
    const { data, error } = await supabaseAdmin
      .from('reddit_rate_limit')
      .select('id, reset_at, remaining, updated_at')
      .in('id', ['direct', 'worker'])

    if (error) {
      console.log('[reddit:status] read error:', error.message)
      return res.status(200).json({
        direct: { resetAt: null, remaining: null },
        worker: { resetAt: null, remaining: null },
        serverNow: new Date().toISOString(),
      })
    }

    const byId = Object.fromEntries((data || []).map(r => [r.id, r]))

    // Never cached — this is the one read callers rely on to be current.
    res.setHeader('Cache-Control', 'no-store')
    return res.status(200).json({
      direct: { resetAt: byId.direct?.reset_at || null, remaining: byId.direct?.remaining ?? null },
      worker: { resetAt: byId.worker?.reset_at || null, remaining: byId.worker?.remaining ?? null },
      serverNow: new Date().toISOString(),
    })
  } catch (e) {
    console.log('[reddit:status] fatal:', e.message)
    return res.status(200).json({
      direct: { resetAt: null, remaining: null },
      worker: { resetAt: null, remaining: null },
      serverNow: new Date().toISOString(),
    })
  }
}

async function fetchSubredditFeed(req, res, sub, sort, source = 'direct') {
  const sorts = sort === 'new' ? ['new', 'hot'] : [sort, 'new']
  const rowId = source === 'worker' ? 'worker' : 'direct'

  for (const s of sorts) {
    try {
      // `sub` may be several subreddit names joined with "+" (a Reddit
      // multireddit, e.g. "SaaS+indiehackers+entrepreneur") — one combined
      // request instead of one per subreddit, since the shared quota only
      // affords ~1 request per reset window regardless. encodeURIComponent
      // turns that "+" into "%2B", which is fine: it's a path segment, not
      // a query string, so "+" has no space-vs-literal ambiguity here —
      // Reddit decodes %2B back to a literal "+" and reads it as the
      // multireddit separator exactly as if it had been sent unencoded.
      //
      // limit=250 is requested, but Reddit's .rss endpoint silently clamps
      // any value above 100 — confirmed in production, where every
      // successful fetch across several different subreddit combos came
      // back with exactly 100 entries, never more. The param is left at
      // 250 rather than 100 in case Reddit's own ceiling ever changes, but
      // nothing downstream (score.js included) should assume more than
      // 100 posts actually arrive from a single request today.
      const targetUrl = `https://www.reddit.com/r/${encodeURIComponent(sub)}/${s}.rss?limit=250`

      // source='worker' routes through the Cloudflare Worker proxy
      // instead of fetching Reddit directly — same target URL, wrapped as
      // the worker's own ?url= param. A genuinely separate IP/quota bucket
      // (confirmed independently), which is the whole reason this exists:
      // two groups of subreddits fetched concurrently through two
      // different IPs instead of all of them sharing one ~1-request-per-
      // window budget. See index.ts for where the subreddit list actually
      // gets split.
      const fetchUrl = rowId === 'worker'
        ? `${WORKER_BASE_URL}?url=${encodeURIComponent(targetUrl)}`
        : targetUrl

      const response = await fetch(fetchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
        signal: AbortSignal.timeout(10000),
      })

      await logRateLimitHeaders(`[reddit:${s}]`, response, rowId)

      // One successful (or blocked) request already exhausts this
      // particular bucket's shared window — trying the next sort tier
      // right after a 429 is a guaranteed-wasted request, not a real
      // second attempt. Stop here instead of falling through to 'hot'.
      // (Other failure modes — an empty result, a timeout — aren't known
      // to mean the quota is gone, so those still fall through below as
      // before.)
      if (response.status === 429) {
        console.log(`[reddit:${s}] [${rowId}] r/${sub} — 429 (quota exhausted), skipping fallback tier`)
        break
      }

      const text = await response.text()
      if (!text.includes('<entry>')) {
        console.log(`[reddit:${s}] [${rowId}] r/${sub} empty result (status ${response.status})`)
        continue
      }

      const count = (text.match(/<entry>/g) || []).length
      console.log(`[reddit:${s}] [${rowId}] r/${sub} success — ${count} entries`)
      res.setHeader('Content-Type', 'text/xml; charset=utf-8')
      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate')
      return res.status(200).send(text)
    } catch (e) {
      console.log(`[reddit:${s}] [${rowId}] r/${sub} fetch error: ${e.message}`)
      continue
    }
  }

  console.log(`[reddit] [${rowId}] r/${sub} — all sources exhausted, returning empty feed`)
  return res.status(200).send('<feed></feed>')
}

async function fetchRules(req, res, sub) {
  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': `https://www.reddit.com/r/${encodeURIComponent(sub)}/`,
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
    }

    // Combine formal numbered rules with the subreddit's own public
    // description — some subreddits state "no self-promo" in their
    // sidebar rather than as a numbered rule, so check both.
    const [rulesRes, aboutRes] = await Promise.all([
      fetch(`https://www.reddit.com/r/${encodeURIComponent(sub)}/about/rules.json`, { headers, signal: AbortSignal.timeout(10000) }).catch(() => null),
      fetch(`https://www.reddit.com/r/${encodeURIComponent(sub)}/about.json`, { headers, signal: AbortSignal.timeout(10000) }).catch(() => null),
    ])

    let combinedText = ''

    if (rulesRes?.ok) {
      const rulesData = await rulesRes.json()
      const rules = rulesData?.rules || []
      combinedText += rules.map(r => `${r.short_name || ''} ${r.description || ''}`).join(' ')
    }

    if (aboutRes?.ok) {
      const aboutData = await aboutRes.json()
      combinedText += ' ' + (aboutData?.data?.public_description || '') + ' ' + (aboutData?.data?.description || '')
    }

    console.log(`[reddit:rules] r/${sub} rules status ${rulesRes?.status ?? 'fetch_failed'}, about status ${aboutRes?.status ?? 'fetch_failed'}`)
    if (rulesRes) await logRateLimitHeaders('[reddit:rules]', rulesRes)
    if (aboutRes) await logRateLimitHeaders('[reddit:about]', aboutRes)

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate')
    // Return status codes alongside the text — cron-scan logs these, so a
    // future silent failure shows real evidence (which call failed and
    // how) instead of just an empty string with no way to tell why.
    return res.status(200).json({
      rulesText: combinedText,
      rulesStatus: rulesRes?.status ?? 'fetch_failed',
      aboutStatus: aboutRes?.status ?? 'fetch_failed',
    })
  } catch (e) {
    return res.status(200).json({ rulesText: '', rulesStatus: 'error', aboutStatus: 'error', errorMessage: e.message })
  }
}
async function fetchComments(req, res, sub, postId) {
  try {
    const response = await fetch(
      `https://www.reddit.com/r/${encodeURIComponent(sub)}/comments/${postId}.json?limit=50&depth=2`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(10000),
      }
    )

    await logRateLimitHeaders('[reddit:comments]', response)

    if (!response.ok) {
      console.log(`[reddit:comments] r/${sub}/${postId} failed (status ${response.status})`)
      return res.status(200).json({ comments: [] })
    }

    const data = await response.json()

    // Reddit returns [postListing, commentsListing]
    const commentsListing = data?.[1]?.data?.children || []

    const comments = commentsListing
      .filter(c => c.kind === 't1' && c.data?.body && c.data.body !== '[deleted]' && c.data.body !== '[removed]')
      .map(c => ({
        id: c.data.id,
        body: c.data.body.slice(0, 600),
        author: c.data.author,
        score: c.data.score || 0,
        createdAt: (c.data.created_utc || 0) * 1000,
      }))
      .filter(c => c.body.length > 30)
      .slice(0, 30) // Top 30 comments is enough signal

    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate')
    return res.status(200).json({ comments })
  } catch {
    return res.status(200).json({ comments: [] })
  }
}
