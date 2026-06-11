// score.js — Groq scoring pipeline
//
// PASS 1 (product match): All posts scored directly against the product.
//   Full product context + hard rejection rules. Batches of 15 in parallel.
//   Returns scores 5-10 with specific problem + reason.
//
// PASS 2 (comments): For each qualifying post, scores comments for stronger signals.
// PASS 3 (reply): Generates a grounded, specific reply for each final lead.

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

// ─── PASS 2: Product match scoring ───────────────────────────────────────
// Only runs on posts that passed Pass 1.
// Full product context + hard rejection rules.

async function scoreAgainstProduct(posts, analysis) {
  if (!posts.length) return []

  // Process in batches of 15 — more context per post needed here
  const BATCH_SIZE = 15
  const batches = []
  for (let i = 0; i < posts.length; i += BATCH_SIZE) {
    batches.push(posts.slice(i, i + BATCH_SIZE).map((p, j) => ({
      index: i + j,
      title: p.title,
      body: (p.body || '').slice(0, 400),
      subreddit: p.subreddit,
    })))
  }

  const batchResults = await Promise.all(batches.map(async batch => {
    const raw = await callGroq([
      {
        role: 'system',
        content: 'You are a product-market fit scorer. Return only a valid JSON array. No markdown. No explanation.',
      },
      {
        role: 'user',
        content: `You are finding leads for this specific product:

Product: ${analysis.name}
What it does: ${analysis.description}
Category: ${analysis.category || ''}
Specific problems it solves: ${analysis.specificProblems?.join(' | ') || ''}
Competitors it replaces: ${analysis.competitors?.join(', ') || 'none listed'}
FALSE POSITIVES — people in the audience who do NOT need this product: ${analysis.falsePositiveSignals?.join(', ') || ''}

SCORING — how well does this post match this specific product?
- 9-10: Person is explicitly experiencing a problem this product solves AND is actively looking for a solution or alternative
- 7-8: Person is clearly experiencing a problem this product solves, even if not actively shopping
- 5-6: Problem overlaps with what this product solves but the match is indirect
- Below 5: REJECT — audience overlap without problem match

HARD REJECTION RULES (reject regardless of score):
1. SUCCESS STORIES: Person already solved the problem — sharing wins, lessons, "here's how I did it". REJECT.
2. SELLERS NOT BUYERS: Person offers a service that competes with this product (e.g. for a lead gen tool, reject lead gen freelancers). REJECT.
3. GENERAL AUDIENCE: Post is in the right community but describes no specific pain that this product solves. REJECT.
4. BEGINNERS: Asking how to start something this product improves. REJECT.

MANDATORY CHECK: Before including a post, complete this sentence:
"This person needs ${analysis.name} because they are RIGHT NOW experiencing: [specific problem]"
If you cannot fill in a specific problem — REJECT.

signalType:
- "active": asking for tools, comparing products, ready to switch
- "passive": experiencing pain but not actively shopping

Return ONLY posts scoring 5+:
[{"index":0,"score":8.5,"signalType":"active","specificProblem":"exact current problem","reason":"one sentence referencing their actual situation"}]

If nothing qualifies, return [].

Posts:
${JSON.stringify(batch)}`,
      },
    ], 1500, 0.1)

    try {
      const clean = raw.replace(/```json|```/g, '').trim()
      const match = clean.match(/\[[\s\S]*\]/)
      if (!match) return []
      return JSON.parse(match[0])
    } catch {
      return []
    }
  }))

  return batchResults.flat()
}

// ─── PASS 3: Comment scoring ──────────────────────────────────────────────
async function scoreComments(post, comments, analysis) {
  if (!comments.length) return null

  const batch = comments.slice(0, 25).map((c, i) => ({
    index: i,
    body: c.body.slice(0, 400),
  }))

  const raw = await callGroq([
    {
      role: 'system',
      content: 'You are a buying signal detector in Reddit comments. Return only JSON. No markdown.',
    },
    {
      role: 'user',
      content: `Post: "${post.title}" in r/${post.subreddit}

Product: ${analysis.name} — ${analysis.description}
Problems it solves: ${analysis.specificProblems?.join(' | ') || ''}
Competitors: ${analysis.competitors?.join(', ') || ''}

Find comments with strong buying signals:
- Complaint about an existing tool (especially a competitor)
- Asking for alternatives or recommendations
- Describing a painful workflow they can't fix
- Mentioning budget or purchase decisions
- Expressing frustration with their current solution

Ignore: general opinions, advice-giving, off-topic, educational responses.

Return qualifying comments (score 7+):
[{"index":0,"score":8.0,"signalType":"active","specificProblem":"what they need","body":"exact comment text"}]

If none qualify, return [].

Comments:
${JSON.stringify(batch)}`,
    },
  ], 1000, 0.1)

  try {
    const clean = raw.replace(/```json|```/g, '').trim()
    const match = clean.match(/\[[\s\S]*\]/)
    if (!match) return null
    const scored = JSON.parse(match[0])
    if (!scored.length) return null

    const best = scored.sort((a, b) => b.score - a.score)[0]
    const originalComment = comments[best.index]
    if (!originalComment) return null

    return {
      ...best,
      id: originalComment.id,
      body: originalComment.body,
      createdAt: originalComment.createdAt,
    }
  } catch {
    return null
  }
}

// ─── PASS 4: Reply generation ─────────────────────────────────────────────
async function generateReply(post, analysis, signalType, specificProblem, targetComment = null) {
  const replyTarget = targetComment
    ? `Comment to reply to: "${targetComment.body.slice(0, 300)}"`
    : `Post title: "${post.title}"\nPost body: "${(post.body || '').slice(0, 300)}"`

  const toneGuide = signalType === 'active'
    ? `They are actively looking for a solution. Be direct and helpful. Lead with how ${analysis.name} solves their exact problem. Sound like a peer who found something that worked.`
    : `They are experiencing pain but not shopping yet. Lead with empathy — acknowledge their specific frustration first. Add genuine value. Mention ${analysis.name} briefly and naturally at the end only if it fits.`

  const raw = await callGroq([
    {
      role: 'system',
      content: `You write Reddit replies for founders promoting their product. Rules:
- Sound like a real person, not marketing copy
- Max 120 words
- No hashtags, no emojis, no bullet points
- Never start with "I" or "Hey" or "Great post"
- Reference their specific words or situation directly
- Mention the product once, naturally — never as a pitch`,
    },
    {
      role: 'user',
      content: `Write a Reddit reply for this lead.

${replyTarget}
Subreddit: r/${post.subreddit}
Their specific problem: ${specificProblem}
Signal type: ${signalType}
Product: ${analysis.name} — ${analysis.description}

Tone: ${toneGuide}

Write ONLY the reply text. Make it feel written for this specific person.`,
    },
  ], 350, 0.7)

  const reply = raw.trim()
  if (!reply || reply.length < 20) return ''
  if (reply.toLowerCase().includes('lead with genuine value')) return ''
  if (reply.toLowerCase().includes('lead with empathy and')) return ''
  return reply
}

// ─── MAIN HANDLER ────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { posts, analysis, commentsMap = {} } = req.body
  if (!posts || !analysis) return res.status(400).json({ error: 'posts and analysis required' })

  try {
    // ── Pass 1 removed: all posts go directly to product-match scoring
    // Pass 2 handles all rejection via hard rules — no pre-filter needed
    const painfulPosts = posts

    // ── Score all posts against the specific product
    let scores = []
    try {
      scores = await scoreAgainstProduct(painfulPosts, analysis)
    } catch {
      scores = []
    }

    if (!scores.length) {
      return res.status(200).json({ leads: [] })
    }

    // Take top 5, enrich with comments + replies
    const top5 = scores.sort((a, b) => b.score - a.score).slice(0, 5)

    const leads = await Promise.all(
      top5.map(async scored => {
        const post = painfulPosts[scored.index]
        if (!post) return null

        // ── Pass 3: Check comments for stronger signals
        const postComments = commentsMap[post.id] || []
        let bestComment = null
        if (postComments.length > 0) {
          try {
            bestComment = await scoreComments(post, postComments, analysis)
          } catch {
            bestComment = null
          }
        }

        const useComment = bestComment && bestComment.score > scored.score
        const targetComment = useComment ? bestComment : null
        const leadScore = useComment ? bestComment.score : scored.score
        const leadSignalType = useComment ? bestComment.signalType : scored.signalType
        const specificProblem = useComment ? bestComment.specificProblem : scored.specificProblem

        // ── Pass 4: Generate reply
        let draftReply = ''
        try {
          draftReply = await generateReply(post, analysis, leadSignalType, specificProblem, targetComment)
        } catch {
          draftReply = ''
        }

        const ageMinutes = (Date.now() - post.createdAt) / 60000
        const maxWindow = leadSignalType === 'active' ? 180 : 360
        const expiresIn = maxWindow - ageMinutes
        // Expiry is shown as urgency context only — never hide a qualified lead

        return {
          ...post,
          score: leadScore,
          signalType: leadSignalType,
          specificProblem,
          reason: scored.reason,
          draftReply,
          expiresIn,
          expired: expiresIn <= 0,
          commentLead: useComment ? { body: bestComment.body, id: bestComment.id } : null,
        }
      })
    )

    const finalLeads = leads
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)

    return res.status(200).json({ leads: finalLeads })
  } catch (err) {
    console.error('Score error:', err)
    return res.status(500).json({ error: 'Scoring failed' })
  }
}
