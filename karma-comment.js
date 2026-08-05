// karma-comment.js — Karma-building comment drafting, fully separate from
// lead scoring and lead replies. Two jobs feed into this one endpoint:
//   - Job 1: threads in a user's own top lead-generating subreddit
//   - Job 2: threads in a small fixed list of high-traffic generic subs
// Neither ever mentions the product. The entire point is account history
// and trust, nothing else — see the no-pacing-guard note near the bottom.
//
// Deliberately self-contained (own Cerebras/Groq/Nemotron calls, own
// humanization pass) rather than importing from reply.js — same pattern
// score.js and score-comments.js already follow. reply.js's humanization
// functions are proven, so they're copied here largely as-is; the pieces
// that ARE new are the content-shape/velocity thread-picking and a
// drafting prompt with no minimum length, since a 3-word reply can be the
// most genuine one.

export const config = { maxDuration: 60 }

// ─── Model calls — same chain as reply.js ────────────────────────────────
async function groqReply(messages, maxTokens) {
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({ model: 'openai/gpt-oss-120b', messages, max_tokens: maxTokens, temperature: 0.8, reasoning_effort: 'low' }),
    })
    const data = await res.json()
    if (data.error) { console.log('[karma:groq] error:', data.error.message); return '' }
    const raw = data.choices?.[0]?.message?.content || ''
    if (data.choices?.[0]?.finish_reason === 'length') return ''
    return raw
  } catch (e) {
    console.log('[karma:groq] fetch error:', e.message)
    return ''
  }
}

async function cerebrasReply(messages, maxTokens, _isRetry = false) {
  try {
    const res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.CEREBRAS_API_KEY}` },
      body: JSON.stringify({ model: 'gpt-oss-120b', messages, max_tokens: maxTokens, temperature: 0.8, reasoning_effort: 'low' }),
    })
    const data = await res.json()
    if (data.error) { console.log('[karma:cerebras] error:', data.error.message); return '' }
    const raw = data.choices?.[0]?.message?.content || ''
    if (!raw && !_isRetry) {
      await new Promise(r => setTimeout(r, 2000))
      return cerebrasReply(messages, maxTokens, true)
    }
    if (data.choices?.[0]?.finish_reason === 'length') return ''
    return raw
  } catch (e) {
    console.log('[karma:cerebras] fetch error:', e.message)
    return ''
  }
}

async function nemotronReply(messages, maxTokens) {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
      body: JSON.stringify({
        model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
        messages, max_tokens: maxTokens, temperature: 0.8,
        reasoning: { exclude: true },
      }),
    })
    const data = await res.json()
    if (data.error) { console.log('[karma:nemotron] error:', data.error.message); return '' }
    let raw = data.choices?.[0]?.message?.content || ''
    if (data.choices?.[0]?.finish_reason === 'length') return ''
    raw = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
    return raw
  } catch (e) {
    console.log('[karma:nemotron] fetch error:', e.message)
    return ''
  }
}

// ─── Humanization pass — copied from reply.js, proven, unchanged ────────
function humanizeText(text) {
  let result = text
  const firstLetterMatch = text.match(/[a-zA-Z]/)
  const isLowercaseStyle = firstLetterMatch ? firstLetterMatch[0] === firstLetterMatch[0].toLowerCase() : false

  result = result.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
  result = result.replace(/\u2026/g, '...')
  result = result.replace(/\u00A0/g, ' ')
  result = result.replace(/^[•●▪◦]\s*/gm, '')
  result = result.replace(/(\S)[‑−](\S)/g, '$1-$2')

  const dashPattern = /\s*(?:—|–|‒|―|⸺|⸻|－|--)\s*(\S)/g
  result = result.replace(dashPattern, (match, nextChar, offset, full) => {
    const textBeforeMatch = full.slice(0, offset)
    const lastSentenceBoundary = Math.max(
      textBeforeMatch.lastIndexOf('.'), textBeforeMatch.lastIndexOf('!'), textBeforeMatch.lastIndexOf('?')
    )
    const before = textBeforeMatch.slice(lastSentenceBoundary + 1).trim()
    const beforeWords = before.split(/\s+/).filter(Boolean).length
    const afterPreview = full.slice(offset + match.length, offset + match.length + 100)
    const afterWordsEstimate = afterPreview.trim().split(/\s+/).filter(Boolean).length
    if (beforeWords >= 5 && afterWordsEstimate >= 4) {
      return '. ' + (isLowercaseStyle ? nextChar.toLowerCase() : nextChar.toUpperCase())
    }
    return ', ' + nextChar
  })

  result = result.replace(/\s*;\s*(\S)/g, (match, nextChar) =>
    '. ' + (isLowercaseStyle ? nextChar.toLowerCase() : nextChar.toUpperCase())
  )
  result = result.replace(/\s*→\s*/g, ' > ')
  result = result.replace(/\s+,/g, ',').replace(/\.\s*\./g, '.').replace(/\s{2,}/g, ' ').trim()
  return result
}

// No productName param here — karma comments never mention a product, so
// the structural pitch-pivot check in reply.js's version doesn't apply.
// Everything else (dashes, semicolons, arrows, filler) still does.
function tooCleanScore(text) {
  let score = 0
  if (/;/.test(text)) score++
  if (/→/.test(text)) score++
  if (/\([^)]+,\s*[^)]+\)/.test(text)) score++
  if (/[—–‒―⸺⸻－]/.test(text)) score++
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean)
  const allProperlyPunctuated = sentences.every(s => /[.!?]$/.test(s.trim()))
  if (allProperlyPunctuated && sentences.length > 1) score++
  const hasContraction = /\b(won't|don't|it's|can't|didn't|isn't|i'm|that's|there's|wasn't)\b/i.test(text)
  if (!hasContraction) score++
  const hasCasualFiller = /\b(lol|tbh|ngl|yeah|honestly|kinda|gonna|idk|anyway)\b/i.test(text)
  if (!hasCasualFiller) score++
  return score
}

async function casualizeReply(originalReply) {
  const messages = [{
    role: 'user',
    content: `Rewrite this Reddit comment to sound like a real person typed it in 5 seconds on their phone, not composed carefully.

Original:
"${originalReply}"

Rules:
- Keep the meaning identical
- Shorter is better, not worse — if it can lose a word and still land, cut it
- No semicolons, no dashes of any kind, no arrow notation
- Don't explain the joke or add a justification — a real reaction doesn't defend itself

Write only the rewritten comment. Nothing else.`,
  }]
  let casualized = (await cerebrasReply(messages, 200)).trim()
  if (!casualized) casualized = (await groqReply(messages, 200)).replace(/<think>[\s\S]*?<\/think>/g, '').trim()
  return casualized || originalReply
}

// ─── Thread picking ───────────────────────────────────────────────────────
// Two independent signals, either can flag a candidate. No LLM call for
// velocity (pure math); one batched LLM call for content-shape, only run
// against the freshest posts where there's no vote data to measure yet.

const FRESH_WINDOW_MINUTES = 15
const VELOCITY_MIN_UPVOTES_PER_MINUTE = 1.5
const VELOCITY_MAX_COMMENTS = 15

// KNOWN GAP: this needs candidate.upvotes and candidate.numComments, but
// posts fetched via fetchSubreddit() in index.ts come from Reddit's RSS/
// Atom feed, which does NOT include vote counts or comment counts —
// only title/body/url/createdAt. Until the fetch pipeline carries that
// data (would need the blocked JSON endpoints, or a different source),
// candidates will come through with upvotes/numComments undefined, this
// filter will never pass, and content-shape is doing 100% of the picking
// in practice. Not broken — just inert until real vote data exists. Fix
// belongs in index.ts's candidate-building step, not here.
function scoreVelocity(candidates) {
  return candidates
    .filter(c => c.ageMinutes > FRESH_WINDOW_MINUTES && c.ageMinutes <= 60)
    .map(c => ({ ...c, velocity: (c.upvotes || 0) / Math.max(c.ageMinutes, 1) }))
    .filter(c => c.velocity >= VELOCITY_MIN_UPVOTES_PER_MINUTE && (c.numComments || 0) < VELOCITY_MAX_COMMENTS)
    .sort((a, b) => b.velocity - a.velocity)
}

async function pickByContentShape(candidates) {
  const fresh = candidates.filter(c => c.ageMinutes <= FRESH_WINDOW_MINUTES)
  if (!fresh.length) return null

  const input = fresh.map((c, i) => ({ i, title: c.title, sub: c.subreddit }))
  const messages = [{
    role: 'user',
    content: `Which of these Reddit post titles (if any) has the shape of a thread that historically gets very high engagement — hundreds or thousands of replies?

The pattern to look for: invites a personal story or opinion (not a factual answer), universally relatable with zero context needed, emotionally light (nostalgia, minor confessions, relatable annoyances — not genuinely divisive or rule-breaking), and short/punchy phrasing rather than long or hedge-y.

Titles: ${JSON.stringify(input)}

Reply with ONLY a JSON object: {"i": <index>} for the best match, or {"i": null} if none of them really have that shape. No explanation.`,
  }]

  let raw = (await cerebrasReply(messages, 100)).trim()
  if (!raw) raw = (await groqReply(messages, 100)).trim()
  if (!raw) return null

  try {
    const clean = raw.replace(/```json|```/g, '').trim()
    const match = clean.match(/\{[\s\S]*\}/)
    if (!match) return null
    const parsed = JSON.parse(match[0])
    if (typeof parsed.i !== 'number' || !fresh[parsed.i]) return null
    return fresh[parsed.i]
  } catch {
    return null
  }
}

// ─── Drafting ──────────────────────────────────────────────────────────────
// No minimum length, no padding. Three words is a complete answer if
// that's what a genuine reaction takes — see the few-shot examples below.
async function draftKarmaComment(candidate) {
  const messages = [{
    role: 'user',
    content: `Write a short Reddit comment reacting to this post. This is NOT a helpful answer or advice — it's a quick, genuine reaction, the kind that gets upvoted in a fast-moving thread.

POST: "${candidate.title}" (in r/${candidate.subreddit})

Rules:
- Absolutely no mention of any product, tool, or service. This is not a pitch. Never bring one up.
- Length is whatever a real reaction takes — could be 2-3 words, could be one full sentence, could be two. Never pad it out to hit a length. A short, flat reply that just states the thing is often funnier and more real than an explained one.
- No hedging, no "I think", no justifying why it's true or funny — state it like a fact or a clean image, done.
- No dashes, no semicolons, no arrow notation, no tidy structure.
- Lowercase is fine. Contractions are fine. Don't sound like you're trying to sound young — just sound like a real person who typed fast and moved on.

Examples of the right energy (different thread, for tone reference only — do not reuse these):
"escort. hard no."
"he said 'i'm not like other guys' unprompted"
"changed his netflix profile icon to a picture of his mom. still logged in 3 years later"
"they let the joke land before laughing at their own"
"cereal before milk is not up for debate"

Example of what NOT to do — technically casual but explains itself, which kills it:
"honestly I think I'd struggle with that lol, that's just not something I could handle tbh"

Write only the comment. Nothing else.`,
  }]

  let raw = (await cerebrasReply(messages, 150)).trim()
  if (!raw) raw = (await groqReply(messages, 150)).trim()
  if (!raw) raw = (await nemotronReply(messages, 800)).trim()
  if (!raw) return ''

  // Deliberately no minimum-length rejection here (reply.js's version
  // rejects anything under 15 characters — that would kill "OnlyFans."
  // outright, which is exactly the kind of reply this endpoint exists to
  // produce). Only an upper bound, since a karma comment sprawling into a
  // paragraph has already failed at the one thing it's for.
  const words = raw.trim().split(/\s+/).filter(Boolean)
  if (words.length > 40) raw = words.slice(0, 40).join(' ')

  const cleanScore = tooCleanScore(raw)
  if (cleanScore >= 3) raw = await casualizeReply(raw)

  return humanizeText(raw)
}

// ─── Main handler ─────────────────────────────────────────────────────────
// Input: { candidates: [{ id, title, subreddit, url, upvotes, numComments,
// ageMinutes }], source: 'lead_sub' | 'generic' }
// Output: { picked: null } or { picked: { ...candidate, draftComment,
// pickedVia: 'content_shape' | 'velocity' } }
//
// No pacing/rate-limit guard by design (removed on request) — the only
// thing keeping this infrequent is that both signals are genuinely
// selective, not an enforced cap. Known tradeoff, flagged and accepted.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { candidates, source } = req.body
  if (!candidates?.length) return res.status(200).json({ picked: null })

  console.log(`[karma] ${candidates.length} candidates | source: ${source}`)

  try {
    let picked = await pickByContentShape(candidates)
    let pickedVia = 'content_shape'

    if (!picked) {
      const byVelocity = scoreVelocity(candidates)
      if (byVelocity.length) {
        picked = byVelocity[0]
        pickedVia = 'velocity'
      }
    }

    if (!picked) {
      console.log('[karma] no candidate cleared either signal this run')
      return res.status(200).json({ picked: null })
    }

    console.log(`[karma] picked "${picked.title.slice(0, 60)}" via ${pickedVia}`)
    const draftComment = await draftKarmaComment(picked)

    if (!draftComment) {
      console.log('[karma] drafting failed — no usable comment produced')
      return res.status(200).json({ picked: null })
    }

    console.log(`[karma] draft: "${draftComment}"`)
    return res.status(200).json({ picked: { ...picked, draftComment, pickedVia } })
  } catch (err) {
    console.error('[karma] fatal:', err.message)
    return res.status(500).json({ error: 'Karma comment generation failed' })
  }
}
