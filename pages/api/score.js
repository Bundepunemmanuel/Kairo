// score.js — Two-model pipeline
// Cerebras llama-3.3-70b → scoring batches (fast, free, parallel)
// Groq llama-3.3-70b → reply generation (quality, one batched call)

// Cerebras removed — Groq handles all calls

// ─── Groq call (replies) ──────────────────────────────────────────────────
async function callGroq(messages, maxTokens = 1000, temperature = 0.75) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages,
      max_tokens: maxTokens,
      temperature,
    }),
  })
  const data = await res.json()
  if (data.error) console.log('[groq] error:', data.error.message)
  return data.choices?.[0]?.message?.content || ''
}

// ─── Score posts via Cerebras ─────────────────────────────────────────────
async function scoreAgainstProduct(posts, analysis) {
  if (!posts.length) return []

  const BATCH_SIZE = 15
  const batches = []
  for (let i = 0; i < posts.length; i += BATCH_SIZE) {
    batches.push(posts.slice(i, i + BATCH_SIZE))
  }

  console.log(`[score] scoring ${posts.length} posts in ${batches.length} batches via Groq`)

  const batchResults = await Promise.all(batches.map(async (batch, batchIdx) => {
    const batchInput = batch.map((p, localIdx) => ({
      index: localIdx,
      title: p.title,
      body: (p.body || '').slice(0, 400),
      subreddit: p.subreddit,
    }))

    const raw = await callGroq([
      {
        role: 'system',
        content: 'You are a lead qualification engine. Return only a valid JSON array. No markdown. No explanation.',
      },
      {
        role: 'user',
        content: `Find Reddit leads for this product:

Product: ${analysis.name}
What it does: ${analysis.description}
Category: ${analysis.category || ''}
Target customer: ${analysis.targetCustomer || ''}
Customer business type: ${analysis.customerBusinessType || ''}
Specific problems it solves: ${analysis.specificProblems?.join(' | ') || ''}
Competitors: ${analysis.competitors?.join(', ') || 'none'}
False positives (wrong audience): ${analysis.falsePositiveSignals?.join(', ') || ''}

SCORING — does this person have the UNDERLYING PAIN this product solves?
The product: ${analysis.name}
The product solves these SPECIFIC problems: ${analysis.specificProblems?.join(' | ') || ''}

IMPORTANT: Score based on whether the person is experiencing one of the SPECIFIC problems listed above.
Do NOT score based on general audience overlap.
Do NOT infer that someone needs the product just because they run a business.
The problem must be EXPLICIT in the post — not something you imagine they might have.

9-10: Person is EXPLICITLY experiencing one of the specific problems above AND actively seeking a solution or tool
7-8: Person clearly describes experiencing one of the specific problems above, even if not actively shopping
5-6: Person describes a pain that directly and specifically relates to the problems above
Below 5: REJECT — especially reject if the match is a stretch or inference

HARD REJECTIONS:

1. WRONG BUSINESS TYPE — target customer runs: "${analysis.customerBusinessType || 'SaaS or software product'}"
Reject physical product businesses, dropshippers, brick-and-mortar, sourcing companies, backpack brands, mechanic shops. Only include if they match the target business type.

2. SUCCESS STORY — title contains: "here's what I learned", "what I learned", "how I got", "how I built", "I fixed", "I solved", "here's how I", "my journey", "I went from", "tips from my"
These people already solved the problem. NOT buyers.

3. NETWORKING POSTS — finding connections, building relationships, meeting people. Not a customer acquisition problem.

4. PURE EMOTIONAL VENTING — burnout or exhaustion posts with no request for help or solution. Not a buying signal.

5. SELLER NOT BUYER — person offers a competing service.

6. NO PERSONAL PROBLEM — general opinion, news, advice-giving, polls.

7. BEGINNER — asking how to start from scratch with no existing product.

signalType: "active" = seeking tools or alternatives now | "passive" = experiencing the pain, not shopping yet

Return ONLY posts scoring 5+, or [] if nothing qualifies:
[{"index":0,"score":8,"signalType":"active","specificProblem":"exact pain they have right now","reason":"one sentence quoting or referencing their actual words"}]

Posts:
${JSON.stringify(batchInput)}`,
      },
    ], 1500)

    console.log(`[score] batch ${batchIdx} raw (200 chars): ${raw.slice(0, 200)}`)

    try {
      const clean = raw.replace(/```json|```/g, '').trim()
      const match = clean.match(/\[[\s\S]*\]/)
      if (!match) { console.log(`[score] batch ${batchIdx}: no array`); return [] }
      const scored = JSON.parse(match[0])
      console.log(`[score] batch ${batchIdx}: ${scored.length} qualified`)
      return scored
        .filter(s => s.score >= 5 && typeof s.index === 'number' && s.index >= 0 && s.index < batch.length)
        .map(s => ({
          post: batch[s.index],
          score: s.score,
          signalType: s.signalType || 'passive',
          specificProblem: s.specificProblem || '',
          reason: s.reason || '',
        }))
    } catch (err) {
      console.log(`[score] batch ${batchIdx} parse error: ${err.message}`)
      return []
    }
  }))

  return batchResults.flat()
}

// ─── Generate all replies in one Groq call ────────────────────────────────
async function generateReplies(leads, analysis) {
  if (!leads.length) return []

  const leadsInput = leads.map((l, i) => ({
    index: i,
    title: l.post.title,
    body: (l.post.body || '').slice(0, 250),
    subreddit: l.post.subreddit,
    signalType: l.signalType,
    specificProblem: l.specificProblem,
  }))

  const raw = await callGroq([
    {
      role: 'system',
      content: 'You write Reddit replies. Return only a raw JSON array. No markdown. No explanation.',
    },
    {
      role: 'user',
      content: `Write a Reddit reply for each lead.

Product: ${analysis.name} — ${analysis.description}

Rules per reply:
- 60-90 words
- Sound like a real helpful person
- No hashtags, emojis, bullet points
- Never open with: I, Hey, Great, Wow, As someone
- Use their specific words or situation
- Mention ${analysis.name} once naturally
- active: be direct, lead with the solution
- passive: empathize first, product at end

Return this exact format:
[{"index":0,"reply":"reply text"},{"index":1,"reply":"reply text"},{"index":2,"reply":"reply text"}]

Leads:
${JSON.stringify(leadsInput)}`,
    },
  ], 1600, 0.7)

  console.log(`[score] replies raw: ${raw.slice(0, 150)}`)

  try {
    const clean = raw.replace(/```json|```/g, '').trim()
    const match = clean.match(/\[[\s\S]*\]/)
    if (!match) { console.log('[score] replies: no array found'); return leads.map(() => '') }
    const replies = JSON.parse(match[0])
    return leads.map((_, i) => {
      const r = replies.find(x => x.index === i)
      const reply = (r?.reply || '').trim()
      if (reply.length < 15) return ''
      if (['as an ai', 'i cannot', 'lead with genuine'].some(p => reply.toLowerCase().includes(p))) return ''
      return reply
    })
  } catch (err) {
    console.log(`[score] replies parse error: ${err.message}`)
    return leads.map(() => '')
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { posts, analysis } = req.body
  if (!posts || !analysis) return res.status(400).json({ error: 'posts and analysis required' })

  console.log(`[score] received ${posts.length} posts for: ${analysis.name} | customer: ${analysis.customerBusinessType || 'unknown'}`)

  try {
    // Cerebras: score all posts in parallel batches
    const scored = await scoreAgainstProduct(posts, analysis)
    console.log(`[score] total qualified: ${scored.length}`)

    if (!scored.length) return res.status(200).json({ leads: [] })

    const top3 = scored.sort((a, b) => b.score - a.score).slice(0, 3)
    console.log('[score] top3:', top3.map(s => `"${s.post?.title?.slice(0, 40)}" (${s.score})`).join(' | '))

    // Groq: generate all replies in one call
    const replies = await generateReplies(top3, analysis)
    console.log(`[score] replies: ${replies.filter(r => r.length > 0).length}/${top3.length} succeeded`)

    const leads = top3.map(({ post, score, signalType, specificProblem, reason }, i) => {
      if (!post) return null
      const ageMinutes = (Date.now() - (post.createdAt || Date.now())) / 60000
      const maxWindow = signalType === 'active' ? 180 : 360
      return {
        ...post,
        score,
        signalType,
        specificProblem,
        reason,
        draftReply: replies[i] || '',
        expiresIn: maxWindow - ageMinutes,
        expired: (maxWindow - ageMinutes) <= 0,
        commentLead: null,
      }
    }).filter(Boolean)

    console.log(`[score] returning ${leads.length} leads`)
    return res.status(200).json({ leads })

  } catch (err) {
    console.error('[score] fatal:', err.message)
    return res.status(500).json({ error: 'Scoring failed' })
  }
}
