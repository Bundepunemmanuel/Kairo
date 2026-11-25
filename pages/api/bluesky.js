// bluesky.js — Fetches Bluesky posts matching a product's
// problemKeywords (see analyze.js), via the AT Protocol's searchPosts
// endpoint. Authenticated with a dedicated account's app password (see
// README-reddit-legacy.md for why this replaced Reddit, and how this
// differs from Reddit's OAuth gatekeeping — no approval process here).
//
// The access token expires in minutes and this is a serverless function
// with no memory between invocations, so the session (access + refresh
// tokens) is cached in Supabase's bluesky_session table (see
// bluesky-session-table.sql) — read before every call, refreshed or
// recreated only when actually expired, never on every request.

import { createClient } from '@supabase/supabase-js'

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const BSKY_BASE = 'https://bsky.social/xrpc'
const SESSION_ROW_ID = 'default'

// How far back a hit can be and still count as a real lead — same
// reasoning as hackernews.js's MAX_AGE_DAYS.
const MAX_AGE_DAYS = 14

// AT Protocol access/refresh tokens are JWTs with a real `exp` claim —
// decoded directly rather than guessing a TTL, so expires_at in Supabase
// always reflects what Bluesky itself says, not an assumption on our side.
function decodeJwtExpiry(jwt) {
  try {
    const payload = jwt.split('.')[1]
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return json.exp ? new Date(json.exp * 1000) : null
  } catch {
    return null
  }
}

async function createNewSession() {
  const identifier = process.env.BLUESKY_HANDLE
  const password = process.env.BLUESKY_APP_PASSWORD
  if (!identifier || !password) {
    throw new Error('BLUESKY_HANDLE / BLUESKY_APP_PASSWORD not configured')
  }
  const res = await fetch(`${BSKY_BASE}/com.atproto.server.createSession`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, password }),
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`createSession failed: ${res.status} ${text.slice(0, 200)}`)
  }
  return res.json()
}

async function refreshSession(refreshJwt) {
  const res = await fetch(`${BSKY_BASE}/com.atproto.server.refreshSession`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${refreshJwt}` },
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) return null // falls through to a full re-login below
  return res.json()
}

async function persistSession({ accessJwt, refreshJwt }) {
  const expiresAt = decodeJwtExpiry(accessJwt) || new Date(Date.now() + 5 * 60 * 1000)
  await supabaseAdmin.from('bluesky_session').upsert({
    id: SESSION_ROW_ID,
    access_jwt: accessJwt,
    refresh_jwt: refreshJwt,
    expires_at: expiresAt.toISOString(),
    updated_at: new Date().toISOString(),
  })
  return accessJwt
}

// Returns a valid accessJwt — from cache if still fresh, refreshed if
// expired but the refresh token still works, or a brand new login as the
// last resort (also covers the very first call, before any row exists).
async function getAccessToken() {
  const { data: row } = await supabaseAdmin
    .from('bluesky_session')
    .select('*')
    .eq('id', SESSION_ROW_ID)
    .maybeSingle()

  // 60s buffer so a token doesn't expire mid-request.
  if (row && new Date(row.expires_at).getTime() - Date.now() > 60000) {
    return row.access_jwt
  }

  if (row) {
    const refreshed = await refreshSession(row.refresh_jwt)
    if (refreshed?.accessJwt) {
      console.log('[bluesky] session refreshed')
      return persistSession(refreshed)
    }
    console.log('[bluesky] refresh failed, falling back to full login')
  }

  const session = await createNewSession()
  console.log('[bluesky] new session created')
  return persistSession(session)
}

async function searchOnce(query, accessJwt) {
  const url = `${BSKY_BASE}/app.bsky.feed.searchPosts?q=${encodeURIComponent(query)}&limit=25`
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessJwt}` },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) {
      console.log(`[bluesky] query "${query}" — status ${res.status}`)
      return []
    }
    const data = await res.json()
    return Array.isArray(data?.posts) ? data.posts : []
  } catch (e) {
    console.log(`[bluesky] query "${query}" — fetch error:`, e.message)
    return []
  }
}

// Normalizes a Bluesky post record into Kairo's standard post shape —
// same {id, title, body, url, subreddit, createdAt, ups} every other
// fetcher (and score.js downstream) already expects.
function toPost(post) {
  const text = post.record?.text || ''
  // Bluesky posts have no title field — the first line (or first ~80
  // chars) stands in for one, since every downstream display assumes a
  // title exists. Full text still goes in body, untruncated here.
  const firstLine = text.split('\n')[0]
  const title = firstLine.length > 80 ? firstLine.slice(0, 80) + '...' : (firstLine || '(post)')

  // Post URI is at://did:plc:xxx/app.bsky.feed.post/{rkey} — the last
  // segment is the only piece needed to build a real, clickable URL.
  const rkey = post.uri?.split('/').pop()
  const handle = post.author?.handle
  const url = handle && rkey ? `https://bsky.app/profile/${handle}/post/${rkey}` : null

  return {
    id: `bsky_${post.cid || post.uri}`,
    title,
    body: text.replace(/\s+/g, ' ').trim().slice(0, 600),
    url,
    subreddit: 'Bluesky',
    createdAt: post.record?.createdAt ? new Date(post.record.createdAt).getTime() : Date.now(),
    ups: post.likeCount || 0,
  }
}

export default async function handler(req, res) {
  const { problemKeywords } = req.body || {}

  if (!Array.isArray(problemKeywords) || !problemKeywords.length) {
    return res.status(400).json({ error: 'problemKeywords (array) required' })
  }

  const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000

  try {
    const accessJwt = await getAccessToken()
    const results = await Promise.all(problemKeywords.map(q => searchOnce(q, accessJwt)))
    const seen = new Set()
    const posts = []

    for (const hits of results) {
      for (const hit of hits) {
        const post = toPost(hit)
        if (!post.url) continue
        if (seen.has(post.id)) continue
        if (post.createdAt < cutoff) continue
        if (!post.body || post.body.length < 40) continue
        seen.add(post.id)
        posts.push(post)
      }
    }

    console.log(`[bluesky] ${problemKeywords.length} queries -> ${posts.length} posts after dedup/freshness filter`)
    return res.status(200).json({ posts })
  } catch (e) {
    console.log('[bluesky] handler error:', e.message)
    return res.status(200).json({ posts: [] })
  }
}
