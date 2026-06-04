// In-memory IP tracking
const ipStore = new Map()

function getIP(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    '127.0.0.1'
  )
}

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

async function fetchSubreddit(subreddit) {
  try {
    const res = await fetch(
      `https://www.reddit.com/r/${subreddit}/new.json?limit=25`,
      {
        headers: { 'User-Agent': 'Kairo/1.0 lead-discovery' },
        signal: AbortSignal.timeout(8000),
      }
    )
    if (!res.ok) return []
    const data = await res.json()
    return (data?.data?.children || []).map(p => ({
      id: p.data.id,
      title: p.data.title,
      body: (p.data.selftext || '').slice(0, 500),
      url: `https://reddit.com${p.data.permalink}`,
      subreddit: p.data.subreddit,
      createdAt: p.data.created_utc * 1000,
      ups: p.data.ups,
    }))
  } catch {
    return []
  }
}

async function analyzeProduct(content, url) {
  const raw = await callGroq([
    {
      role: 'system',
      content: 'You are a product analyst. Return only raw JSON. No markdown. No explanation.',
    },
    {
      role: 'user',
      content: `Analyze this website and return ONLY this JSON:
{
  "name": "product name",
  "description": "one sentence what it does",
  "targetCustomer": "who uses this",
  "painPoints": ["pain1","pain2","pain3","pain4","pain5"],
  "keywords": ["kw1","kw2","kw3","kw4","kw5"],
  "subreddits": ["sub1","sub2","sub3","sub4","sub5","sub6","sub7"]
}

Pick subreddits where the target customer talks about their problems. No r/ prefix.

URL: ${url}
Content: ${content.slice(0, 3000)}`,
    },
  ], 800)

  const clean = raw.replace(/```json|```/g, '').trim()
  return JSON.parse(clean)
}

async function scorePosts(posts, analysis) {
  if (!posts.length) return []

  const batch = posts.slice(0, 30).map((p, i) => ({
    index: i,
    title: p.title,
    body: p.body.slice(0, 300),
    subreddit: p.subreddit,
  }))

  const raw = await callGroq([
    {
      role: 'system',
      content: 'You are a lead scoring engine. Return only a valid JSON array. No markdown.',
    },
    {
      role: 'user',
      content: `Score these Reddit posts for buying intent relevance to this product.

Product: ${analysis.name}
Description: ${analysis.description}
Target customer: ${analysis.targetCustomer}
Pain points: ${analysis.painPoints.join(', ')}
Keywords: ${analysis.keywords.join(', ')}

Rules:
- score: 1-10 (8+ high intent, 5-7 moderate, below 5 skip)
- signalType: "active" (asking for tools/recommendations) or "passive" (expressing pain)
- reason: one sentence why it matches

Return ONLY a JSON array for posts scoring 5 or above:
[{"index":0,"score":8.5,"signalType":"active","reason":"..."}]

If none qualify return: []

Posts:
${JSON.stringify(batch)}`,
    },
  ], 1500, 0.2)

  try {
    const clean = raw.replace(/```json|```/g, '').trim()
    return JSON.parse(clean)
  } catch {
    return []
  }
}

async function generateReply(post, analysis, signalType) {
  const tone = signalType === 'active'
    ? 'Be direct and helpful. Mention the product naturally but briefly.'
    : 'Lead with empathy about their pain. Add genuine value first. Only mention the product lightly at the end if truly relevant.'

  const raw = await callGroq([
    {
      role: 'system',
      content: `You write Reddit replies for founders. Sound human, genuine, never salesy. Max 120 words. No hashtags. No emojis. ${tone}`,
    },
    {
      role: 'user',
      content: `Write a Reddit reply for this post.

Title: ${post.title}
Body: ${post.body.slice(0, 400)}
Subreddit: r/${post.subreddit}
Signal type: ${signalType}
Product: ${analysis.name} — ${analysis.description}

Write the reply only. No intro. No label.`,
    },
  ], 300, 0.75)

  return raw.trim()
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { url } = req.body
  if (!url) return res.status(400).json({ error: 'URL is required' })

  // Mark IP as used
  const ip = getIP(req)
  const now = Date.now()
  const window = 24 * 60 * 60 * 1000
  const record = ipStore.get(ip)
  if (!record || now > record.resetAt) {
    ipStore.set(ip, { count: 1, resetAt: now + window })
  } else {
    ipStore.set(ip, { ...record, count: record.count + 1 })
  }

  try {
    // Step 1: Fetch website via Jina Reader
    let content = ''
    try {
      const jinaRes = await fetch(`https://r.jina.ai/${url}`, {
        headers: { Accept: 'text/plain' },
        signal: AbortSignal.timeout(12000),
      })
      if (jinaRes.ok) content = await jinaRes.text()
    } catch {
      // Continue — Groq will use the URL alone
    }

    // Step 2: Analyze product
    const analysis = await analyzeProduct(content, url)

    // Step 3: Fetch Reddit posts in parallel
    const subreddits = (analysis.subreddits || ['SaaS', 'indiehackers', 'entrepreneur']).slice(0, 6)
    const postArrays = await Promise.all(subreddits.map(fetchSubreddit))
    const allPosts = postArrays.flat()

    if (!allPosts.length) {
      return res.status(200).json({ analysis, leads: [] })
    }

    // Step 4: Score posts
    const scores = await scorePosts(allPosts, analysis)
    if (!scores.length) {
      return res.status(200).json({ analysis, leads: [] })
    }

    // Step 5: Top 3 posts — generate draft replies
    const top3 = scores
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)

    const leads = await Promise.all(
      top3.map(async scored => {
        const post = allPosts[scored.index]
        if (!post) return null

        const draftReply = await generateReply(post, analysis, scored.signalType)

        const ageMinutes = (Date.now() - post.createdAt) / 60000
        const maxWindow = scored.signalType === 'active' ? 180 : 360
        const expiresIn = Math.max(0, maxWindow - ageMinutes)

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

    return res.status(200).json({
      analysis,
      leads: leads.filter(Boolean),
    })
  } catch (err) {
    console.error('Scan error:', err)
    return res.status(500).json({ error: 'Scan failed. Please try again.' })
  }
}
