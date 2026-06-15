// reddit.js — Proxy for Reddit RSS feeds AND post comment JSON
// Handles both subreddit feeds and per-post comment fetching

export default async function handler(req, res) {
  const { sub, sort = 'new', mode, postId } = req.query

  // Mode: 'comments' — fetch comments for a specific post
  if (mode === 'comments' && postId && sub) {
    return fetchComments(req, res, sub, postId)
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
