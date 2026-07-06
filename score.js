// score.js — Simple, robust, no silent failures
// Scoring: Cerebras llama-3.3-70b (primary, 1M tokens/day) → Groq openai/gpt-oss-120b (fallback)

// Vercel Hobby's default timeout (5-10s) isn't enough room for the
// rate-limit retry wait below (up to ~30s). Hobby allows configuring
// maxDuration up to 60s explicitly — without this, a retry would get
// killed by Vercel mid-wait and return a 504 instead of completing.
export const config = { maxDuration: 60 }

function parseRetryAfterSeconds(message) {
  // Groq's TPM error looks like: "...Please try again in 30.1725s."
  const match = (message || '').match(/try again in ([\d.]+)s/i)
  return match ? Math.ceil(parseFloat(match[1])) : null
}

async function groq(messages, maxTokens, temperature, model = 'openai/gpt-oss-120b', _isRetry = false) {
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
    })
    const data = await res.json()
    if (data.error) {
      console.log(`[groq:${model}] error:`, data.error.message)

      // Rate limit hit (TPM/RPM ceiling) — this is transient, not a real
      // "no content" failure. Wait the time Groq tells us and retry once,
      // instead of silently treating it as zero qualifying leads.
      const isRateLimit = res.status === 429 || /rate.?limit/i.test(data.error.message || '')
      if (isRateLimit && !_isRetry) {
        const waitSeconds = parseRetryAfterSeconds(data.error.message) || 15
        console.log(`[groq:${model}] rate limited — retrying in ${waitSeconds}s`)
        await new Promise(r => setTimeout(r, waitSeconds * 1000))
        return groq(messages, maxTokens, temperature, model, true)
      }

      return ''
    }
    return data.choices?.[0]?.message?.content || ''
  } catch (e) {
    console.log(`[groq:${model}] fetch error:`, e.message)
    return ''
  }
}

async function cerebras(messages, maxTokens, temperature, _isRetry = false) {
  try {
    const res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.CEREBRAS_API_KEY}` },
      body: JSON.stringify({ model: 'llama-3.3-70b', messages, max_tokens: maxTokens, temperature }),
    })

    if (res.status === 429 && !_isRetry) {
      // Cerebras reports reset time via headers, not error message text.
      const resetSeconds = parseFloat(res.headers.get('x-ratelimit-reset-tokens-minute') || '')
      const waitSeconds = Number.isFinite(resetSeconds) ? Math.ceil(resetSeconds) + 1 : 15
      console.log(`[cerebras] rate limited — retrying in ${waitSeconds}s`)
      await new Promise(r => setTimeout(r, waitSeconds * 1000))
      return cerebras(messages, maxTokens, temperature, true)
    }

    const data = await res.json()
    if (data.error) { console.log('[cerebras] error:', data.error.message); return '' }
    return data.choices?.[0]?.message?.content || ''
  } catch (e) {
    console.log('[cerebras] fetch error:', e.message)
    return ''
  }
}

function parseJSON(raw) {
  try {
    // Strip qwen think blocks and markdown fences
    const clean = raw
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/```json|```/g, '')
      .trim()
    const match = clean.match(/\[[\s\S]*\]/)
    if (!match) return null
    return JSON.parse(match[0])
  } catch {
    return null
  }
}

// ─── Score all posts in one call (no batching complexity) ─────────────────
// Takes up to 40 posts, returns { scored: [...], scoredUrls: [...] }
// scoredUrls is every post actually sent to an AI — used by cron-scan to
// mark them in seen_posts so they're never re-scored, whether they
// qualified as a lead or not.
async function scorePosts(posts, analysis) {
  // Take first 40 posts — safely within budget for either provider.
  // Posts arrive already round-robin'd across subreddits from cron-scan,
  // so this sample is spread fairly rather than dominated by whichever
  // subreddit was fetched first.
  const sample = posts.slice(0, 40)
  const scoredUrls = sample.map(p => p.url).filter(Boolean)

  const input = sample.map((p, i) => ({
    i,
    title: p.title,
    body: (p.body || '').slice(0, 300),
    sub: p.subreddit,
  }))

  const messages = [
    {
      role: 'system',
      content: 'Lead qualification engine. Return only a valid JSON array. No markdown. No explanation.',
    },
    {
      role: 'user',
      content: `Score these Reddit posts as leads for this product.

PRODUCT: ${analysis.name}
WHAT IT DOES: ${analysis.description}
TARGET CUSTOMER: ${analysis.targetCustomer || ''}
SPECIFIC PROBLEMS IT SOLVES: ${analysis.specificProblems?.slice(0, 5).join(' | ') || ''}
COMPETITORS: ${analysis.competitors?.join(', ') || 'none'}

SCORING:
9-10: Person EXPLICITLY experiencing a specific problem this product solves, actively seeking solution
7-8: Person clearly struggling with a problem this product solves
0-6: Reject — do not include

CRITICAL: The problem must be the MAIN TOPIC of the post — not mentioned in passing or as background context.
If someone mentions a problem only as an example or side note while asking about something else — REJECT.

ALWAYS REJECT:
- Posts that are SHARING not ASKING (announcements, launches, success stories, tips, advice, AMAs)
- Wrong business type for this product
- Person already banned/rejected by this product or its competitors
- General discussion, opinions, news with no personal problem
- Networking posts (finding connections, referrals, relationships)
- Beginner asking how to start with no existing product
- Platform-specific pain this product doesn't solve

Only include posts scoring 7+.
Return [] if nothing qualifies.

Format: [{"i":0,"score":8,"type":"active","problem":"exact problem they have","why":"one sentence from their words"}]
"type" is "active" (seeking solution now) or "passive" (has pain, not shopping)

Posts: ${JSON.stringify(input)}`,
    },
  ]

  // Cerebras first — 1M tokens/day vs Groq's 200K for this workload, and
  // scoring is by far the highest-volume call in the app (every cron run,
  // every user). Groq is the fallback if Cerebras itself is rate limited
  // or errors, not the other way around.
  console.log('[score] trying Cerebras (primary)')
  let raw = await cerebras(messages, 1500, 0.1)

  if (!raw) {
    console.log('[score] Cerebras empty — falling back to Groq')
    raw = await groq(messages, 1500, 0.1)
  }

  console.log(`[score] raw (150): ${raw.slice(0, 150)}`)

  const scored = parseJSON(raw)
  if (!scored) { console.log('[score] parse failed'); return { scored: [], scoredUrls } }

  console.log(`[score] model returned ${scored.length} qualified`)

  const results = scored
    .filter(s => s.score >= 7 && typeof s.i === 'number' && s.i >= 0 && s.i < sample.length)
    .map(s => {
      const post = sample[s.i]
      if (!post) { console.log(`[score] post at index ${s.i} is undefined`); return null }
      return {
        post,
        score: Number(s.score) || 5,
        signalType: s.type === 'active' ? 'active' : 'passive',
        specificProblem: s.problem || '',
        reason: s.why || '',
      }
    })
    .filter(Boolean)

  return { scored: results, scoredUrls }
}

// ─── Main handler ─────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { posts, analysis } = req.body
  if (!posts?.length || !analysis) return res.status(400).json({ error: 'posts and analysis required' })

  console.log(`[score] ${posts.length} posts | product: ${analysis.name}`)

  try {
    const { scored, scoredUrls } = await scorePosts(posts, analysis)
    console.log(`[score] qualified: ${scored.length}`)

    if (!scored.length) return res.status(200).json({ leads: [], scoredUrls })

    const top3 = scored.sort((a, b) => b.score - a.score).slice(0, 3)
    console.log('[score] top3:', top3.map(s => `"${s.post.title.slice(0, 35)}" (${s.score})`).join(' | '))

    // No reply generation here — replies are generated on-demand via /api/reply
    const leads = top3.map(({ post, score, signalType, specificProblem, reason }) => {
      const ageMinutes = (Date.now() - (post.createdAt || Date.now())) / 60000
      const maxWindow = signalType === 'active' ? 180 : 360
      return {
        ...post,
        score,
        signalType,
        specificProblem,
        reason,
        draftReply: null, // generated on demand
        expiresIn: maxWindow - ageMinutes,
        expired: (maxWindow - ageMinutes) <= 0,
        commentLead: null,
      }
    })

    console.log(`[score] returning ${leads.length} leads`)
    return res.status(200).json({ leads, scoredUrls })

  } catch (err) {
    console.error('[score] fatal:', err.message)
    return res.status(500).json({ error: 'Scoring failed' })
  }
}
