// reddit.js — Proxy for Reddit RSS feeds, post comment JSON, and subreddit rules
// Handles subreddit feeds, per-post comment fetching, and rules lookup
//
// Every request to Reddit goes through a Cloudflare Worker (REDDIT_PROXY_URL)
// instead of hitting reddit.com directly. Vercel's serverless IP range got
// consistently 429'd by Reddit regardless of request pacing — confirmed via
// production logs showing sustained blocks across unrelated scan sessions
// minutes apart. Cloudflare's IP has no such history. Falls back to a direct
// fetch only if the env var is unset (e.g. local dev), logged loudly since
// that fallback WILL get blocked in production.

const REDDIT_PROXY_URL = process.env.REDDIT_PROXY_URL

// Appended to every log line below so a log export is unambiguous at a
// glance — this exact confusion (was a given scan actually using the
// proxy, or silently falling back to direct?) is what made diagnosing the
// preview-vs-production mismatch harder than it needed to be.
const PROXY_TAG = REDDIT_PROXY_URL ? '[via proxy]' : '[DIRECT — no proxy configured]'

async function proxiedFetch(targetUrl, timeoutMs = 10000) {
  const url = REDDIT_PROXY_URL
    ? `${REDDIT_PROXY_URL}/?url=${encodeURIComponent(targetUrl)}`
    : targetUrl
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
}

export default async function handler(req, res) {
  if (!REDDIT_PROXY_URL) {
    console.log('[reddit] WARNING: REDDIT_PROXY_URL not set — requests go direct to Reddit and will likely be rate-limited in production')
  }

  const { sub, sort = 'new', mode, postId, keywords } = req.query

  // Mode: 'comments' — fetch comments for a specific post
  if (mode === 'comments' && postId && sub) {
    return fetchComments(req, res, sub, postId)
  }

  // Mode: 'rules' — fetch a subreddit's stated rules + description
  if (mode === 'rules' && sub) {
    return fetchRules(req, res, sub)
  }

  // Default mode: fetch subreddit feed
  if (!sub) return res.status(400).json({ error: 'sub required' })
  return fetchSubredditFeed(req, res, sub, sort, keywords)
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function fetchSubredditFeed(req, res, sub, sort, keywords) {
  // keywords present (analysis.problemKeywords, comma-separated by the
  // caller) → try a real 7-day search first. This replaces "whatever's
  // newest right now" (could be minutes old, could be days, no control)
  // with an actual bounded, relevant pool to score against. Reddit's
  // search endpoint supports the same .rss output as the plain listing
  // endpoints below, so the existing Atom parser needs no changes — only
  // the request URL differs.
  if (keywords) {
    const terms = keywords.split(',').map(k => k.trim()).filter(Boolean).slice(0, 6)
    if (terms.length) {
      // No quotes around each term — exact-phrase matching is too strict
      // for AI-generated keywords (a well-written phrase can still miss
      // real posts that express the same idea with different wording).
      // Unquoted OR lets Reddit's own token matching do the work instead.
      const query = terms.join(' OR ')
      console.log(`[reddit:search] r/${sub} query="${query}" (week window) ${PROXY_TAG}`)
      try {
        const response = await proxiedFetch(
          `https://www.reddit.com/r/${encodeURIComponent(sub)}/search.rss?q=${encodeURIComponent(query)}&restrict_sr=1&sort=new&t=week&limit=25`
        )
        const text = await response.text()
        if (text.includes('<entry>')) {
          const count = (text.match(/<entry>/g) || []).length
          console.log(`[reddit:search] r/${sub} success — ${count} entries from week search ${PROXY_TAG}`)
          res.setHeader('Content-Type', 'text/xml; charset=utf-8')
          res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate')
          return res.status(200).send(text)
        }
        // Empty search result — genuinely could mean nothing matched in
        // the last week, not necessarily a broken request. Fall through
        // to the plain new/hot feed below rather than returning nothing,
        // so a scan never dead-ends on a quiet search week.
        console.log(`[reddit:search] r/${sub} empty result (status ${response.status}) — falling back to new/hot ${PROXY_TAG}`)
      } catch (e) {
        console.log(`[reddit:search] r/${sub} fetch error: ${e.message} — falling back to new/hot ${PROXY_TAG}`)
      }
      // Shrunk from 350ms now that requests route through Cloudflare's
      // Worker rather than Vercel's IP — the original delay was sized for
      // an IP already under a sustained block, which shouldn't apply here.
      // Kept small rather than removed: the Worker's own IP is shared too,
      // and there's no need to re-test that boundary aggressively on day one.
      await sleep(150)
    }
  }

  const sorts = sort === 'new' ? ['new', 'hot'] : [sort, 'new']

  for (let i = 0; i < sorts.length; i++) {
    const s = sorts[i]
    try {
      const response = await proxiedFetch(`https://www.reddit.com/r/${encodeURIComponent(sub)}/${s}.rss?limit=25`)

      const text = await response.text()
      if (!text.includes('<entry>')) {
        console.log(`[reddit:${s}] r/${sub} empty result (status ${response.status}) ${PROXY_TAG}`)
      } else {
        const count = (text.match(/<entry>/g) || []).length
        console.log(`[reddit:${s}] r/${sub} success — ${count} entries ${PROXY_TAG}`)
        res.setHeader('Content-Type', 'text/xml; charset=utf-8')
        res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate')
        return res.status(200).send(text)
      }
    } catch (e) {
      console.log(`[reddit:${s}] r/${sub} fetch error: ${e.message} ${PROXY_TAG}`)
    }
    if (i < sorts.length - 1) await sleep(150)
  }

  console.log(`[reddit] r/${sub} — all sources exhausted, returning empty feed ${PROXY_TAG}`)
  return res.status(200).send('<feed></feed>')
}

async function fetchRules(req, res, sub) {
  try {
    // Combine formal numbered rules with the subreddit's own public
    // description — some subreddits state "no self-promo" in their
    // sidebar rather than as a numbered rule, so check both.
    // Headers are no longer set per-call here — the Worker applies its
    // own fixed User-Agent/Accept to everything it proxies, same as it
    // already does successfully for the feed/search fetches above.
    const [rulesRes, aboutRes] = await Promise.all([
      proxiedFetch(`https://www.reddit.com/r/${encodeURIComponent(sub)}/about/rules.json`).catch(() => null),
      proxiedFetch(`https://www.reddit.com/r/${encodeURIComponent(sub)}/about.json`).catch(() => null),
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

    console.log(`[reddit:rules] r/${sub} rules status ${rulesRes?.status ?? 'fetch_failed'}, about status ${aboutRes?.status ?? 'fetch_failed'} ${PROXY_TAG}`)
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
    const response = await proxiedFetch(
      `https://www.reddit.com/r/${encodeURIComponent(sub)}/comments/${postId}.json?limit=50&depth=2`
    )

    if (!response.ok) {
      console.log(`[reddit:comments] r/${sub}/${postId} failed (status ${response.status}) ${PROXY_TAG}`)
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
