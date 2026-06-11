// analyze.js — Product analysis: extracts specific problems, not just audience

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { url } = req.body
  if (!url) return res.status(400).json({ error: 'URL required' })

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
            content: 'You are a product analyst. Return only raw JSON. No markdown. No explanation. No code blocks. No extra text before or after the JSON.',
          },
          {
            role: 'user',
            content: `Analyze this product and return a JSON object with exactly these fields:

name: the product name as a string
description: one sentence describing what it does and for whom
category: the product category as a string (e.g. "transactional email API" or "scheduling tool")
specificProblems: array of 5-8 strings. Each string is a specific painful situation this product solves, written the way a frustrated user would describe it on Reddit. NOT marketing copy. Example for an email API: "my transactional emails keep landing in the spam folder"
problemKeywords: array of 8-12 strings. Single words or short phrases that would appear in a Reddit post only if someone has this specific problem. Example for email API: "deliverability", "smtp", "bounce rate", "spam filter", "sendgrid alternative"
falsePositiveSignals: array of 4-6 strings. Topics that indicate someone is in the target audience but does NOT have this specific problem. Example for email API: "newsletter", "cold outreach", "learning to code"
competitors: array of 3-6 strings. Names of competing products this product replaces or is compared to.
subreddits: array of 6-8 strings. Subreddit names WITHOUT the r/ prefix. Rules: only pick subreddits with 100k+ members that have daily posts. Pick where the PROBLEM surfaces, not where the topic lives. People with scheduling pain post in freelance, smallbusiness, consulting, remotework — not in a subreddit called "scheduling". Never pick learning subreddits like learnprogramming. Never pick topic-named subreddits that are tiny.

URL: ${url}
Website content: ${content.slice(0, 6000)}

If website content is empty, infer all fields from the URL and domain name. Return only the JSON object, nothing else.`,
          },
        ],
        max_tokens: 1200,
        temperature: 0.2,
      }),
    })

    const data = await groqRes.json()
    const raw = data.choices?.[0]?.message?.content || ''
    
    console.log('[analyze] raw response:', raw.slice(0, 300))

    // Robustly extract JSON — handle markdown, extra text, truncation
    let analysis = null
    
    // Strip markdown code fences
    let clean = raw.replace(/```json/gi, '').replace(/```/g, '').trim()
    
    // Find the outermost { } 
    const start = clean.indexOf('{')
    const end = clean.lastIndexOf('}')
    if (start === -1 || end === -1) throw new Error('No JSON object in response')
    
    const jsonStr = clean.slice(start, end + 1)
    analysis = JSON.parse(jsonStr)

    // Ensure arrays exist and are actually arrays
    if (!Array.isArray(analysis.subreddits)) analysis.subreddits = ['SaaS', 'indiehackers', 'entrepreneur', 'smallbusiness', 'startups', 'freelance']
    if (!Array.isArray(analysis.specificProblems)) analysis.specificProblems = []
    if (!Array.isArray(analysis.problemKeywords)) analysis.problemKeywords = []
    if (!Array.isArray(analysis.falsePositiveSignals)) analysis.falsePositiveSignals = []
    if (!Array.isArray(analysis.competitors)) analysis.competitors = []
    if (!analysis.name) analysis.name = new URL(raw.includes('http') ? raw : 'https://unknown').hostname
    if (!analysis.description) analysis.description = 'Product analysis unavailable'

    console.log('[analyze] success:', analysis.name, '| subreddits:', analysis.subreddits.join(', '))
    return res.status(200).json({ analysis })
  } catch (err) {
    console.error('Analyze error:', err.message)
    return res.status(500).json({ error: 'Analysis failed. Please try again.' })
  }
}
