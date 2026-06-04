import { NextRequest, NextResponse } from 'next/server'
import Groq from 'groq-sdk'

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

// Mark IP as used after successful scan
const ipStore = new Map<string, { count: number; resetAt: number }>()

function getClientIP(req: NextRequest): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    '127.0.0.1'
  )
}

interface RedditPost {
  id: string
  title: string
  body: string
  url: string
  subreddit: string
  createdAt: number
  ups: number
  numComments: number
}

interface ScoredPost extends RedditPost {
  score: number
  signalType: 'active' | 'passive'
  reason: string
  draftReply: string
  expiresIn: number
}

// Fetch Reddit posts via JSON API
async function fetchSubredditPosts(subreddit: string): Promise<RedditPost[]> {
  try {
    const res = await fetch(
      `https://www.reddit.com/r/${subreddit}/new.json?limit=25`,
      {
        headers: { 'User-Agent': 'Kairo/1.0 (lead discovery tool)' },
        next: { revalidate: 0 },
      }
    )
    if (!res.ok) return []
    const data = await res.json()
    const posts = data?.data?.children || []
    return posts.map((p: {data: {id: string; title: string; selftext: string; url: string; subreddit: string; created_utc: number; ups: number; num_comments: number}}) => ({
      id: p.data.id,
      title: p.data.title,
      body: p.data.selftext?.slice(0, 500) || '',
      url: `https://reddit.com${p.data.permalink || ''}`,
      subreddit: p.data.subreddit,
      createdAt: p.data.created_utc * 1000,
      ups: p.data.ups,
      numComments: p.data.num_comments,
    }))
  } catch {
    return []
  }
}

// Step 1: Analyze product with Groq
async function analyzeProduct(websiteContent: string, url: string) {
  const completion = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      {
        role: 'system',
        content: `You are a product analyst. Analyze a website and return a JSON object only. No markdown, no explanation, just raw JSON.`,
      },
      {
        role: 'user',
        content: `Analyze this website content and return ONLY this JSON structure:
{
  "name": "product name",
  "description": "one sentence what it does",
  "targetCustomer": "who uses this",
  "painPoints": ["pain1", "pain2", "pain3", "pain4", "pain5"],
  "keywords": ["kw1", "kw2", "kw3", "kw4", "kw5"],
  "subreddits": ["subreddit1", "subreddit2", "subreddit3", "subreddit4", "subreddit5", "subreddit6", "subreddit7"]
}

Choose subreddits where the target customer actively discusses their problems. Use real subreddit names without r/ prefix.

Website URL: ${url}
Website content: ${websiteContent.slice(0, 3000)}`,
      },
    ],
    max_tokens: 800,
    temperature: 0.3,
  })

  const text = completion.choices[0]?.message?.content || ''
  const clean = text.replace(/```json|```/g, '').trim()
  return JSON.parse(clean)
}

// Step 2: Score posts with Groq
async function scorePosts(posts: RedditPost[], analysis: {name: string; description: string; targetCustomer: string; painPoints: string[]; keywords: string[]}) {
  if (posts.length === 0) return []

  const postsForScoring = posts.slice(0, 30).map((p, i) => ({
    index: i,
    title: p.title,
    body: p.body.slice(0, 300),
    subreddit: p.subreddit,
  }))

  const completion = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      {
        role: 'system',
        content: 'You are a lead scoring engine. Return only valid JSON arrays. No markdown.',
      },
      {
        role: 'user',
        content: `Score these Reddit posts for buying intent relevance to this product.

Product: ${analysis.name}
Description: ${analysis.description}  
Target customer: ${analysis.targetCustomer}
Pain points: ${analysis.painPoints.join(', ')}
Keywords: ${analysis.keywords.join(', ')}

For each post, determine:
- score: 1-10 buying intent (8+ = high intent, 6-7 = moderate, below 6 = low)
- signalType: "active" (actively shopping/asking for recommendations) or "passive" (expressing pain without seeking solution)
- reason: one sentence why this matches the product

Return ONLY a JSON array of objects with these fields for posts scoring 6 or above:
[{"index": 0, "score": 8.5, "signalType": "active", "reason": "..."}]

If no posts score 6+, return an empty array: []

Posts to score:
${JSON.stringify(postsForScoring)}`,
      },
    ],
    max_tokens: 1500,
    temperature: 0.2,
  })

  const text = completion.choices[0]?.message?.content || '[]'
  const clean = text.replace(/```json|```/g, '').trim()
  try {
    return JSON.parse(clean)
  } catch {
    return []
  }
}

// Step 3: Generate draft replies
async function generateDraftReply(
  post: RedditPost,
  analysis: {name: string; description: string; targetCustomer: string},
  signalType: 'active' | 'passive'
): Promise<string> {
  const instruction =
    signalType === 'active'
      ? 'Write a direct, helpful reply. Mention the product naturally. Be concise and specific.'
      : 'Lead with genuine empathy about their pain. Add value first. Only mention the product briefly at the end if relevant. Never pitch aggressively.'

  const completion = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      {
        role: 'system',
        content: `You write Reddit replies for founders. Replies must sound human, genuine, and helpful. Never salesy. Max 120 words. No hashtags. No emojis. ${instruction}`,
      },
      {
        role: 'user',
        content: `Write a Reddit reply for this post.

Post title: ${post.title}
Post body: ${post.body.slice(0, 400)}
Subreddit: r/${post.subreddit}

Product being promoted: ${analysis.name} — ${analysis.description}
Signal type: ${signalType}

Write the reply only. No intro. No explanation.`,
      },
    ],
    max_tokens: 300,
    temperature: 0.7,
  })

  return completion.choices[0]?.message?.content?.trim() || ''
}

export async function POST(req: NextRequest) {
  try {
    const { url } = await req.json()
    if (!url) {
      return NextResponse.json({ error: 'URL is required' }, { status: 400 })
    }

    // Mark IP as used
    const ip = getClientIP(req)
    const now = Date.now()
    const windowMs = 24 * 60 * 60 * 1000
    const record = ipStore.get(ip)
    if (!record || now > record.resetAt) {
      ipStore.set(ip, { count: 1, resetAt: now + windowMs })
    } else {
      ipStore.set(ip, { ...record, count: record.count + 1 })
    }

    // Step 1: Fetch website content via Jina Reader
    let websiteContent = ''
    try {
      const jinaRes = await fetch(`https://r.jina.ai/${url}`, {
        headers: { Accept: 'text/plain' },
        signal: AbortSignal.timeout(12000),
      })
      if (jinaRes.ok) {
        websiteContent = await jinaRes.text()
      }
    } catch {
      // Continue with empty content — Groq will use the URL
    }

    // Step 2: Analyze product
    const analysis = await analyzeProduct(websiteContent, url)

    // Step 3: Fetch Reddit posts from all subreddits in parallel
    const subreddits: string[] = analysis.subreddits?.slice(0, 6) || ['SaaS', 'indiehackers', 'entrepreneur']
    const postArrays = await Promise.all(subreddits.map(fetchSubredditPosts))
    const allPosts = postArrays.flat()

    if (allPosts.length === 0) {
      return NextResponse.json({
        analysis,
        leads: [],
      })
    }

    // Step 4: Score posts
    const scores = await scorePosts(allPosts, analysis)

    if (scores.length === 0) {
      return NextResponse.json({ analysis, leads: [] })
    }

    // Step 5: Get top 3 posts and generate draft replies
    const topScores = scores
      .sort((a: {score: number}, b: {score: number}) => b.score - a.score)
      .slice(0, 3)

    const leads: ScoredPost[] = await Promise.all(
      topScores.map(async (scored: {index: number; score: number; signalType: 'active' | 'passive'; reason: string}) => {
        const post = allPosts[scored.index]
        if (!post) return null

        const draftReply = await generateDraftReply(post, analysis, scored.signalType)

        // Calculate decay window based on post age
        const ageMinutes = (Date.now() - post.createdAt) / 1000 / 60
        const maxWindow = scored.signalType === 'active' ? 180 : 360
        const expiresIn = Math.max(0, maxWindow - ageMinutes)

        return {
          ...post,
          id: post.id,
          score: scored.score,
          signalType: scored.signalType,
          reason: scored.reason,
          draftReply,
          expiresIn,
        }
      })
    )

    const validLeads = leads.filter(Boolean)

    return NextResponse.json({ analysis, leads: validLeads })
  } catch (error) {
    console.error('Scan error:', error)
    return NextResponse.json(
      { error: 'Failed to complete scan. Please try again.' },
      { status: 500 }
    )
  }
}
