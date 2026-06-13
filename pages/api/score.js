// score.js
// Groq llama-3.3-70b → scoring (instruction-following, strict JSON)
// Groq qwen-qwq-32b → replies (natural language, human-sounding)

async function callGroqScore(messages, maxTokens = 1500) {
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
      temperature: 0.1,
    }),
  })
  const data = await res.json()
  if (data.error) console.log('[groq-score] error:', data.error.message)
  return data.choices?.[0]?.message?.content || ''
}

async function callGroqReply(messages, maxTokens = 2000) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'qwen-qwq-32b',
      messages,
      max_tokens: maxTokens,
      temperature: 0.7,
    }),
  })
  const data = await res.json()
  if (data.error) {
    console.log('[groq-reply] error:', data.error.message, '— falling back to llama')
    // Fallback to llama if qwen fails
    const res2 = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages,
        max_tokens: maxTokens,
        temperature: 0.7,
      }),
    })
    const data2 = await res2.json()
    return data2.choices?.[0]?.message?.content || ''
  }
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

    const raw = await callGroqScore([
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

SCORING — match on EXPLICIT pain, not inference:
The problem must be clearly stated in the post. Do not infer someone needs this product just because they run a business or mention a related topic.

9-10: Person EXPLICITLY experiencing one of the specific problems above AND actively seeking a solution
7-8: Person clearly describes one of the specific problems above, not actively shopping yet
5-6: Pain directly and specifically relates to the problems above
Below 5: REJECT

HARD REJECTIONS — always reject these regardless of topic match:

1. WRONG BUSINESS TYPE
Target customer: "${analysis.customerBusinessType || 'SaaS or software product'}"
Reject anyone whose business clearly doesn't match. Physical products, brick-and-mortar, high-risk merchants, research chemicals, dropshipping.

2. PRODUCT EXPLICITLY REJECTED OR BANNED
If the post mentions that THIS product or its direct competitors already rejected or banned them — REJECT. They cannot be a customer.
Example: "Stripe banned my account", "rejected by Stripe" → reject for Stripe leads.
Example: "Zapier doesn't support this" → reject for Zapier leads.

3. BEGINNER / NOT BUILT YET
Person is asking how to start building something, has no existing product or business. Reject "I want to build a website that accepts payments" if they haven't built it yet.

4. SUCCESS STORY
Title contains: "here's what I learned", "how I got", "how I built", "I fixed", "I solved", "my journey", "I went from", "tips from my"

5. NETWORKING / CONNECTIONS
Finding business connections, building relationships, meeting people.

6. EMOTIONAL VENTING
Pure burnout/exhaustion with no request for a tool or solution.

7. SELLER NOT BUYER
Person offers a competing service.

8. GENERAL DISCUSSION
No specific personal unsolved problem.

signalType: "active" = seeking tools/alternatives now | "passive" = has the pain, not shopping

Return ONLY posts scoring 5+, or [] if nothing qualifies:
[{"index":0,"score":8,"signalType":"active","specificProblem":"exact pain right now","reason":"one sentence quoting their actual words"}]

Posts:
${JSON.stringify(batchInput)}`,
      },
    ])

    console.log(`[score] batch ${batchIdx}: ${raw.slice(0, 150)}`)

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

// ─── Generate replies via Qwen ────────────────────────────────────────────
async function generateReplies(leads, analysis) {
  if (!leads.length) return []

  const leadsInput = leads.map((l, i) => ({
    index: i,
    title: l.post.title,
    body: (l.post.body || '').slice(0, 150),
    subreddit: l.post.subreddit,
    signalType: l.signalType,
    specificProblem: l.specificProblem,
  }))

  const raw = await callGroqReply([
    {
      role: 'system',
      content: 'You write Reddit replies. Return only a raw JSON array. No markdown. No thinking out loud. No explanation outside the JSON.',
    },
    {
      role: 'user',
      content: `Write a Reddit reply for each lead.

Product: ${analysis.name} — ${analysis.description}

Reply rules:
- 60-90 words per reply
- Sound like a helpful real person, not a marketer
- No hashtags, no emojis, no bullet points
- Never open with: I, Hey, Great, Wow, As someone, That's
- Reference their specific words or situation directly
- Mention ${analysis.name} once naturally — not as a pitch
- active signal: be direct, lead with the solution to their specific problem
- passive signal: empathize first, mention product briefly at end

Return this exact JSON array — one entry per lead, index must match:
[{"index":0,"reply":"reply text"},{"index":1,"reply":"reply text"},{"index":2,"reply":"reply text"}]

Leads:
${JSON.stringify(leadsInput)}`,
    },
  ])

  console.log(`[score] replies raw (200): ${raw.slice(0, 200)}`)

  try {
    // qwen-qwq-32b sometimes includes <think>...</think> blocks — strip them
    const stripped = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
    const clean = stripped.replace(/```json|```/g, '').trim()
    const match = clean.match(/\[[\s\S]*\]/)
    if (!match) { console.log('[score] replies: no array'); return leads.map(() => '') }
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

  console.log(`[score] received ${posts.length} posts for: ${analysis.name} | type: ${analysis.customerBusinessType || 'unknown'}`)

  try {
    const scored = await scoreAgainstProduct(posts, analysis)
    console.log(`[score] total qualified: ${scored.length}`)

    if (!scored.length) return res.status(200).json({ leads: [] })

    const top3 = scored.sort((a, b) => b.score - a.score).slice(0, 3)
    console.log('[score] top3:', top3.map(s => `"${s.post?.title?.slice(0, 40)}" (${s.score})`).join(' | '))

    const replies = await generateReplies(top3, analysis)
    console.log(`[score] replies: ${replies.filter(r => r.length > 0).length}/${top3.length}`)

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
