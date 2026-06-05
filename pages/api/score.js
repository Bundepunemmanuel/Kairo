// Scores Reddit posts and generates draft replies
// Called from onboarding.js after browser fetches Reddit posts

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

async function scorePosts(posts, analysis) {
  if (!posts.length) return []

  const batch = posts.slice(0, 25).map((p, i) => ({
    index: i,
    title: p.title,
    body: (p.body || '').slice(0, 200),
    subreddit: p.subreddit,
  }))

  const raw = await callGroq([
    {
      role: 'system',
      content: 'You are a lead scoring engine. Return only a valid JSON array. No markdown. No explanation.',
    },
    {
      role: 'user',
      content: `Score these Reddit posts for relevance to this product. Be generous.

Product: ${analysis.name}
Description: ${analysis.description}
Target customer: ${analysis.targetCustomer}
Pain points: ${analysis.painPoints.join(', ')}
Keywords: ${analysis.keywords.join(', ')}

Rules:
- 8-10: Directly asking for this type of product
- 6-7: Expressing a pain point this product solves
- 4-5: Tangentially related
- Below 4: Skip

signalType: "active" (asking for tools/recs) or "passive" (expressing pain)

Include ALL posts scoring 4+. Return ONLY a JSON array:
[{"index":0,"score":7.5,"signalType":"active","reason":"one sentence"}]

Posts:
${JSON.stringify(batch)}`,
    },
  ], 2000, 0.2)

  try {
    const clean = raw.replace(/```json|```/g, '').trim()
    const match = clean.match(/\[[\s\S]*\]/)
    if (!match) return []
    return JSON.parse(match[0])
  } catch {
    return []
  }
}

async function generateReply(post, analysis, signalType) {
  const tone = signalType === 'active'
    ? 'Be helpful and direct. Mention the product naturally.'
    : 'Lead with empathy. Add value first. Mention product briefly only if relevant.'

  const raw = await callGroq([
    {
      role: 'system',
      content: `You write Reddit replies for founders. Sound human. Max 100 words. No hashtags. No emojis. ${tone}`,
    },
    {
      role: 'user',
      content: `Write a Reddit reply.

Title: ${post.title}
Body: ${(post.body || '').slice(0, 300)}
Subreddit: r/${post.subreddit}
Signal: ${signalType}
Product: ${analysis.name} — ${analysis.description}

Write ONLY the reply text.`,
    },
  ], 300, 0.75)

  return raw.trim()
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { posts, analysis } = req.body
  if (!posts || !analysis) return res.status(400).json({ error: 'posts and analysis required' })

  try {
    let scores = []
    try {
      scores = await scorePosts(posts, analysis)
    } catch {
      scores = []
    }

    // Fallback: return top posts if scoring fails
    if (!scores.length) {
      const fallback = posts.slice(0, 3).map(post => ({
        ...post,
        score: 5.0,
        signalType: 'passive',
        reason: 'Active discussion in your target community',
        draftReply: 'Lead with genuine value and empathy before mentioning your product.',
        expiresIn: 120,
      }))
      return res.status(200).json({ leads: fallback })
    }

    const top3 = scores.sort((a, b) => b.score - a.score).slice(0, 3)

    const leads = await Promise.all(
      top3.map(async scored => {
        const post = posts[scored.index]
        if (!post) return null

        let draftReply = ''
        try {
          draftReply = await generateReply(post, analysis, scored.signalType)
        } catch {
          draftReply = 'Could not generate reply. Try refreshing.'
        }

        const ageMinutes = (Date.now() - post.createdAt) / 60000
        const maxWindow = scored.signalType === 'active' ? 180 : 360
        const expiresIn = Math.max(10, maxWindow - ageMinutes)

        return {
          ...post,
          score: scored.score,
          signalType: scored.signalType,
          reason: scored.reason,
          draftReply,
          expiresIn,
        }
      })
    )

    return res.status(200).json({ leads: leads.filter(Boolean) })
  } catch (err) {
    console.error('Score error:', err)
    return res.status(500).json({ error: 'Scoring failed' })
  }
}
