// score.js — Groq lead scoring pipeline
// All posts scored directly against the product in parallel batches.
// Hard rejection rules inside Groq. No pre-filter.

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

// ─── Score posts against the product ─────────────────────────────────────
// Returns array of { post, score, signalType, specificProblem, reason }
// Each batch uses LOCAL indexes (0..N-1) and we attach the post object
// directly so there's no cross-batch index confusion.

async function scoreAgainstProduct(posts, analysis) {
  if (!posts.length) return []

  const BATCH_SIZE = 15
  const batches = []
  for (let i = 0; i < posts.length; i += BATCH_SIZE) {
    batches.push(posts.slice(i, i + BATCH_SIZE))
  }

  console.log(`[score] scoring ${posts.length} posts in ${batches.length} batches`)

  const batchResults = await Promise.all(batches.map(async (batch, batchIdx) => {
    const batchInput = batch.map((p, localIdx) => ({
      index: localIdx, // LOCAL index within this batch only
      title: p.title,
      body: (p.body || '').slice(0, 400),
      subreddit: p.subreddit,
    }))

    const raw = await callGroq([
      {
        role: 'system',
        content: 'You are a product-market fit scorer. Return only a valid JSON array. No markdown. No explanation.',
      },
      {
        role: 'user',
        content: `Find Reddit leads for this product:

Product: ${analysis.name}
What it does: ${analysis.description}
Problems it solves: ${analysis.specificProblems?.join(' | ') || ''}
Competitors: ${analysis.competitors?.join(', ') || 'none listed'}
False positives (audience but NOT buyers): ${analysis.falsePositiveSignals?.join(', ') || ''}

SCORING:
- 9-10: Person explicitly experiencing a problem this product solves, actively seeking solution
- 7-8: Clearly experiencing a problem this product solves, even if not actively shopping
- 5-6: Problem indirectly overlaps with what this product solves
- Below 5: REJECT

HARD REJECTIONS (always reject):
1. Success story — already solved the problem, sharing wins or lessons
2. Seller not buyer — person offers a service competing with this product
3. General discussion — no specific personal pain described
4. Beginner — asking how to start something this product improves

Only include posts where you can finish: "This person needs ${analysis.name} because RIGHT NOW they are experiencing: [specific problem]"

signalType: "active" = looking for tools/alternatives, "passive" = has the pain but not shopping

Return ONLY posts scoring 5+. Return [] if nothing qualifies.
Format: [{"index":0,"score":8,"signalType":"active","specificProblem":"their exact problem","reason":"one sentence about their situation"}]

Posts:
${JSON.stringify(batchInput)}`,
      },
    ], 1500, 0.1)

    console.log(`[score] batch ${batchIdx} raw response: ${raw.slice(0, 200)}`)

    try {
      const clean = raw.replace(/```json|```/g, '').trim()
      const match = clean.match(/\[[\s\S]*\]/)
      if (!match) {
        console.log(`[score] batch ${batchIdx}: no JSON array found`)
        return []
      }
      const scored = JSON.parse(match[0])
      console.log(`[score] batch ${batchIdx}: ${scored.length} leads found`)

      // Map LOCAL index back to the actual post object
      return scored
        .filter(s => s.score >= 5 && s.index >= 0 && s.index < batch.length)
        .map(s => ({
          post: batch[s.index], // attach the actual post — no index confusion
          score: s.score,
          signalType: s.signalType,
          specificProblem: s.specificProblem,
          reason: s.reason,
        }))
    } catch (err) {
      console.log(`[score] batch ${batchIdx} parse error: ${err.message}`)
      return []
    }
  }))

  return batchResults.flat()
}

// ─── Score comments ───────────────────────────────────────────────────────
async function scoreComments(post, comments, analysis) {
  if (!comments.length) return null

  const batch = comments.slice(0, 25).map((c, i) => ({
    index: i,
    body: c.body.slice(0, 400),
  }))

  const raw = await callGroq([
    {
      role: 'system',
      content: 'You are a buying signal detector. Return only JSON. No markdown.',
    },
    {
      role: 'user',
      content: `Post: "${post.title}" in r/${post.subreddit}
Product: ${analysis.name} — ${analysis.description}
Problems it solves: ${analysis.specificProblems?.join(' | ') || ''}
Competitors: ${analysis.competitors?.join(', ') || ''}

Find comments with: competitor complaints, requests for alternatives, painful workflows, budget/purchase mentions, frustration with current tools.
Ignore: opinions, advice, off-topic, educational content.

Return qualifying comments (score 7+):
[{"index":0,"score":8,"signalType":"active","specificProblem":"what they need","body":"comment text"}]
Return [] if none qualify.

Comments: ${JSON.stringify(batch)}`,
    },
  ], 1000, 0.1)

  try {
    const clean = raw.replace(/```json|```/g, '').trim()
    const match = clean.match(/\[[\s\S]*\]/)
    if (!match) return null
    const scored = JSON.parse(match[0])
    if (!scored.length) return null
    const best = scored.sort((a, b) => b.score - a.score)[0]
    const original = comments[best.index]
    if (!original) return null
    return { ...best, id: original.id, body: original.body, createdAt: original.createdAt }
  } catch {
    return null
  }
}

// ─── Generate reply ───────────────────────────────────────────────────────
async function generateReply(post, analysis, signalType, specificProblem, targetComment = null) {
  const replyTarget = targetComment
    ? `Comment: "${targetComment.body.slice(0, 300)}"`
    : `Post: "${post.title}" — "${(post.body || '').slice(0, 300)}"`

  const toneGuide = signalType === 'active'
    ? `They are actively looking for a solution. Be direct. Lead with how ${analysis.name} solves their exact problem. Sound like a peer.`
    : `They have the pain but aren't shopping yet. Lead with empathy, acknowledge their frustration, add value, mention ${analysis.name} briefly at the end.`

  const raw = await callGroq([
    {
      role: 'system',
      content: 'Write a Reddit reply. Sound like a real person. Max 120 words. No hashtags, emojis, or bullet points. Never start with "I", "Hey", or "Great post". Reference their specific situation.',
    },
    {
      role: 'user',
      content: `${replyTarget}
Subreddit: r/${post.subreddit}
Their problem: ${specificProblem}
Product: ${analysis.name} — ${analysis.description}
Tone: ${toneGuide}
Write only the reply text.`,
    },
  ], 350, 0.7)

  const reply = raw.trim()
  if (!reply || reply.length < 20) return ''
  if (reply.toLowerCase().includes('lead with genuine value')) return ''
  return reply
}

// ─── Main handler ─────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { posts, analysis, commentsMap = {} } = req.body
  if (!posts || !analysis) return res.status(400).json({ error: 'posts and analysis required' })

  console.log(`[score] received ${posts.length} posts for product: ${analysis.name}`)

  try {
    const scored = await scoreAgainstProduct(posts, analysis)
    console.log(`[score] total qualified: ${scored.length}`)

    if (!scored.length) {
      return res.status(200).json({ leads: [] })
    }

    const top5 = scored.sort((a, b) => b.score - a.score).slice(0, 5)

    const leads = await Promise.all(
      top5.map(async ({ post, score, signalType, specificProblem, reason }, i) => {
        try {
          if (!post) { console.log(`[score] lead ${i}: post is null`); return null }
          console.log(`[score] lead ${i}: processing "${(post.title || '').slice(0, 60)}"`)

          // Skip comments — too slow, adds latency with no guaranteed benefit
          const finalScore = score
          const finalSignalType = signalType || 'passive'
          const finalProblem = specificProblem || ''

          let draftReply = ''
          try {
            draftReply = await generateReply(post, analysis, finalSignalType, finalProblem, null)
          } catch (replyErr) {
            console.log(`[score] lead ${i}: reply failed: ${replyErr.message}`)
          }

          const ageMinutes = (Date.now() - (post.createdAt || Date.now())) / 60000
          const maxWindow = finalSignalType === 'active' ? 180 : 360
          const expiresIn = maxWindow - ageMinutes

          console.log(`[score] lead ${i}: done, score=${finalScore}, reply=${draftReply.length} chars`)

          return {
            ...post,
            score: finalScore,
            signalType: finalSignalType,
            specificProblem: finalProblem,
            reason: reason || '',
            draftReply,
            expiresIn,
            expired: expiresIn <= 0,
            commentLead: null,
          }
        } catch (leadErr) {
          console.log(`[score] lead ${i}: unexpected error: ${leadErr.message}`)
          return null
        }
      })
    )

    const finalLeads = leads.filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 3)
    console.log(`[score] returning ${finalLeads.length} final leads`)

    return res.status(200).json({ leads: finalLeads })
  } catch (err) {
    console.error('[score] fatal error:', err)
    return res.status(500).json({ error: 'Scoring failed' })
  }
}
