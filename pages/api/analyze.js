// analyze.js — Product analysis with precise ICP extraction

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
            content: 'You are a product analyst. Return only raw JSON. No markdown. No code blocks. No text before or after the JSON object.',
          },
          {
            role: 'user',
            content: `Analyze this product and return a JSON object with EXACTLY these fields:

name
  The product name as a string.

description
  One sentence: what it does and for whom. Be specific.

category
  The product category. Examples: "Reddit lead generation tool for SaaS founders", "transactional email API for developers", "scheduling software for professionals"

targetCustomer
  ONE specific sentence describing the exact type of person who buys this. Include their business type, stage, and what they're trying to accomplish. 
  Examples:
  - "Solo founders and indie hackers who have built a software product and are struggling to find their first customers"
  - "Developers building web apps who need to send transactional emails reliably"
  - "Freelancers and consultants who waste time scheduling meetings via email back-and-forth"
  This field is CRITICAL — be as specific as possible. Do NOT say "small business owners" or "entrepreneurs" generically.

customerBusinessType
  What TYPE of business does the target customer run? Be specific.
  Examples: "SaaS or software product", "developer building web apps", "freelancer or consultant", "e-commerce store", "physical product business", "agency"
  This is used to REJECT leads from the wrong business type.

specificProblems
  Array of 5-8 strings. Each is a specific painful situation this product solves, written like a frustrated Reddit user would describe it. NOT marketing copy.
  Example for a Reddit lead tool: "I built a SaaS but have no idea where to find my first customers", "I spend hours manually searching Reddit for people who might need my product"

problemKeywords
  Array of 8-12 strings. Words or short phrases that appear in Reddit posts ONLY when someone has this specific problem.
  Example for a Reddit lead tool: "find customers", "get users", "distribution", "first customers", "no traction", "struggling to sell"

falsePositiveSignals
  Array of 4-6 strings. Topics that attract the wrong audience — people who are NOT buyers.
  Example for a Reddit lead tool: "physical product", "dropshipping", "brick and mortar", "agency", "freelancing for clients", "networking tips", "building connections"

competitors
  Array of 3-6 competitor product names.

subreddits
  Array of 6-8 subreddit names WITHOUT r/ prefix.
  Rules:
  - 100k+ member subreddits only — active daily posting
  - Pick where the PROBLEM surfaces, not where the topic lives
  - For SaaS/software tools: SaaS, indiehackers, startups, Entrepreneur, microsaas
  - For developer tools: webdev, node, programming, aws, devops  
  - For business tools: smallbusiness, Entrepreneur, freelance, consulting
  - NEVER pick: tiny topic-named subreddits, learning subreddits (learnprogramming etc)

URL: ${url}
Website content: ${content.slice(0, 6000)}

Return only the JSON object. If content is empty, infer everything from the URL/domain.`,
          },
        ],
        max_tokens: 1400,
        temperature: 0.2,
      }),
    })

    const data = await groqRes.json()
    console.log('[analyze] groq status:', groqRes.status)
    console.log('[analyze] groq error:', data.error?.message || 'none')

    const raw = data.choices?.[0]?.message?.content || ''
    console.log('[analyze] raw length:', raw.length, '| preview:', raw.slice(0, 200))

    let analysis = null

    if (raw.length > 10) {
      try {
        const clean = raw.replace(/```json/gi, '').replace(/```/g, '').trim()
        const start = clean.indexOf('{')
        const end = clean.lastIndexOf('}')
        if (start !== -1 && end !== -1) {
          analysis = JSON.parse(clean.slice(start, end + 1))
        }
      } catch (parseErr) {
        console.log('[analyze] parse error:', parseErr.message)
      }
    }

    if (!analysis) {
      console.log('[analyze] falling back to domain-based analysis')
      const domain = url.replace(/https?:\/\//, '').split('/')[0].replace('www.', '')
      analysis = buildFallback(domain)
    }

    // Ensure all required fields exist
    analysis = sanitize(analysis, url)

    console.log('[analyze] returning:', analysis.name, '| customer:', analysis.targetCustomer?.slice(0, 60))
    return res.status(200).json({ analysis })

  } catch (err) {
    console.error('[analyze] fatal:', err.message)
    const domain = url.replace(/https?:\/\//, '').split('/')[0].replace('www.', '')
    return res.status(200).json({ analysis: buildFallback(domain) })
  }
}

function buildFallback(domain) {
  return {
    name: domain,
    description: 'A product at ' + domain,
    category: 'software tool',
    targetCustomer: 'Founders and builders with software products looking for customers',
    customerBusinessType: 'SaaS or software product',
    specificProblems: ['struggling to find customers', 'no traction after launching', 'distribution is hard'],
    problemKeywords: ['find customers', 'get users', 'no traction', 'distribution', 'first customers'],
    falsePositiveSignals: ['physical product', 'dropshipping', 'brick and mortar', 'networking tips'],
    competitors: [],
    subreddits: ['SaaS', 'indiehackers', 'startups', 'Entrepreneur', 'smallbusiness', 'microsaas'],
  }
}

function sanitize(analysis, url) {
  const domain = url.replace(/https?:\/\//, '').split('/')[0].replace('www.', '')
  if (!analysis.name) analysis.name = domain
  if (!analysis.description) analysis.description = 'A product at ' + domain
  if (!analysis.targetCustomer) analysis.targetCustomer = 'Founders with software products'
  if (!analysis.customerBusinessType) analysis.customerBusinessType = 'SaaS or software product'
  if (!Array.isArray(analysis.subreddits) || !analysis.subreddits.length) {
    analysis.subreddits = ['SaaS', 'indiehackers', 'startups', 'Entrepreneur', 'smallbusiness', 'microsaas']
  }
  if (!Array.isArray(analysis.specificProblems)) analysis.specificProblems = []
  if (!Array.isArray(analysis.problemKeywords)) analysis.problemKeywords = []
  if (!Array.isArray(analysis.falsePositiveSignals)) analysis.falsePositiveSignals = []
  if (!Array.isArray(analysis.competitors)) analysis.competitors = []
  return analysis
}
