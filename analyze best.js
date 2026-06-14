// Best file ♥️♥️♥️

analyze.js — Product analysis: extracts precise ICP and specific problems for any product

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { url } = req.body
  if (!url) return res.status(400).json({ error: 'URL required' })

  let content = ''

  // Method 1: Jina Reader with JS rendering headers
  try {
    const jinaRes = await fetch(`https://r.jina.ai/${url}`, {
      headers: {
        'Accept': 'text/plain',
        'X-Wait-For-Selector': 'body',
        'X-Timeout': '10',
      },
      signal: AbortSignal.timeout(15000),
    })
    if (jinaRes.ok) content = await jinaRes.text()
    console.log('[analyze] jina content length:', content.length)
  } catch (e) {
    console.log('[analyze] jina error:', e.message)
  }

  // Method 2: Direct HTML fetch + strip tags (fallback for JS-heavy sites)
  if (content.length < 300) {
    console.log('[analyze] jina too thin, trying direct HTML fetch')
    try {
      const cleanUrl = url.startsWith('http') ? url : `https://${url}`
      const htmlRes = await fetch(cleanUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
        },
        signal: AbortSignal.timeout(10000),
      })
      if (htmlRes.ok) {
        const html = await htmlRes.text()
        // Strip HTML tags and extract readable text
        const stripped = html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
          .replace(/\s+/g, ' ')
          .trim()
        if (stripped.length > content.length) {
          content = stripped.slice(0, 6000)
          console.log('[analyze] direct fetch content length:', content.length)
        }
      }
    } catch (e) {
      console.log('[analyze] direct fetch error:', e.message)
    }
  }

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
            content: 'You are a product analyst. Return only raw JSON. No markdown. No code blocks. No text before or after the JSON.',
          },
          {
            role: 'user',
            content: `Analyze this product and return a JSON object with these exact fields.

CRITICAL RULE FOR EVERY FIELD: Be specific to THIS product. Do not use generic startup language. Think about what the actual user of this product is doing when they hit the problem.

---

name
The product name.

description
One sentence: what it does and for whom. Be specific about the mechanism, not just the outcome.
BAD: "A tool that helps businesses grow"
GOOD: "An API that delivers transactional emails reliably without them going to spam"
GOOD: "A no-code tool that connects two software apps so data flows automatically between them"

category
The precise product category. Be specific.
BAD: "productivity tool"
GOOD: "workflow automation platform that connects SaaS apps via triggers and actions"
GOOD: "transactional email delivery API for developers"

targetCustomer
ONE sentence describing exactly who buys this. Include: their role, what they're building or running, and what specific goal they're trying to achieve with this product.
BAD: "small business owners who want to save time"
BAD: "entrepreneurs looking to grow"
GOOD: "developers building web apps who need transactional emails (receipts, password resets, notifications) to reach inboxes reliably without managing mail servers"
GOOD: "non-technical business owners who manually copy data between two software tools and want it to happen automatically"
GOOD: "solo SaaS founders who have launched a product but have no systematic way to find potential customers"

customerBusinessType
The type of business/role the target customer has. Used to reject wrong audience.
Examples: "software developer or technical founder", "non-technical small business owner", "SaaS founder pre-traction", "e-commerce store owner", "freelancer or consultant", "marketing team at a startup"

specificProblems
Array of 6-8 strings. Each string is the EXACT situation a real user is in when they need this product — written the way they would describe it in a Reddit post or support ticket.

HOW TO WRITE THESE:
1. Think about what the person is doing manually or badly RIGHT NOW before they find this product
2. Write it as their frustration, in their words, at the moment they have the problem
3. Be specific about the exact task, tool, or situation — not the general category

BAD examples (too generic, match everything):
- "struggling with productivity"
- "can't find customers"
- "workflow is inefficient"

GOOD examples for a WORKFLOW AUTOMATION tool (Zapier):
- "every time someone fills out my contact form I have to manually copy their info into my CRM"
- "I'm paying a VA just to move data between apps that should talk to each other automatically"
- "my Shopify orders don't automatically update my inventory spreadsheet so I do it by hand"
- "I get a Stripe payment notification but I have to manually send a Slack message to my team"
- "I want leads from my Facebook ads to go straight into my email list without me doing anything"

GOOD examples for a TRANSACTIONAL EMAIL tool (Resend, SendGrid):
- "my password reset emails are going to spam and users think the site is broken"
- "I'm using Gmail SMTP to send transactional emails and it keeps hitting sending limits"
- "my welcome emails after signup go to promotions tab and users never see them"
- "I need to send receipts and notifications from my app but don't know how to set up email infrastructure"

GOOD examples for a SCHEDULING tool (Cal.com, Calendly):
- "I'm going back and forth over email 5 times just to schedule a single meeting"
- "I send my availability manually every time someone wants to book a call with me"
- "clients keep booking outside my available hours because I don't have a proper booking system"

GOOD examples for a REDDIT LEAD GENERATION tool (Kairo):
- "I built a SaaS and launched it but I have no idea where to find my first paying customers"
- "I know my customers are on Reddit asking questions but I can't monitor it manually all day"
- "I respond to Reddit posts too late and the conversation has already moved on"
- "I spend 2 hours a day manually searching Reddit for potential customers and rarely find anything"

Now write specificProblems for THIS specific product using this same level of specificity.

problemKeywords
Array of 8-12 strings. Words or short 2-3 word phrases that appear in a Reddit post ONLY when someone has this specific problem — not just when they're in the general audience.

BAD (too broad, appear in any business post): "productivity", "business", "tool", "software", "help"
GOOD for workflow automation: "manual copy", "automate between", "connect my apps", "zap", "make.com alternative", "n8n", "webhook", "trigger when", "sync my"
GOOD for email tool: "smtp", "deliverability", "spam folder", "sendgrid", "mailgun", "bounce rate", "transactional email", "email going to spam"
GOOD for scheduling: "back and forth email", "booking link", "calendly alternative", "schedule a call", "availability"

falsePositiveSignals
Array of 4-6 strings. Topics that bring in the wrong audience — people who are in the general space but do NOT have this specific problem.
Think: who would be in the same subreddits but not need this product?
Examples for workflow automation: "looking for a project manager", "team communication", "hiring employees", "business strategy advice", "networking"
Examples for email tool: "email marketing", "newsletter", "cold outreach", "sales emails", "bulk email"

competitors
Array of 3-6 direct competitor names that users might mention when looking for alternatives.

subreddits
Array of 6-8 subreddit names WITHOUT r/ prefix.
Rules:
- 100k+ members, active daily posting
- Pick where people experiencing THIS SPECIFIC PROBLEM actually post
- Think: where would someone go to complain about or ask for help with this exact problem?
- For developer problems: webdev, node, programming, aws, devops
- For business automation: entrepreneur, smallbusiness, startups, SaaS
- For founder/distribution problems: SaaS, indiehackers, startups, Entrepreneur, microsaas
- NEVER pick tiny topic-named subreddits or learning subreddits

---

URL: ${url}
Website content: ${content.slice(0, 6000)}

${content.length < 200 ? 'IMPORTANT: Website content is empty because this site uses JavaScript rendering. Use your training knowledge about this product based on the URL. Products like Notion, Linear, Stripe, Zapier, Cal.com, Resend are in your training data. Use that knowledge now to fill all fields accurately and specifically.' : 'Analyze the product from the content above.'}

Return only the JSON object.`,
          },
        ],
        max_tokens: 1600,
        temperature: 0.2,
      }),
    })

    const data = await groqRes.json()
    console.log('[analyze] groq status:', groqRes.status)
    console.log('[analyze] groq error:', data.error?.message || 'none')

    const raw = data.choices?.[0]?.message?.content || ''
    console.log('[analyze] raw length:', raw.length, '| preview:', raw.slice(0, 300))

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
      console.log('[analyze] groq returned empty — using fallback')
      const domain = url.replace(/https?:\/\//, '').split('/')[0].replace('www.', '')
      analysis = buildFallback(domain)
    }

    analysis = sanitize(analysis, url)
    console.log('[analyze] name:', analysis.name)
    console.log('[analyze] targetCustomer:', analysis.targetCustomer?.slice(0, 80))
    console.log('[analyze] specificProblems[0]:', analysis.specificProblems?.[0])
    console.log('[analyze] subreddits:', analysis.subreddits?.join(', '))

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
    targetCustomer: 'Founders and builders with software products',
    customerBusinessType: 'SaaS or software product',
    specificProblems: [
      'struggling to find first paying customers after launching',
      'no systematic way to find people who need their product',
      'spending too much time on manual distribution tasks',
    ],
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
