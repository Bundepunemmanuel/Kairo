// reddit.js — Proxy for Reddit RSS feeds, post comment JSON, and subreddit rules
// Handles subreddit feeds, per-post comment fetching, and rules lookup

export default async function handler(req, res) {
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

const REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
}

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
      const query = terms.map(t => `"${t}"`).join(' OR ')
      try {
        const response = await fetch(
          `https://www.reddit.com/r/${encodeURIComponent(sub)}/search.rss?q=${encodeURIComponent(query)}&restrict_sr=1&sort=new&t=week&limit=25`,
          { headers: REQUEST_HEADERS, signal: AbortSignal.timeout(10000) }
        )
        const text = await response.text()
        if (text.includes('<entry>')) {
          res.setHeader('Content-Type', 'text/xml; charset=utf-8')
          res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate')
          return res.status(200).send(text)
        }
        // Empty search result — genuinely could mean nothing matched in
        // the last week, not necessarily a broken request. Fall through
        // to the plain new/hot feed below rather than returning nothing,
        // so a scan never dead-ends on a quiet search week.
      } catch {
        // Falls through to the existing behavior below.
      }
    }
  }

  const sorts = sort === 'new' ? ['new', 'hot'] : [sort, 'new']

  for (const s of sorts) {
    try {
      const response = await fetch(
        `https://www.reddit.com/r/${encodeURIComponent(sub)}/${s}.rss?limit=25`,
        { headers: REQUEST_HEADERS, signal: AbortSignal.timeout(10000) }
      )

      const text = await response.text()
      if (!text.includes('<entry>')) continue

      res.setHeader('Content-Type', 'text/xml; charset=utf-8')
      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate')
      return res.status(200).send(text)
    } catch {
      continue
    }
  }

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

    if (!response.ok) return res.status(200).json({ comments: [] })

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
