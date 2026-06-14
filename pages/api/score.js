// score.js — Simple, robust, no silent failures
// Groq llama-3.3-70b → scoring
// Groq qwen-qwq-32b → replies (Cerebras fallback if rate limited)

async function groq(messages, maxTokens, temperature, model = 'llama-3.3-70b-versatile') {
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
    })
    const data = await res.json()
    if (data.error) { console.log(`[groq:${model}] error:`, data.error.message); return '' }
    return data.choices?.[0]?.message?.content || ''
  } catch (e) {
    console.log(`[groq:${model}] fetch error:`, e.message)
    return ''
  }
}

async function cerebras(messages, maxTokens, temperature) {
  try {
    const res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.CEREBRAS_API_KEY}` },
      body: JSON.stringify({ model: 'llama-3.3-70b', messages, max_tokens: maxTokens, temperature }),
    })
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
// Takes up to 20 posts, returns array of { post, score, signalType, specificProblem, reason }
async function scorePosts(posts, analysis) {
  // Take first 20 posts — enough signal, avoids token limits
  const sample = posts.slice(0, 20)

  const input = sample.map((p, i) => ({
    i,
    title: p.title,
    body: (p.body || '').slice(0, 300),
    sub: p.subreddit,
  }))

  const raw = await groq([
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
5-6: Clear overlap with product's problem space
0-4: Reject

ALWAYS REJECT:
- Posts that are SHARING not ASKING (announcements, launches, success stories, tips, advice, AMAs)
- Wrong business type for this product
- Person already banned/rejected by this product or its competitors
- General discussion, opinions, news with no personal problem
- Networking posts (finding connections, referrals, relationships)
- Beginner asking how to start with no existing product
- Platform-specific pain this product doesn't solve

Only include posts scoring 5+.
Return [] if nothing qualifies.

Format: [{"i":0,"score":8,"type":"active","problem":"exact problem they have","why":"one sentence from their words"}]
"type" is "active" (seeking solution now) or "passive" (has pain, not shopping)

Posts: ${JSON.stringify(input)}`,
    },
  ], 1500, 0.1)

  console.log(`[score] raw (150): ${raw.slice(0, 150)}`)

  const scored = parseJSON(raw)
  if (!scored) { console.log('[score] parse failed'); return [] }

  console.log(`[score] groq returned ${scored.length} qualified`)

  return scored
    .filter(s => s.score >= 5 && typeof s.i === 'number' && s.i >= 0 && s.i < sample.length)
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
}

// ─── Main handler ─────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { posts, analysis } = req.body
  if (!posts?.length || !analysis) return res.status(400).json({ error: 'posts and analysis required' })

  console.log(`[score] ${posts.length} posts | product: ${analysis.name}`)

  try {
    const scored = await scorePosts(posts, analysis)
    console.log(`[score] qualified: ${scored.length}`)

    if (!scored.length) return res.status(200).json({ leads: [] })

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
    return res.status(200).json({ leads })

  } catch (err) {
    console.error('[score] fatal:', err.message)
    return res.status(500).json({ error: 'Scoring failed' })
  }
}
