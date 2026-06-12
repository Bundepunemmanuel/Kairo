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

// ─── Score posts against the product ─────────────────────────────────────
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
Specific problems it solves: ${analysis.specificProblems?.join(' | ') || ''}
Competitors it replaces: ${analysis.competitors?.join(', ') || 'none listed'}
False positives — people in the audience who do NOT need this: ${analysis.falsePositiveSignals?.join(', ') || ''}

SCORING — how well does this post match this specific product?
9-10: Person is explicitly experiencing a problem this product solves AND actively seeking a solution or tool
7-8: Person is clearly struggling with a problem this product solves, even if not actively shopping yet
5-6: Problem loosely overlaps — might benefit from this product
Below 5: REJECT

HARD REJECTIONS — these must ALWAYS be rejected:

1. TITLE reveals it is a success story or lesson:
   Reject any title containing: "here's what I learned", "here's how I", "what I learned", "lessons learned", "how I got", "how I built", "I fixed it", "I solved", "I figured out", "what worked for me", "my journey", "I went from", "AMA" (ask me anything about success)
   These people solved the problem already. They are NOT buyers.

2. SELLER not buyer:
   The person IS offering a service that competes with this product.
   Example: if product is a lead gen tool, reject anyone offering lead gen services.

3. GENERAL DISCUSSION — no personal unsolved problem:
   Opinion posts, industry news, advice threads, polls, general questions with no personal pain.

4. BEGINNER content:
   Asking how to start something, tutorials, "how do I learn X".

MANDATORY TEST before including any post:
Complete this sentence: "This person needs ${analysis.name} because RIGHT NOW they are experiencing: ___"
If you cannot fill in a SPECIFIC, CURRENT, UNSOLVED problem — REJECT.

signalType:
"active" = asking for tools, comparing products, looking for alternatives, ready to switch
"passive" = experiencing the pain but not actively shopping for a solution

Return ONLY posts scoring 5+. If nothing qualifies, return [].
[{"index":0,"score":8,"signalType":"active","specificProblem":"their exact current problem","reason":"one specific sentence about their situation"}]

Posts:
${JSON.stringify(batchInput)}`,
      },
    ], 1500, 0.1)

    console.log(`[score] batch ${batchIdx}: ${raw.slice(0, 150)}`)

    try {
      const clean = raw.replace(/```json|```/g, '').trim()
      const match = clean.match(/\[[\s\S]*\]/)
      if (!match) { console.log(`[score] batch ${batchIdx}: no array`); return [] }
      const scored = JSON.parse(match[0])
      console.log(`[score] batch ${batchIdx}: ${scored.length} qualified, indexes: ${scored.map(s => s.index).join(',')}`)
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

// ─── Generate reply ───────────────────────────────────────────────────────
async function generateReply(post, analysis, signalType, specificProblem) {
  const postContext = `Post title: "${post.title}"
Post body: "${(post.body || '').slice(0, 350)}"`

  const instruction = signalType === 'active'
    ? `This person is actively looking for a solution. Write a direct, helpful reply that:
1. Acknowledges their specific situation in one sentence
2. Explains how ${analysis.name} solves their exact problem: "${specificProblem}"
3. Ends naturally — no hard sell`
    : `This person has the pain but isn't shopping yet. Write an empathetic reply that:
1. Validates their specific frustration: "${specificProblem}"
2. Adds a genuine insight or tip
3. Mentions ${analysis.name} briefly and naturally as something that helped with this`

  const raw = await callGroq([
    {
      role: 'system',
      content: `You write Reddit replies. Rules:
- Max 100 words
- Sound like a real person, not marketing
- No hashtags, no emojis, no bullet points
- Never start with "I", "Hey", "Great post", or "As someone who"
- Reference their specific words or situation — not generic advice
- Mention the product once at most, naturally`,
    },
    {
      role: 'user',
      content: `${postContext}
Subreddit: r/${post.subreddit}
Their specific problem: ${specificProblem}

${instruction}

Write only the reply. Nothing else.`,
    },
  ], 400, 0.75)

  const reply = (raw || '').trim()
  if (reply.length < 15) return ''
  // Reject known generic fallbacks
  const genericPhrases = ['lead with genuine value', 'lead with empathy and', 'as an ai', 'i cannot']
  if (genericPhrases.some(p => reply.toLowerCase().includes(p))) return ''
  return reply
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

    const top5 = scored.sort((a, b) => b.score - a.score).slice(0, 5)
    console.log('[score] top5:', top5.map(s => `"${s.post?.title?.slice(0, 35)}" (${s.score})`).join(' | '))

    const leads = await Promise.all(
      top5.map(async ({ post, score, signalType, specificProblem, reason }, i) => {
        try {
          if (!post) { console.log(`[score] lead ${i}: null post`); return null }

          let draftReply = ''
          try {
            draftReply = await generateReply(post, analysis, signalType, specificProblem)
            console.log(`[score] lead ${i}: reply ${draftReply.length} chars`)
          } catch (e) {
            console.log(`[score] lead ${i}: reply error: ${e.message}`)
          }

          const ageMinutes = (Date.now() - (post.createdAt || Date.now())) / 60000
          const maxWindow = signalType === 'active' ? 180 : 360

          return {
            ...post,
            score,
            signalType,
            specificProblem,
            reason,
            draftReply,
            expiresIn: maxWindow - ageMinutes,
            expired: (maxWindow - ageMinutes) <= 0,
            commentLead: null,
          }
        } catch (e) {
          console.log(`[score] lead ${i} error: ${e.message}`)
          return null
        }
      })
    )

    const finalLeads = leads.filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 3)
    console.log(`[score] returning ${finalLeads.length} leads`)
    return res.status(200).json({ leads: finalLeads })

  } catch (err) {
    console.error('[score] fatal:', err.message)
    return res.status(500).json({ error: 'Scoring failed' })
  }
}
