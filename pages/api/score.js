// score.js — Problem-matching lead scorer with comment support
// Philosophy: aggressively reject, only surface leads where the problem is explicit

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

// ─── STAGE 1: Filter posts by problem match ────────────────────────────────
// Fast keyword pre-filter before we touch Groq at all
function preFilterPosts(posts, analysis) {
  const { problemKeywords = [], falsePositiveSignals = [], competitors = [] } = analysis

  const problemTerms = problemKeywords.map(k => k.toLowerCase())
  const falseTerms = falsePositiveSignals.map(k => k.toLowerCase())
  const competitorTerms = competitors.map(k => k.toLowerCase())

  return posts.filter(post => {
    const text = `${post.title} ${post.body || ''}`.toLowerCase()

    // Instant reject: contains false positive signals but no problem terms
    const hasFalseSignal = falseTerms.some(t => text.includes(t))
    const hasProblemTerm = problemTerms.some(t => text.includes(t))
    const hasCompetitor = competitorTerms.some(t => text.includes(t))

    if (hasFalseSignal && !hasProblemTerm && !hasCompetitor) return false

    // Must have at least one problem term OR competitor mention OR be very short (titles only)
    // Short titles may lack keywords but the full post might match — allow through for Groq
    if (!hasProblemTerm && !hasCompetitor && post.body && post.body.length > 100) return false

    return true
  })
}

// ─── STAGE 2: Groq problem-matching score ────────────────────────────────
async function scorePosts(posts, analysis) {
  if (!posts.length) return []

  const batch = posts.slice(0, 20).map((p, i) => ({
    index: i,
    title: p.title,
    body: (p.body || '').slice(0, 400),
    subreddit: p.subreddit,
  }))

  const raw = await callGroq([
    {
      role: 'system',
      content: 'You are a strict lead qualification engine. Return only a valid JSON array. No markdown. No explanation. When in doubt, exclude.',
    },
    {
      role: 'user',
      content: `You are qualifying leads for this product:

Product: ${analysis.name}
Category: ${analysis.category || analysis.description}
What it solves: ${analysis.specificProblems?.join(' | ') || analysis.description}
Problem keywords: ${analysis.problemKeywords?.join(', ') || ''}
Competitors: ${analysis.competitors?.join(', ') || 'none listed'}
False positives (audience match but NOT problem match): ${analysis.falsePositiveSignals?.join(', ') || ''}

SCORING RULES — be strict:
- 9-10: Person is EXPLICITLY experiencing the exact problem this product solves. They are asking for a product recommendation, comparing tools, or describing active pain with this specific problem.
- 7-8: Person is clearly experiencing a related problem and would benefit from this product, even if they haven't framed it as a tool search yet.
- 5-6: Problem is present but weak signal — mentioned in passing, or could be solved many ways.
- Below 5: REJECT. Do not include. This means: audience overlap without problem match, beginner/learning questions, general discussion, industry news, irrelevant personal situation.

REJECTION EXAMPLES (do not include these):
- A developer post NOT mentioning the specific problem this product solves
- Someone asking how to START doing something this product improves
- General rant not tied to a problem this product solves
- Industry news or tutorials
- Personal stories with no buying signal

MANDATORY: For every post you include, you MUST be able to complete this sentence with a specific answer:
"This person needs ${analysis.name} because they are specifically experiencing: [EXACT PROBLEM]"

If you can only say "they're in the target audience" — REJECT IT.

signalType:
- "active": explicitly asking for tool recommendations, comparing products, ready to switch
- "passive": experiencing the pain but not actively shopping yet

Return ONLY posts scoring 5+. If nothing qualifies, return an empty array [].

Return ONLY a JSON array:
[{"index":0,"score":8.5,"signalType":"active","specificProblem":"exact problem they have","reason":"one specific sentence referencing their actual words or situation"}]

Posts to evaluate:
${JSON.stringify(batch)}`,
    },
  ], 2000, 0.1)

  try {
    const clean = raw.replace(/```json|```/g, '').trim()
    const match = clean.match(/\[[\s\S]*\]/)
    if (!match) return []
    return JSON.parse(match[0])
  } catch {
    return []
  }
}

// ─── STAGE 3: Score comments for a qualifying post ────────────────────────
async function scoreComments(post, comments, analysis) {
  if (!comments.length) return null

  const batch = comments.slice(0, 25).map((c, i) => ({
    index: i,
    body: c.body.slice(0, 400),
  }))

  const raw = await callGroq([
    {
      role: 'system',
      content: 'You are a lead signal detector. Find comments that contain buying signals. Return only JSON. No markdown.',
    },
    {
      role: 'user',
      content: `Original post: "${post.title}"
Subreddit: r/${post.subreddit}

Product: ${analysis.name} — ${analysis.description}
Specific problems it solves: ${analysis.specificProblems?.join(' | ') || ''}
Competitors: ${analysis.competitors?.join(', ') || ''}

Scan these comments for strong buying signals. A strong signal is:
- Complaint about an existing tool (especially a competitor)
- Asking for alternatives or recommendations
- Describing a painful workflow
- Mentioning a budget or purchase decision
- Expressing frustration with current solution
- Saying they've tried X and it failed

Weak signals (ignore):
- General discussion or opinions
- Agreeing with OP without adding context
- Educational info or explanations
- Off-topic tangents

For each qualifying comment (score 7+), return:
[{"index":0,"score":8.0,"signalType":"active","specificProblem":"what they need","body":"the exact comment text"}]

If no comments qualify, return [].

Comments:
${JSON.stringify(batch)}`,
    },
  ], 1500, 0.1)

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

// ─── STAGE 4: Generate a specific, grounded reply ────────────────────────
async function generateReply(post, analysis, signalType, specificProblem, targetComment = null) {
  const replyTarget = targetComment
    ? `Comment: "${targetComment.body.slice(0, 300)}"`
    : `Post title: "${post.title}"\nPost body: "${(post.body || '').slice(0, 300)}"`

  const toneGuide = signalType === 'active'
    ? `They are actively looking for a solution. Be direct. Lead with how ${analysis.name} solves their exact problem. Don't over-sell. Sound like a peer who found a solution.`
    : `They are experiencing pain but not shopping yet. Lead with empathy — acknowledge the specific frustration first. Add genuine value. Only mention ${analysis.name} at the end if it fits naturally.`

  const raw = await callGroq([
    {
      role: 'system',
      content: `You write Reddit replies for founders promoting their product. Rules:
- Sound like a real person, not marketing copy
- Max 120 words
- No hashtags, no emojis, no bullet points
- Never start with "I" or "Hey" or "Great post"
- Reference their specific situation — not a generic reply
- If mentioning the product, do it once and naturally`,
    },
    {
      role: 'user',
      content: `Write a Reddit reply.

${replyTarget}
Subreddit: r/${post.subreddit}
Their specific problem: ${specificProblem}
Signal type: ${signalType}

Product to mention: ${analysis.name} — ${analysis.description}

Tone guide: ${toneGuide}

Write ONLY the reply text. Make it specific to their situation.`,
    },
  ], 350, 0.7)

  const reply = raw.trim()

  // Hard reject generic fallbacks — if Groq returns nothing useful, we return empty
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
    // Stage 1: Fast keyword pre-filter
    const preFiltered = preFilterPosts(posts, analysis)

    // Stage 2: Groq problem-matching score
    let scores = []
    try {
      scores = await scorePosts(preFiltered, analysis)
    } catch {
      scores = []
    }

    // No fallback to random posts — if nothing qualifies, return empty
    if (!scores.length) {
      return res.status(200).json({ leads: [] })
    }

    // Take top 5 scored posts, then enrich with comments + replies
    const top5 = scores.sort((a, b) => b.score - a.score).slice(0, 5)

    const leads = await Promise.all(
      top5.map(async (scored) => {
        const post = preFiltered[scored.index]
        if (!post) return null

        const postComments = commentsMap[post.id] || []

        // Stage 3: Score comments to find if any are stronger than the post itself
        let bestComment = null
        if (postComments.length > 0) {
          try {
            bestComment = await scoreComments(post, postComments, analysis)
          } catch {
            bestComment = null
          }
        }

        // Determine the lead target: comment (if stronger) or post
        const useComment = bestComment && bestComment.score > scored.score
        const targetComment = useComment ? bestComment : null
        const leadScore = useComment ? bestComment.score : scored.score
        const leadSignalType = useComment ? bestComment.signalType : scored.signalType
        const specificProblem = useComment ? bestComment.specificProblem : scored.specificProblem

        // Stage 4: Generate reply
        let draftReply = ''
        try {
          draftReply = await generateReply(post, analysis, leadSignalType, specificProblem, targetComment)
        } catch {
          draftReply = ''
        }

        // If reply generation completely failed, still surface the lead — just no draft
        const ageMinutes = (Date.now() - post.createdAt) / 60000
        const maxWindow = leadSignalType === 'active' ? 180 : 360
        const expiresIn = maxWindow - ageMinutes
        if (expiresIn <= 0) return null // Post is dead — don't surface it

        return {
          ...post,
          score: leadScore,
          signalType: leadSignalType,
          specificProblem,
          reason: scored.reason,
          draftReply,
          expiresIn,
          // Comment context — shown in UI if lead comes from a comment
          commentLead: useComment ? {
            body: bestComment.body,
            id: bestComment.id,
          } : null,
        }
      })
    )

    // Filter nulls (expired posts), sort by score, return top 3
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
