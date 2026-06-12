// score.js — Groq lead scoring pipeline

async function callGroq(messages, maxTokens = 1000, temperature = 0.3) {
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
  return data.choices?.[0]?.message?.content || ''
}

// ─── Score posts ──────────────────────────────────────────────────────────
async function scoreAgainstProduct(posts, analysis) {
  if (!posts.length) return []

  const BATCH_SIZE = 15
  const batches = []
  for (let i = 0; i < posts.length; i += BATCH_SIZE) {
    batches.push(posts.slice(i, i + BATCH_SIZE))
  }

  console.log(`[score] scoring ${posts.length} posts in ${batches.length} batches`)

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
Specific problems it solves: ${analysis.specificProblems?.join(' | ') || ''}
Competitors: ${analysis.competitors?.join(', ') || 'none listed'}
Target customer: ${analysis.targetCustomer || 'founders and builders with software products'}
False positives (audience but NOT buyers): ${analysis.falsePositiveSignals?.join(', ') || ''}

SCORING:
9-10: Person explicitly experiencing a problem this product solves, actively seeking a solution
7-8: Clearly struggling with a problem this product solves
5-6: Problem loosely overlaps
Below 5: REJECT

HARD REJECTIONS — always reject these:

1. SUCCESS STORY / LESSONS POST — title contains any of:
"here's what I learned", "what I learned", "lessons learned", "how I got", "how I built",
"I fixed", "I solved", "here's how I", "what worked", "my journey", "I went from X to Y",
"sharing what I", "tips from", "advice from". These people solved the problem — NOT buyers.

2. WRONG CUSTOMER TYPE — reject if the person's business type does not match the product's target customer.
Example: if the product serves SaaS/software founders, reject physical product businesses, brick-and-mortar, freelancers looking for clients, agencies.

3. NETWORKING / CONNECTIONS — reject posts about finding business connections, building relationships, or meeting people. This is not a distribution problem.

4. SELLER NOT BUYER — person is offering a service that competes with this product.

5. NO PERSONAL PROBLEM — general discussion, opinion, news, polls with no specific personal pain.

6. BEGINNER — asking how to start something from scratch.

MANDATORY: Complete this sentence before including any post:
"This person needs ${analysis.name} because RIGHT NOW they are experiencing: [specific unsolved problem]"
Cannot fill it in specifically? REJECT.

signalType: "active" = seeking tools/alternatives now | "passive" = has the pain, not shopping yet

Return ONLY posts scoring 5+, or [] if nothing qualifies:
[{"index":0,"score":8,"signalType":"active","specificProblem":"their exact problem","reason":"one sentence"}]

Posts:
${JSON.stringify(batchInput)}`,
      },
    ], 1500, 0.1)

    console.log(`[score] batch ${batchIdx}: ${raw.slice(0, 100)}`)

    try {
      const clean = raw.replace(/```json|```/g, '').trim()
      const match = clean.match(/\[[\s\S]*\]/)
      if (!match) { console.log(`[score] batch ${batchIdx}: no array found`); return [] }
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
      console.log(`[score] batch ${batchIdx} error: ${err.message}`)
      return []
    }
  }))

  return batchResults.flat()
}

// ─── Generate all replies in one Groq call ───────────────────────────────
// Batching all replies into a single call avoids rate limit issues
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
Rules for every reply:
- Max 100 words
- Sound like a real person, not marketing copy  
- No hashtags, emojis, or bullet points
- Never start with "I", "Hey", "Great post", or "As someone who"
- Reference their specific words or situation
- Mention the product once at most, naturally
- Return only raw JSON array`,
    },
    {
      role: 'user',
      content: `Write a Reddit reply for each lead. 

Product: ${analysis.name} — ${analysis.description}

For "active" signal: be direct, acknowledge their situation, explain how ${analysis.name} solves their exact problem.
For "passive" signal: lead with empathy, validate their frustration, add value, mention ${analysis.name} briefly at the end.

Return a JSON array with one reply per lead:
[{"index":0,"reply":"the reply text here"}]

Leads:
${JSON.stringify(leadsInput)}`,
    },
  ], 1200, 0.75)

  console.log(`[score] replies raw: ${raw.slice(0, 150)}`)

  try {
    const clean = raw.replace(/```json|```/g, '').trim()
    const match = clean.match(/\[[\s\S]*\]/)
    if (!match) return leads.map(() => '')
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

  console.log(`[score] received ${posts.length} posts for: ${analysis.name}`)

  try {
    const scored = await scoreAgainstProduct(posts, analysis)
    console.log(`[score] total qualified: ${scored.length}`)

    if (!scored.length) return res.status(200).json({ leads: [] })

    const top3 = scored.sort((a, b) => b.score - a.score).slice(0, 3)
    console.log('[score] top3:', top3.map(s => `"${s.post?.title?.slice(0, 40)}" (${s.score})`).join(' | '))

    // Generate all replies in one Groq call
    const replies = await generateReplies(top3, analysis)
    console.log(`[score] replies generated: ${replies.filter(r => r.length > 0).length}/${top3.length}`)

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
