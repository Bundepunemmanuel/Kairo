// score.js — Two-model pipeline
// Cerebras llama-3.3-70b → scoring batches (fast, free, parallel)
// Groq llama-3.3-70b → reply generation (quality, one batched call)

// ─── Cerebras call (scoring) ──────────────────────────────────────────────
async function callCerebras(messages, maxTokens = 1000) {
  const res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.CEREBRAS_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b',
      messages,
      max_tokens: maxTokens,
      temperature: 0.1,
    }),
  })
  const data = await res.json()
  if (data.error) console.log('[cerebras] error:', data.error.message)
  return data.choices?.[0]?.message?.content || ''
}

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

  console.log(`[score] scoring ${posts.length} posts in ${batches.length} batches via Cerebras`)

  const batchResults = await Promise.all(batches.map(async (batch, batchIdx) => {
    const batchInput = batch.map((p, localIdx) => ({
      index: localIdx,
      title: p.title,
      body: (p.body || '').slice(0, 400),
      subreddit: p.subreddit,
    }))

    const raw = await callCerebras([
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

SCORING:
9-10: Person explicitly experiencing a problem this product solves, actively seeking a solution
7-8: Clearly struggling with a problem this product solves
5-6: Problem loosely overlaps
Below 5: REJECT

HARD REJECTIONS — always reject:

1. WRONG BUSINESS TYPE:
The target customer is: "${analysis.customerBusinessType || 'SaaS or software product'}"
Reject anyone whose business type does not match this. Physical product sellers, dropshippers, brick-and-mortar businesses, sourcing companies, backpack brands — if the product targets software founders, these are NOT buyers.

2. SUCCESS STORY / LESSON POST — title contains any of:
"here's what I learned", "what I learned", "lessons learned", "how I got", "how I built", "I fixed", "I solved", "here's how I", "what worked", "my journey", "I went from", "sharing what I", "tips from my experience"
These people solved their problem. NOT buyers.

3. NETWORKING / CONNECTIONS:
Posts about finding business connections, building relationships, meeting people, LinkedIn networking. This is NOT a distribution or customer acquisition problem.

4. EMOTIONAL VENTING WITHOUT BUYING SIGNAL:
Posts expressing burnout, exhaustion, or overwhelm WITHOUT asking for a specific tool or solution. Sympathy posts are not leads.

5. SELLER NOT BUYER:
Person offers a service that competes with this product.

6. GENERAL DISCUSSION:
No specific personal unsolved problem. Opinion, news, polls, advice-giving.

7. BEGINNER:
Asking how to start something from scratch.

MANDATORY TEST:
Complete: "This person needs ${analysis.name} because RIGHT NOW they are experiencing: [specific problem]"
If you cannot fill in a specific current unsolved problem that this product actually solves — REJECT.

signalType: "active" = seeking tools/alternatives now | "passive" = has the pain, not shopping yet

Return ONLY posts scoring 5+, or [] if nothing qualifies:
[{"index":0,"score":8,"signalType":"active","specificProblem":"their exact problem","reason":"one sentence referencing their actual words"}]

Posts:
${JSON.stringify(batchInput)}`,
      },
    ], 1500)

    console.log(`[score] batch ${batchIdx}: ${raw.slice(0, 100)}`)

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
      content: `You write Reddit replies for a founder promoting their product.
Rules:
- Max 100 words per reply
- Sound like a real person, not marketing
- No hashtags, emojis, or bullet points
- Never start with "I", "Hey", "Great post", or "As someone who"
- Reference their specific situation, not generic advice
- Mention the product once at most, naturally
- Return only a raw JSON array, no markdown`,
    },
    {
      role: 'user',
      content: `Write one Reddit reply for each lead below.

Product: ${analysis.name} — ${analysis.description}
Target customer: ${analysis.targetCustomer || ''}

Instructions per signal type:
- "active": Person is actively seeking a solution. Be direct. Acknowledge their situation, explain how ${analysis.name} solves their exact problem, end naturally without hard sell.
- "passive": Person has the pain but isn't shopping. Lead with empathy, validate their specific frustration, add a genuine insight, mention ${analysis.name} briefly at the end only if it fits naturally.

Return a JSON array — one object per lead:
[{"index":0,"reply":"reply text here"},{"index":1,"reply":"reply text here"}]

Leads:
${JSON.stringify(leadsInput)}`,
    },
  ], 1200)

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
