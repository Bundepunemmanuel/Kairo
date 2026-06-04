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
      `https://www.reddit.com/r/${subreddit}/new.rss`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Kairo/1.0)',
          'Accept': 'application/rss+xml, application/xml, text/xml',
        },
        signal: AbortSignal.timeout(8000),
      }
    )
    if (!res.ok) return []
    const text = await res.text()

    const posts = []
    const itemRegex = /<item>([\s\S]*?)<\/item>/g
    let match

    while ((match = itemRegex.exec(text)) !== null) {
      const item = match[1]
      const title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/))?.[1] || ''
      const link = item.match(/<link>(.*?)<\/link>/)?.[1] || ''
      const description = (item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) || item.match(/<description>(.*?)<\/description>/))?.[1] || ''
      const pubDate = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || ''
      const cleanDesc = description.replace(/<[^>]*>/g, '').slice(0, 500)
      const createdAt = pubDate ? new Date(pubDate).getTime() : Date.now()

      if (title && link) {
        posts.push({
          id: link.split('/').filter(Boolean).pop() || Math.random().toString(36).slice(2),
          title: title.trim(),
          body: cleanDesc.trim(),
          url: link.trim(),
          subreddit,
          createdAt,
          ups: 0,
        })
      }
    }

    return posts
  } catch {
    return []
  }
}

async function analyzeProduct(content, url) {
  const raw = await callGroq([
    {
      role: 'system',
      content: 'You are a product analyst. Return only raw JSON. No markdown. No explanation. No code blocks.',
    },
    {
      role: 'user',
      content: `Analyze this website and return ONLY this JSON structure with no other text:
{
  "name": "product name",
  "description": "one sentence what it does",
  "targetCustomer": "who uses this",
  "painPoints": ["pain1","pain2","pain3","pain4","pain5"],
  "keywords": ["kw1","kw2","kw3","kw4","kw5"],
  "subreddits": ["sub1","sub2","sub3","sub4","sub5","sub6","sub7"]
}

Pick subreddits where the target customer actively discusses problems. Use real subreddit names without r/ prefix. Popular choices: SaaS, indiehackers, entrepreneur, startups, smallbusiness, solopreneur, marketing, productivity, freelance, webdev, programming.

URL: ${url}
Content: ${content.slice(0, 3000)}`,
    },
  ], 800)

  const clean = raw.replace(/```json|```/g, '').trim()
  return JSON.parse(clean)
}

async function scorePosts(posts, analysis) {
  if (!posts.length) return []

  const batch = posts.slice(0, 25).map((p, i) => ({
    index: i,
    title: p.title,
    body: p.body.slice(0, 200),
    subreddit: p.subreddit,
  }))

  const raw = await callGroq([
    {
      role: 'system',
      content: 'You are a lead scoring engine. You MUST return a valid JSON array. No markdown. No explanation. No code blocks. Only the JSON array.',
    },
    {
      role: 'user',
      content: `Score these Reddit posts for relevance to this product. Be generous — include anything that could be a potential customer signal.

Product: ${analysis.name}
Description: ${analysis.description}
Target customer: ${analysis.targetCustomer}
Pain points: ${analysis.painPoints.join(', ')}
Keywords: ${analysis.keywords.join(', ')}

Scoring rules:
- 8-10: Directly asking for this type of product or tool
- 6-7: Expressing a pain point this product solves
- 4-5: Tangentially related, might be interested
- Below 4: Not relevant

Signal types:
- "active": Person is actively looking for a solution, asking for recommendations, comparing tools
- "passive": Person is expressing frustration or pain but not actively shopping

IMPORTANT: Include ALL posts scoring 4 or above. Be generous with scoring.

Return ONLY a raw JSON array like this (no other text):
[{"index":0,"score":7.5,"signalType":"active","reason":"Person is asking for tool recommendations that match this product"}]

If truly nothing is relevant return: []

Posts to score:
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
    ? 'Be helpful and direct. You can mention the product naturally but do not be salesy.'
    : 'Lead with genuine empathy. Add real value. Only mention the product briefly if truly relevant.'

  const raw = await callGroq([
    {
      role: 'system',
      content: `You write Reddit replies for founders. Sound human and genuine. Max 100 words. No hashtags. No emojis. ${tone}`,
    },
    {
      role: 'user',
      content: `Write a Reddit reply for this post.

Title: ${post.title}
Body: ${post.body.slice(0, 300)}
Subreddit: r/${post.subreddit}
Signal type: ${signalType}
Product: ${analysis.name} — ${analysis.description}

Write ONLY the reply text. Nothing else.`,
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

  const ip = getIP(req)
  const now = Date.now()
  const windowMs = 24 * 60 * 60 * 1000
  const record = ipStore.get(ip)
  if (!record || now > record.resetAt) {
    ipStore.set(ip, { count: 1, resetAt: now + windowMs })
  } else {
    ipStore.set(ip, { ...record, count: record.count + 1 })
  }

  try {
    let content = ''
    try {
      const jinaRes = await fetch(`https://r.jina.ai/${url}`, {
        headers: { Accept: 'text/plain' },
        signal: AbortSignal.timeout(12000),
      })
      if (jinaRes.ok) content = await jinaRes.text()
    } catch {
      // Continue with empty content
    }

    let analysis
    try {
      analysis = await analyzeProduct(content, url)
    } catch {
      analysis = {
        name: 'Your Product',
        description: 'A tool for founders',
        targetCustomer: 'startup founders and entrepreneurs',
        painPoints: ['finding customers', 'distribution', 'marketing', 'growth', 'sales'],
        keywords: ['startup', 'saas', 'founder', 'tool', 'software'],
        subreddits: ['SaaS', 'indiehackers', 'entrepreneur', 'startups', 'solopreneur'],
      }
    }

    const subreddits = (analysis.subreddits || ['SaaS', 'indiehackers', 'entrepreneur']).slice(0, 5)
    const postArrays = await Promise.all(subreddits.map(fetchSubreddit))
    const allPosts = postArrays.flat()

    if (!allPosts.length) {
      return res.status(200).json({ analysis, leads: [] })
    }

    let scores = []
    try {
      scores = await scorePosts(allPosts, analysis)
    } catch {
      scores = []
    }

    if (!scores.length) {
      const fallbackLeads = allPosts
        .sort((a, b) => b.ups - a.ups)
        .slice(0, 3)
        .map(post => ({
          ...post,
          score: 5.0,
          signalType: 'passive',
          reason: 'Trending post in your target community',
          draftReply: 'Review this post and craft a response that leads with value before mentioning your product.',
          expiresIn: 120,
        }))
      return res.status(200).json({ analysis, leads: fallbackLeads })
    }

    const top3 = scores
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)

    const leads = await Promise.all(
      top3.map(async scored => {
        const post = allPosts[scored.index]
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

    return res.status(200).json({
      analysis,
      leads: leads.filter(Boolean),
    })
  } catch (err) {
    console.error('Scan error:', err)
    return res.status(500).json({ error: 'Scan failed. Please try again.' })
  }
                                          }
