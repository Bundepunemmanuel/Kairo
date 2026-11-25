// hackernews.js — Fetches Hacker News posts matching a product's
// problemKeywords (see analyze.js), via Algolia's HN search API.
//
// No auth, no key, no quota tracking needed — this is the one source in
// Kairo's stack with no gatekeeping at all. See README-reddit-legacy.md
// for why this replaced Reddit.
//
// Takes an array of search queries (analysis.problemKeywords), searches
// each one independently (Algolia's API doesn't support OR'd multi-term
// queries the way a single call could cover several phrases at once),
// and merges + dedupes the results into Kairo's standard post shape.

const HN_SEARCH_URL = 'https://hn.algolia.com/api/v1/search'

// Only stories and comments carry real prose worth scoring — Algolia's
// index also includes polls and job postings, which are noise here.
const HN_TAGS = 'story,comment'

// How far back a hit can be and still count as "fresh enough to be a
// real lead" — mirrors the spirit of Reddit's old 24h freshness window,
// loosened somewhat since HN threads stay active longer than a Reddit
// post typically did. A 3-year-old comment matching a keyword by
// coincidence isn't a live lead.
const MAX_AGE_DAYS = 14

async function searchOnce(query) {
  const url = `${HN_SEARCH_URL}?query=${encodeURIComponent(query)}&tags=${HN_TAGS}&hitsPerPage=20`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) {
      console.log(`[hackernews] query "${query}" — status ${res.status}`)
      return []
    }
    const data = await res.json()
    return Array.isArray(data?.hits) ? data.hits : []
  } catch (e) {
    console.log(`[hackernews] query "${query}" — fetch error:`, e.message)
    return []
  }
}

// Normalizes an Algolia hit into Kairo's standard post shape — the same
// {id, title, body, url, subreddit, createdAt, ups} every other fetcher
// (and score.js downstream) already expects. `subreddit` is repurposed
// as a plain source label here; there's no community concept on HN.
function toPost(hit) {
  const isComment = hit._tags?.includes('comment')
  const title = hit.title || hit.story_title || '(comment)'
  const body = isComment ? (hit.comment_text || '') : (hit.story_text || hit.title || '')
  const id = hit.objectID
  // Comments link to their parent story, not a comment-specific anchor —
  // Algolia doesn't expose a direct per-comment permalink, so the story
  // thread is the closest real, clickable destination.
  const url = isComment
    ? `https://news.ycombinator.com/item?id=${hit.story_id || id}`
    : (hit.url || `https://news.ycombinator.com/item?id=${id}`)

  return {
    id: `hn_${id}`,
    title,
    body: body ? body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600) : '',
    url,
    subreddit: 'Hacker News',
    createdAt: hit.created_at_i ? hit.created_at_i * 1000 : Date.now(),
    ups: hit.points || 0,
  }
}

export default async function handler(req, res) {
  const { problemKeywords } = req.body || {}

  if (!Array.isArray(problemKeywords) || !problemKeywords.length) {
    return res.status(400).json({ error: 'problemKeywords (array) required' })
  }

  const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000

  try {
    const results = await Promise.all(problemKeywords.map(searchOnce))
    const seen = new Set()
    const posts = []

    for (const hits of results) {
      for (const hit of hits) {
        const post = toPost(hit)
        if (seen.has(post.id)) continue
        if (post.createdAt < cutoff) continue
        if (!post.body || post.body.length < 40) continue
        seen.add(post.id)
        posts.push(post)
      }
    }

    console.log(`[hackernews] ${problemKeywords.length} queries -> ${posts.length} posts after dedup/freshness filter`)
    return res.status(200).json({ posts })
  } catch (e) {
    console.log('[hackernews] handler error:', e.message)
    return res.status(200).json({ posts: [] })
  }
}
