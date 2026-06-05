// Analyzes a product URL using Jina Reader + Groq
// Called from onboarding.js after user pastes their URL

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { url } = req.body
  if (!url) return res.status(400).json({ error: 'URL required' })

  // Fetch website content via Jina Reader
  let content = ''
  try {
    const jinaRes = await fetch(`https://r.jina.ai/${url}`, {
      headers: { Accept: 'text/plain' },
      signal: AbortSignal.timeout(12000),
    })
    if (jinaRes.ok) content = await jinaRes.text()
  } catch { /* continue with empty */ }

  // Analyze with Groq
  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'system',
            content: 'You are a product analyst. Return only raw JSON. No markdown. No explanation. No code blocks.',
          },
          {
            role: 'user',
            content: `Analyze this website and return ONLY this JSON with no other text:
{
  "name": "product name",
  "description": "one sentence what it does",
  "targetCustomer": "who uses this",
  "painPoints": ["pain1","pain2","pain3","pain4","pain5"],
  "keywords": ["kw1","kw2","kw3","kw4","kw5"],
  "subreddits": ["sub1","sub2","sub3","sub4","sub5","sub6","sub7"]
}

Pick subreddits where the target customer discusses problems. No r/ prefix. Good choices: SaaS, indiehackers, entrepreneur, startups, smallbusiness, solopreneur, marketing, productivity, freelance, webdev.

URL: ${url}
Content: ${content.slice(0, 3000)}

IMPORTANT: If the content above is thin or empty, analyze the URL and domain name itself to infer what the product does and who uses it. Always return subreddits where the actual target customer spends time, not generic startup subreddits.`,
          },
        ],
        max_tokens: 800,
        temperature: 0.3,
      }),
    })

    const data = await groqRes.json()
    const raw = data.choices?.[0]?.message?.content || ''
    const clean = raw.replace(/```json|```/g, '').trim()
    const analysis = JSON.parse(clean)
    return res.status(200).json({ analysis })
  } catch {
    // Fallback if Groq or JSON parse fails
    return res.status(200).json({
      analysis: {
        name: 'Your Product',
        description: 'A tool for founders',
        targetCustomer: 'startup founders and entrepreneurs',
        painPoints: ['finding customers', 'distribution', 'marketing', 'growth', 'sales'],
        keywords: ['startup', 'saas', 'founder', 'tool', 'software'],
        subreddits: ['SaaS', 'indiehackers', 'entrepreneur', 'startups', 'solopreneur'],
      }
    })
  }
}
