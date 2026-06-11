// analyze.js — Product analysis: extracts specific problems, not just audience
// Redesigned to drive problem-matching instead of audience-matching

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
            content: `Analyze this product and extract the SPECIFIC PROBLEMS it solves — not the audience, not the features, the exact problems.

Return ONLY this JSON:
{
  "name": "product name",
  "description": "one sentence: what it does and for whom",
  "category": "the product category (e.g. 'transactional email API', 'project management tool', 'Reddit lead finder')",
  "specificProblems": [
    "exact problem statement in the language a frustrated user would write on Reddit, 5-8 items",
    "e.g. for an email API: 'transactional emails going to spam folder'",
    "e.g. for a scheduling tool: 'back-and-forth emails trying to find meeting times'",
    "make these feel like Reddit post titles or comment complaints, not marketing copy"
  ],
  "problemKeywords": [
    "words that signal someone has THIS specific problem, 8-12 items",
    "e.g. for email: 'deliverability', 'smtp', 'bounce rate', 'spam filter', 'sendgrid alternative'",
    "these are the words you'd ctrl+F for in a subreddit"
  ],
  "falsePositiveSignals": [
    "phrases that indicate someone is in the right AUDIENCE but NOT experiencing the problem, 4-6 items",
    "e.g. for email API: 'newsletter', 'cold outreach', 'personal email', 'marketing emails'",
    "e.g. for dev tools: 'learning to code', 'beginner', 'tutorial', 'how do I start'"
  ],
  "competitors": [
    "names of direct competitor products/services they might mention, 3-6 items"
  ],
  "subreddits": [
    "subreddits where people experiencing THIS SPECIFIC PROBLEM would post — not just where the audience hangs out, 6-8 items",
    "for technical products: include technical subreddits where professionals discuss real problems",
    "for B2B tools: include professional subreddits for that industry",
    "NEVER include learning/beginner subreddits like learnprogramming, learnpython, webdev_beginners — these people don't have the problem yet",
    "PREFER: communities where experienced practitioners vent about problems, compare tools, or ask for recommendations",
    "no r/ prefix"
  ]
}

CRITICAL RULES:
- specificProblems must describe the actual painful situation, not the product's solution
- problemKeywords must be words that ONLY appear if someone has the problem (not just the audience)
- If this is a developer tool, subreddits should include technical communities, not just startup communities
- If this is a B2B tool, subreddits should include professional communities for that industry

URL: ${url}
Content: ${content.slice(0, 6000)}

If content is empty, infer everything from the URL/domain. Be specific — a wrong specific answer is better than a generic correct one.`,
          },
        ],
        max_tokens: 1200,
        temperature: 0.2,
      }),
    })

    const data = await groqRes.json()
    const raw = data.choices?.[0]?.message?.content || ''
    const clean = raw.replace(/```json|```/g, '').trim()
    const analysis = JSON.parse(clean)
    return res.status(200).json({ analysis })
  } catch {
    // No generic fallback — return null so the UI can handle it properly
    return res.status(500).json({ error: 'Analysis failed. Please try again.' })
  }
}
