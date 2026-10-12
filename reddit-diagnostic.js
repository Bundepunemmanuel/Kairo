// reddit.js — Proxy for Reddit RSS feeds, post comment JSON, and subreddit rules
// Handles subreddit feeds, per-post comment fetching, and rules lookup
//
// TEMPORARY DIAGNOSTIC BUILD — this is the exact production file with
// logging added and nothing else changed. No batching, no proxy, no
// limit/header/fallback changes. The only difference from the live
// production file is every console.log call below. Deployed to preview
// specifically to test whether 429s are about the environment (preview vs
// production) with every other variable held constant.

// Logs whatever rate-limit-related headers Reddit actually sends on a
// 429 — mainly Retry-After, which (if present) states how long Reddit
// wants us to wait. Logged even when empty, since "Reddit sends nothing
// informative" is itself useful to know.
function logRateLimitHeaders(tag, response) {
  const retryAfter = response.headers.get('retry-after')
  const remaining = response.headers.get('x-ratelimit-remaining')
  const reset = response.headers.get('x-ratelimit-reset')
  console.log(`${tag} 429 headers — Retry-After: ${retryAfter ?? 'none'}, X-Ratelimit-Remaining: ${remaining ?? 'none'}, X-Ratelimit-Reset: ${reset ?? 'none'}`)
}

export default async function handler(req, res) {
  const { sub, sort = 'new', mode, postId } = req.query

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
  return fetchSubredditFeed(req, res, sub, sort)
}

async function fetchSubredditFeed(req, res, sub, sort) {
  const sorts = sort === 'new' ? ['new', 'hot'] : [sort, 'new']

  for (const s of sorts) {
    try {
      const response = await fetch(
        `https://www.reddit.com/r/${encodeURIComponent(sub)}/${s}.rss?limit=25`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
          },
          signal: AbortSignal.timeout(10000),
        }
      )

      // Logging only — status checked for visibility, fallback behavior
      // below is completely unchanged (still cascades through every tier
      // regardless of why the previous one failed, exactly as production
      // does today).
      if (response.status === 429) logRateLimitHeaders(`[reddit:${s}]`, response)

      const text = await response.text()
      if (!text.includes('<entry>')) {
        console.log(`[reddit:${s}] r/${sub} empty result (status ${response.status})`)
        continue
      }

      const count = (text.match(/<entry>/g) || []).length
      console.log(`[reddit:${s}] r/${sub} success — ${count} entries`)
      res.setHeader('Content-Type', 'text/xml; charset=utf-8')
      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate')
      return res.status(200).send(text)
    } catch (e) {
      console.log(`[reddit:${s}] r/${sub} fetch error: ${e.message}`)
      continue
    }
  }

  console.log(`[reddit] r/${sub} — all sources exhausted, returning empty feed`)
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
    if (rulesRes?.status === 429 || aboutRes?.status === 429) {
      if (rulesRes?.status === 429) logRateLimitHeaders('[reddit:rules]', rulesRes)
      if (aboutRes?.status === 429) logRateLimitHeaders('[reddit:about]', aboutRes)
    }

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

    if (!response.ok) {
      console.log(`[reddit:comments] r/${sub}/${postId} failed (status ${response.status})`)
      if (response.status === 429) logRateLimitHeaders('[reddit:comments]', response)
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
