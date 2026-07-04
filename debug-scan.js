// debug-scan.js — Temporary debug endpoint to see raw posts and scores
// Remove before launch

async function callGroq(messages, maxTokens = 1000, temperature = 0.3) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'openai/gpt-oss-120b',
      messages,
      max_tokens: maxTokens,
      temperature,
    }),
  })
  const data = await res.json()
  return data.choices?.[0]?.message?.content || ''
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { posts, analysis } = req.body
  if (!posts || !analysis) return res.status(400).json({ error: 'posts and analysis required' })

  // Show first 10 posts raw
  const sample = posts.slice(0, 10).map((p, i) => ({
    index: i,
    title: p.title,
    body: (p.body || '').slice(0, 200),
    subreddit: p.subreddit,
    ageMinutes: Math.round((Date.now() - p.createdAt) / 60000),
  }))

  // Run scoring and return raw Groq response
  const batch = posts.slice(0, 20).map((p, i) => ({
    index: i,
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
      content: `You are qualifying leads for this product:

Product: ${analysis.name}
Category: ${analysis.category || analysis.description}
What it solves: ${analysis.specificProblems?.join(' | ') || analysis.description}
Problem keywords: ${analysis.problemKeywords?.join(', ') || ''}
Competitors: ${analysis.competitors?.join(', ') || 'none listed'}
False positives: ${analysis.falsePositiveSignals?.join(', ') || ''}

Score ALL posts and return scores for every single post — even if it scores 0. Do not skip any.

Return ONLY a JSON array:
[{"index":0,"score":7.5,"signalType":"active","specificProblem":"exact problem","reason":"why","rejected":false,"rejectionReason":""}]

For rejected posts, set rejected:true and fill rejectionReason with which rule caused rejection.

Posts:
${JSON.stringify(batch)}`,
    },
  ], 3000, 0.1)

  return res.status(200).json({
    analysis: {
      name: analysis.name,
      specificProblems: analysis.specificProblems,
      problemKeywords: analysis.problemKeywords,
      falsePositiveSignals: analysis.falsePositiveSignals,
      subreddits: analysis.subreddits,
    },
    samplePosts: sample,
    totalPosts: posts.length,
    rawGroqResponse: raw,
  })
}
