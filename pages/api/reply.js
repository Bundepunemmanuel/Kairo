// reply.js — On-demand reply generation for a single lead
// Called only when user taps "View Draft Reply", or from the follow-up
// conversation loop after pasting the thread owner's response.
// Cerebras gpt-oss-120b (primary, 1M tokens/day) → Groq openai/gpt-oss-120b (fallback) → Nemotron 3 Ultra via OpenRouter free tier (final fallback, no retry)

import { createClient } from '@supabase/supabase-js'

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// Retries (Cerebras empty-retry, rate-limit waits) can exceed Vercel's
// default 5-10s Hobby timeout — same reasoning as score.js.
export const config = { maxDuration: 60 }

async function groqReply(messages) {
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({ model: 'openai/gpt-oss-120b', messages, max_tokens: 500, temperature: 0.75, reasoning_effort: 'low' }),
    })
    const data = await res.json()
    if (data.error) { console.log('[reply:groq] error:', data.error.message); return '' }
    let raw = data.choices?.[0]?.message?.content || ''
    const finishReason = data.choices?.[0]?.finish_reason
    // Log finish_reason too — distinguishes a genuine content-safety
    // refusal from other empty-response causes, instead of guessing.
    console.log('[reply:groq] finish_reason:', finishReason, '| content length:', raw.length)
    if (!raw) console.log('[reply:groq] full response (empty content):', JSON.stringify(data).slice(0, 800))

    // finish_reason "length" means the API cut this off mid-generation
    // before the model naturally finished — a broken, incomplete reply
    // even if what came through looks short enough word-count-wise.
    // Treat it as invalid so it falls through to the next model instead
    // of silently accepting a sentence that trails off mid-thought.
    if (finishReason === 'length') {
      console.log('[reply:groq] response was truncated (finish_reason: length) — treating as invalid')
      return ''
    }

    console.log('[reply:groq] raw output:', JSON.stringify(raw.slice(0, 300)))
    return raw
  } catch (e) {
    console.log('[reply:groq] fetch error:', e.message)
    return ''
  }
}

async function cerebrasReply(messages, _isRetry = false) {
  try {
    const res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.CEREBRAS_API_KEY}` },
      body: JSON.stringify({ model: 'gpt-oss-120b', messages, max_tokens: 500, temperature: 0.75, reasoning_effort: 'low' }),
    })
    const data = await res.json()
    if (data.error) { console.log('[reply:cerebras] error:', data.error.message); return '' }
    const raw = data.choices?.[0]?.message?.content || ''
    const finishReason = data.choices?.[0]?.finish_reason
    console.log('[reply:cerebras] finish_reason:', finishReason, '| content length:', raw.length)

    // Cerebras sometimes returns 200 with genuinely blank content — not an
    // error, just nothing. Retry once before falling through to Groq.
    if (!raw && !_isRetry) {
      console.log('[reply:cerebras] empty content on success response — full response:', JSON.stringify(data).slice(0, 800))
      console.log('[reply:cerebras] retrying once')
      await new Promise(r => setTimeout(r, 3000))
      return cerebrasReply(messages, true)
    }

    // Truncated mid-generation — broken output even if short enough by
    // word count. Treat as invalid, same as empty, so it falls through.
    if (finishReason === 'length') {
      console.log('[reply:cerebras] response was truncated (finish_reason: length) — treating as invalid')
      return ''
    }

    console.log('[reply:cerebras] raw output:', JSON.stringify(raw.slice(0, 300)))
    return raw
  } catch (e) {
    console.log('[reply:cerebras] fetch error:', e.message)
    return ''
  }
}

// Third fallback only — no retry. By the time both Cerebras and Groq have
// failed, waiting on a retry risks the function timeout for no real gain.
//
// Nemotron is a reasoning model: it "thinks" before answering, and that
// thinking consumes the same token budget as the final answer. With the
// same 500-token cap as the other models, it was running out of budget
// mid-thought and never reaching the actual reply — the "raw output" was
// 100% reasoning prose, truncated mid-sentence, with no answer at all.
// Fix: request reasoning exclusion, give it a much bigger budget so
// reasoning + answer both fit, and reject anything that still looks like
// leaked reasoning as a last resort.
function looksLikeReasoningTrace(text) {
  const tells = [
    'the user is', 'the user wants', 'i need to write', 'let me draft',
    'let me write', 'word count:', 'we need to', 'i should',
  ]
  const lower = text.toLowerCase()
  // Long + starts with a tell phrase is a strong signal this is reasoning
  // prose, not a Reddit reply (real replies are 60-90 words, ~400-500 chars)
  return text.length > 600 && tells.some(t => lower.startsWith(t) || lower.includes(`\n${t}`))
}

async function nemotronReply(messages) {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
      body: JSON.stringify({
        model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
        messages,
        max_tokens: 3000, // reasoning + answer both need to fit
        temperature: 0.75,
        reasoning: { exclude: true }, // ask OpenRouter to keep reasoning out of content
      }),
    })
    const data = await res.json()
    if (data.error) { console.log('[reply:nemotron] error:', data.error.message); return '' }
    let raw = data.choices?.[0]?.message?.content || ''
    const finishReason = data.choices?.[0]?.finish_reason
    console.log('[reply:nemotron] finish_reason:', finishReason, '| content length:', raw.length)
    if (!raw) console.log('[reply:nemotron] full response (empty content):', JSON.stringify(data).slice(0, 800))

    if (finishReason === 'length') {
      console.log('[reply:nemotron] response was truncated (finish_reason: length) — treating as invalid')
      return ''
    }

    // Belt-and-suspenders: strip <think> tags if present (some models use
    // them despite the exclude param not fully working), and reject
    // anything that still looks like leaked reasoning prose.
    raw = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
    if (looksLikeReasoningTrace(raw)) {
      console.log('[reply:nemotron] output still looks like a reasoning trace — rejecting')
      return ''
    }
    console.log('[reply:nemotron] raw output:', JSON.stringify(raw.slice(0, 300)))
    return raw
  } catch (e) {
    console.log('[reply:nemotron] fetch error:', e.message)
    return ''
  }
}

const VOICE_PRESETS = [
  {
    name: 'blunt-practical',
    instruction: 'Blunt and to the point. Short sentences. No cushioning or preamble — get straight to what worked for you.',
  },
  {
    name: 'casual-conversational',
    instruction: 'Casual, like texting a friend. Contractions everywhere. Fine to trail off with "anyway" or "idk" energy. Slightly imperfect grammar is fine.',
  },
  {
    name: 'skeptical-but-helpful',
    instruction: 'A little skeptical of easy answers — open with mild pushback or "tbh" before offering the actual help. Not cynical, just realistic.',
  },
  {
    name: 'warm-empathetic',
    instruction: 'Warm and validating, like someone who has been through the same thing. Slower pacing, one personal-sounding detail, no corporate warmth.',
  },
]

// Shared rule injected into every prompt — model-agnostic, applies
// regardless of which of the three models ends up generating a reply.
const ANTI_FABRICATION_RULE = 'CRITICAL: Never invent specific numbers, names, timeframes, or anecdotes about other founders, customers, or results — you do not know these and must not make them up. Only reference what this product actually does, in general terms. Build credibility through specificity about THEIR problem, not fabricated success stories.'

const MAX_REPLY_WORDS = 90
const HARD_MAX_WORDS = 150 // beyond this, treat as a rejection and try the next model

function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length
}

// Truncate at the last complete sentence under the limit, rather than
// cutting off mid-word — used only if all 3 models are still over length.
function truncateToLastSentence(text, maxWords) {
  const words = text.trim().split(/\s+/)
  if (words.length <= maxWords) return text
  const truncated = words.slice(0, maxWords).join(' ')
  const lastSentenceEnd = Math.max(truncated.lastIndexOf('.'), truncated.lastIndexOf('!'), truncated.lastIndexOf('?'))
  return lastSentenceEnd > 40 ? truncated.slice(0, lastSentenceEnd + 1) : truncated + '.'
}

// ─── Post-processing cleanup pass ──────────────────────────────────────
// Pure text transformation, no AI call — runs on whatever the model
// returns, cleaning up the most common mechanical "this was AI-written"
// tells without touching the model or the prompt at all.
function humanizeText(text) {
  let result = text

  // Detect once, up front, whether this reply is intentionally styled
  // all-lowercase (common after the casualize pass) — based on the first
  // letter of the whole text, before any of our own transformations run.
  // Used below so sentence-splits match the existing style instead of
  // always forcing proper-case, which is what caused a lone capitalized
  // word to stick out in an otherwise all-lowercase reply.
  const firstLetterMatch = text.match(/[a-zA-Z]/)
  const isLowercaseStyle = firstLetterMatch ? firstLetterMatch[0] === firstLetterMatch[0].toLowerCase() : false

  // Curly/typographic quotes → straight quotes. Real people typing on
  // mobile Reddit essentially never produce proper typographic
  // punctuation; AI output frequently does by default.
  result = result
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')

  // Curly ellipsis (…) → three plain periods. Same "formal typesetting"
  // tell as curly quotes — real typing produces "..." from the keyboard,
  // not the single Unicode ellipsis character.
  result = result.replace(/\u2026/g, '...')

  // Non-breaking space → regular space. Sometimes shows up in AI output
  // copied from formatted contexts; invisible in the UI but not something
  // a phone keyboard produces.
  result = result.replace(/\u00A0/g, ' ')

  // Stray bullet/list characters, in case one slips through despite the
  // prompt saying no bullet points.
  result = result.replace(/^[•●▪◦]\s*/gm, '')

  // ── Compound-word hyphen-like characters ──────────────────────────
  // Non-breaking hyphen (‑) and minus sign (−) are frequently used
  // correctly INSIDE words with no surrounding spaces — "15‑minute",
  // "sign‑ups". These should never be split into sentences; just
  // normalize them to a plain keyboard hyphen. This runs BEFORE the
  // true-dash handling below, and only touches cases with no whitespace
  // on either side (a real compound word), leaving anything with actual
  // spacing to the sentence-level logic instead.
  result = result.replace(/(\S)[‑−](\S)/g, '$1-$2')

  // ── True sentence-level dashes ─────────────────────────────────────
  // Em dash (—), en dash (–), figure dash (‒), horizontal bar (―),
  // two-em/three-em dash (⸺⸻), fullwidth hyphen (－), and
  // double-hyphen-as-dash (--) all get used by AI models in the same
  // unnatural "formal writing" way — joining two complete thoughts, or
  // setting off a short aside. Same contextual handling for all:
  //   - dash joining two things that could each stand alone as a
  //     sentence → split into two sentences with a period
  //   - dash used as a short parenthetical aside → comma instead
  //
  // Whitespace around the dash is OPTIONAL here (\s*, not \s) — a real
  // gap in an earlier version required spacing on both sides, which let
  // no-space dash usage like "lifting—finding" pass through completely
  // unconverted (this happened in production). Unlike the compound-word
  // hyphen handling above, this is safe with no whitespace requirement:
  // none of these are ASCII hyphens, and none of these specific Unicode
  // dash characters are ever legitimately used inside a real compound
  // word the way a plain "-" is in "15-minute" or "sign-ups".
  //
  // IMPORTANT: the match only consumes the dash + the single character
  // right after it (nextChar). We use a bounded lookahead purely to
  // *estimate* word count for the split-vs-comma decision — that preview
  // text is never re-inserted into the output. Only nextChar itself gets
  // transformed (capitalized or not); everything after it is left
  // completely untouched by the regex engine, so nothing gets duplicated.
  const dashPattern = /\s*(?:—|–|‒|―|⸺|⸻|－|--)\s*(\S)/g
  result = result.replace(dashPattern, (match, nextChar, offset, full) => {
    // Scope "before" to just the current sentence, not the whole reply —
    // otherwise, a few sentences into a long reply, this check always
    // sees "plenty of words before" regardless of what's actually in the
    // current sentence, making the split trigger far too eagerly.
    const textBeforeMatch = full.slice(0, offset)
    const lastSentenceBoundary = Math.max(
      textBeforeMatch.lastIndexOf('.'), textBeforeMatch.lastIndexOf('!'), textBeforeMatch.lastIndexOf('?')
    )
    const before = textBeforeMatch.slice(lastSentenceBoundary + 1).trim()
    const beforeWords = before.split(/\s+/).filter(Boolean).length
    const afterPreview = full.slice(offset + match.length, offset + match.length + 100)
    const afterWordsEstimate = afterPreview.trim().split(/\s+/).filter(Boolean).length

    // Both sides substantial — likely two joined complete thoughts.
    // Split into separate sentences. Match the reply's existing
    // capitalization style instead of always forcing a capital.
    if (beforeWords >= 5 && afterWordsEstimate >= 4) {
      return '. ' + (isLowercaseStyle ? nextChar.toLowerCase() : nextChar.toUpperCase())
    }
    // Otherwise treat as a short aside — comma reads more like natural
    // typing than a dash.
    return ', ' + nextChar
  })

  // Semicolons are a strong formal-writing tell — real Reddit replies
  // essentially never use them. Split into two sentences instead.
  // Same fix as above: only capture+transform the single next character,
  // never re-inject a slice of the remaining text. Matches the reply's
  // existing capitalization style rather than always forcing a capital.
  result = result.replace(/\s*;\s*(\S)/g, (match, nextChar) =>
    '. ' + (isLowercaseStyle ? nextChar.toLowerCase() : nextChar.toUpperCase())
  )

  // Arrow notation (Settings → Health → Apps) reads like documentation,
  // not a typed comment. Swap for how people actually type steps.
  result = result.replace(/\s*→\s*/g, ' > ')

  // Collapse any double punctuation/spacing the above handling might have
  // introduced (e.g. "thing. , next" from an aside right after a split).
  result = result.replace(/\s+,/g, ',').replace(/\.\s*\./g, '.').replace(/\s{2,}/g, ' ').trim()

  return result
}

// ─── "Too clean" heuristic ──────────────────────────────────────────────
// Checked on the reply BEFORE humanizeText() strips dashes/semicolons, so
// their presence can still be detected as a signal. Scores 0-8; 3+ means
// the reply reads more like composed prose than something typed quickly,
// and triggers the casualize pass below. This threshold is a starting
// guess, not scientifically tuned — watch [reply] too-clean-score logs
// and adjust if it's firing too often or not enough.
//
// productName is optional — when passed, also checks for the specific
// "setup → problem → solution → benefit" tell: the product name followed
// shortly by a benefit clause ("so you...", "which means..."). That's the
// tail end of the formulaic pitch arc, and it's a real miss without this:
// a real example that reached Reddit ("Kairo does the heavy lifting...
// so you only spend time on prospects that are already primed") scored 2
// under the old checks alone — under the 3-point threshold — because
// nothing here looked for dashes or that specific structural shape.
function tooCleanScore(text, productName) {
  let score = 0
  if (/;/.test(text)) score++
  if (/→/.test(text)) score++
  if (/\([^)]+,\s*[^)]+\)/.test(text)) score++ // parenthetical list, e.g. "(weight, sleep, activity)"

  // Em/en dash and lookalikes — the single most common AI-writing tell,
  // and previously not checked here at all (only handled downstream by
  // humanizeText's cleanup, which itself had a gap — see that function).
  if (/[—–‒―⸺⸻－]/.test(text)) score++

  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean)
  const allProperlyPunctuated = sentences.every(s => /[.!?]$/.test(s.trim()))
  if (allProperlyPunctuated && sentences.length > 1) score++

  const hasContraction = /\b(won't|don't|it's|can't|didn't|isn't|i'm|that's|there's|wasn't)\b/i.test(text)
  if (!hasContraction) score++

  const hasCasualFiller = /\b(lol|tbh|ngl|yeah|honestly|kinda|gonna|idk|anyway)\b/i.test(text)
  if (!hasCasualFiller) score++

  // Structural tell: product name immediately pivoting into a benefit
  // clause is the closing beat of the formulaic setup→problem→solution→
  // benefit arc, regardless of how casual the wording around it sounds.
  if (productName) {
    const escaped = productName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const benefitPivot = new RegExp(`${escaped}[^.!?]*\\b(so you|which means|meaning you|so now)\\b`, 'i')
    if (benefitPivot.test(text)) score++
  }

  return score
}

// Genuine refusal/failure tells — a reply containing these is actively
// broken (e.g. "As an AI, I cannot..." posted to Reddit), so these still
// cause rejection + fallback to the next model.
const HARD_REJECT_PHRASES = [
  'as an ai', 'i cannot assist', 'i am unable to', "i'm unable to",
  'i cannot help with that', "i can't help with that",
]

// Style-only tells — these just sound a bit generic/AI-ish, not broken.
// The prompt below still tells the model to avoid them, but a reply
// containing one is no longer discarded — too many good replies were
// getting thrown away over a single word choice.
const STYLE_PHRASES = [
  'i understand your frustration', "i understand how", 'i totally get',
  'in today\'s world', "in today's fast-paced", 'at the end of the day',
  'it sounds like', 'it seems like you', 'have you considered',
  'i hope this helps', 'feel free to', 'happy to help',
  'game changer', 'game-changer', 'seamless', 'streamline',
  'leverage', 'unlock', 'elevate your', 'take it to the next level',
]

// ─── Casualize pass ─────────────────────────────────────────────────────
// Only runs when tooCleanScore() flags a reply as reading like composed
// prose rather than something typed quickly. Reuses the existing
// Cerebras→Groq functions rather than new provider-calling code. If this
// call fails or comes back empty, the original reply is used as-is —
// never lose a working reply because the polish step failed.
async function casualizeReply(originalReply) {
  const messages = [{
    role: 'user',
    content: `Rewrite this Reddit reply to sound like a real person typed it quickly on their phone, not like it was composed carefully.

Original:
"${originalReply}"

Rules:
- Keep the facts and meaning 100% identical — don't add or remove information
- Loosen the structure — allow it to feel a bit rambling or imperfect, the way people actually type
- Lowercase is fine, imperfect grammar is fine, trailing off is fine
- Use contractions naturally (won't, don't, it's, that's)
- No semicolons, no dashes of any kind, no arrow notation, no tidy parenthetical lists
- Don't make it longer than the original

Write only the rewritten reply. Nothing else.`,
  }]

  let casualized = await cerebrasReply(messages)
  casualized = casualized.trim()

  if (!casualized || casualized.length < 15) {
    console.log('[reply] casualize: Cerebras empty — trying Groq')
    casualized = await groqReply(messages)
    casualized = casualized.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
  }

  if (!casualized || casualized.length < 15) {
    console.log('[reply] casualize pass failed — keeping original reply')
    return originalReply
  }

  return casualized
}

// Runs Cerebras first (1M tokens/day, vs Groq's shared 200K/day pool that
// scoring also depends on), falls back to Groq if empty/too short/a
// genuine refusal. Shared by both initial-reply and follow-up modes.
async function generateWithFallback(messages, productName) {
  let reply = await cerebrasReply(messages)
  reply = reply.trim()

  const isHardReject = (text) => HARD_REJECT_PHRASES.some(p => text.toLowerCase().includes(p))
  const isTooLong = (text) => wordCount(text) > HARD_MAX_WORDS

  if (!reply || reply.length < 15 || isHardReject(reply) || isTooLong(reply)) {
    console.log(reply ? `[reply] Cerebras response rejected (refusal or ${wordCount(reply)} words) — trying Groq` : '[reply] Cerebras empty — trying Groq')
    reply = await groqReply(messages)
    reply = reply.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
  }

  if (!reply || reply.length < 15 || isHardReject(reply) || isTooLong(reply)) {
    console.log(reply ? `[reply] Groq response rejected (refusal or ${wordCount(reply)} words) — trying Nemotron (final)` : '[reply] Groq empty — trying Nemotron (final)')
    reply = await nemotronReply(messages)
  }

  if (reply && isHardReject(reply)) {
    console.log('[reply] Nemotron also refused — rejecting')
    reply = ''
  }

  if (!reply || reply.length < 15) return ''

  // All 3 models tried — if still over length, truncate rather than
  // discard entirely (better than showing nothing after 3 attempts).
  if (isTooLong(reply)) {
    console.log(`[reply] still ${wordCount(reply)} words after all fallbacks — truncating`)
    reply = truncateToLastSentence(reply, MAX_REPLY_WORDS)
  }

  // Check BEFORE humanizeText strips dashes/semicolons, so their
  // presence still counts as a signal for this check.
  const cleanScore = tooCleanScore(reply, productName)
  console.log(`[reply] too-clean-score: ${cleanScore}/8`)
  if (cleanScore >= 3) {
    console.log('[reply] reply flagged as too clean — running casualize pass')
    reply = await casualizeReply(reply)
  }

  return humanizeText(reply)
}

function pickVoice() {
  const voice = VOICE_PRESETS[Math.floor(Math.random() * VOICE_PRESETS.length)]
  console.log(`[reply] voice: ${voice.name}`)
  return voice
}

function parseJSON(raw) {
  try {
    const clean = raw.replace(/```json|```/g, '').trim()
    const match = clean.match(/\{[\s\S]*\}/)
    if (!match) return null
    return JSON.parse(match[0])
  } catch {
    return null
  }
}

// No-pitch detection now reads from subreddit_rules, auto-populated and
// refreshed by cron-scan's checkSubredditRules() — no more hardcoded
// list to maintain by hand as removals get noticed one at a time. If a
// subreddit has no entry yet (never scanned, or the lookup itself
// fails), default to false (safe to pitch) — better to occasionally
// pitch somewhere that turns out to ban it than to silently withhold
// every mention because of a missing row or a transient DB hiccup.
async function isNoPitchSubreddit(subreddit) {
  if (!subreddit) return false
  try {
    const { data } = await supabaseAdmin
      .from('subreddit_rules')
      .select('no_pitch')
      .eq('subreddit', subreddit.toLowerCase())
      .single()
    return data?.no_pitch === true
  } catch (e) {
    console.log(`[reply] no-pitch lookup failed for r/${subreddit}, defaulting to false:`, e.message)
    return false
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { post, analysis, signalType, specificProblem, conversation } = req.body
  if (!post || !analysis) return res.status(400).json({ error: 'post and analysis required' })

  // ─── Follow-up mode: conversation history present ────────────────────
  // The user pasted what the thread owner replied with. Kairo decides
  // whether this is still worth pursuing, and if so, drafts the next reply.
  if (Array.isArray(conversation) && conversation.length > 0) {
    console.log(`[reply] follow-up mode, ${conversation.length} messages so far`)

    const transcript = conversation
      .map(m => `${m.role === 'sent' ? 'You' : 'Them'}: ${m.text}`)
      .join('\n')

    const voice = pickVoice()

    const followupMessages = [
      {
        role: 'system',
        content: 'You help draft Reddit follow-up replies. Return only a valid JSON object. No markdown, no code fences, no explanation before or after.',
      },
      {
        role: 'user',
        content: `You're helping a founder follow up on a Reddit conversation about their product.

Product: ${analysis.name} — ${analysis.description}
Original post: "${post.title}"
Their original problem: ${specificProblem}

Conversation so far:
${transcript}

Voice for the next reply: ${voice.instruction}

First, judge the thread owner's LAST message: are they still a real, engaged prospect worth continuing to help, or have they declined, gone quiet in a way that signals disinterest, resolved their problem another way, or shown they're not a fit? Be honest here — don't keep a dead conversation alive just to keep going.

Then respond with ONLY a JSON object, no markdown, no explanation:
{"status": "open" or "closed", "reply": "next reply text, or empty string if status is closed"}

If status is "closed", reply must be an empty string — don't write a reply for a conversation that should end.
If status is "open", the reply should:
- STRICT LENGTH LIMIT: 40-80 words. This is a hard cap — do not exceed 80 words under any circumstance.
- ${ANTI_FABRICATION_RULE}
- Directly respond to what they just said — reference specifics from their last message
- Not repeat the pitch from your first message — this is a continuing conversation, not a fresh intro
- Sound like a real person continuing a conversation, not restarting one
- Avoid generic phrases like "I understand," "it sounds like," "happy to help"
- Respond to ONE thing they said — don't try to cover multiple points or lay out a full plan. A real person replying to a comment reacts to what's in front of them, not a comprehensive follow-up.
- The underlying goal here is moving this person toward genuinely trying the product — but that has to happen through natural conversation, not a sales sequence. Keep steering toward that outcome across the conversation, one small, human-sounding nudge at a time, never a pitch-shaped message.

Write like a real person continuing a casual conversation, not composed prose — no dashes, no semicolons, no arrow notation, contractions are good, a little rambling is fine, and don't try to be thorough.`,
      },
    ]

    // Cerebras first — same reasoning as score.js: 1M tokens/day vs Groq's
    // 200K shared across the whole app. Groq is the fallback here now,
    // not the primary, to stop reply generation from starving scoring's
    // shared daily budget.
    const raw = await cerebrasReply(followupMessages)
    console.log('[reply] follow-up raw:', JSON.stringify(raw.slice(0, 300)))

    let parsed = parseJSON(raw)
    if (!parsed) {
      console.log('[reply] follow-up parse failed — trying Groq')
      const groqRaw = await groqReply(followupMessages)
      parsed = parseJSON(groqRaw)
    }

    if (!parsed) {
      console.log('[reply] follow-up: Groq also failed — trying Nemotron (final)')
      const nemotronRaw = await nemotronReply(followupMessages)
      parsed = parseJSON(nemotronRaw)
    }

    if (!parsed) {
      console.log('[reply] follow-up: all three models failed to produce valid JSON')
      // Fail safe to "open" with no reply — better to let the user
      // decide manually than to silently close a live conversation.
      return res.status(200).json({ status: 'open', reply: '' })
    }

    const status = parsed.status === 'closed' ? 'closed' : 'open'
    let reply = status === 'open' ? String(parsed.reply || '').trim() : ''

    if (reply && wordCount(reply) > 130) {
      console.log(`[reply] follow-up reply too long (${wordCount(reply)} words) — truncating`)
      reply = truncateToLastSentence(reply, 80)
    }

    if (reply) {
      const cleanScore = tooCleanScore(reply, analysis.name)
      console.log(`[reply] follow-up too-clean-score: ${cleanScore}/8`)
      if (cleanScore >= 3) {
        console.log('[reply] follow-up reply flagged as too clean — running casualize pass')
        reply = await casualizeReply(reply)
      }
      reply = humanizeText(reply)
    }

    console.log(`[reply] follow-up result: status=${status}, reply length=${reply.length}`)
    return res.status(200).json({ status, reply })
  }

  // ─── Initial reply mode (existing behavior) ───────────────────────────
  console.log(`[reply] generating for: "${post.title?.slice(0, 50)}"`)

  const voice = pickVoice()
  const noPitch = await isNoPitchSubreddit(post.subreddit)
  if (noPitch) console.log(`[reply] r/${post.subreddit} is a no-pitch subreddit — writing plug-free reply`)

  const messages = [{
    role: 'user',
    content: `Write a Reddit reply for this post.

Product: ${analysis.name} — ${analysis.description}
Post title: "${post.title}"
Post excerpt: "${(post.body || '').slice(0, 200)}"
Subreddit: r/${post.subreddit}
Their problem: ${specificProblem}
Signal type: ${signalType}

Voice for this reply: ${voice.instruction}

Rules:
- STRICT LENGTH LIMIT: 60-90 words. This is a hard cap, not a suggestion — do not exceed 90 words under any circumstance.
- ${ANTI_FABRICATION_RULE}
- Vary sentence length — mix short punchy lines with one longer one. Real people don't write in uniform sentences.
- Sound like a real helpful person, not a marketer
- No hashtags, emojis, or bullet points
- Never start with: I, Hey, Great, Wow, As someone
- Avoid generic phrases like "I understand your frustration," "it sounds like," "game changer," "streamline," "leverage," or "at the end of the day" — these read as AI-written
- Reference their specific situation using their own words
- Pick ONE thing to say — one point, one piece of advice, or one reaction. Do not give a step-by-step sequence or a mini-framework covering multiple angles. Real people respond to one thing that caught their attention, not a comprehensive plan.
- Do NOT structure the reply as setup → naming the problem → offering the solution → stating the benefit, in that order. That clean four-part arc reads as composed marketing copy even when the individual words sound casual — casual wording doesn't fix a formulaic shape underneath it.
- Include at least one of: a tangent or thought that trails off instead of resolving cleanly, a self-directed caveat about the product's own limits, or inconsistent capitalization/spelling. Pick only one of these, not all three — real inconsistency isn't uniform. Don't force a tidy closing line; it's fine to just stop after a practical detail.
- ${noPitch
    ? `This subreddit (r/${post.subreddit}) bans vendor/promotional replies. Do NOT mention ${analysis.name} or any product at all. Just give genuinely useful, specific advice for their exact situation — the goal here is being helpful, not generating a lead.`
    : `Mention ${analysis.name} once naturally — not as a pitch`}
- ${signalType === 'active' ? `Be direct. Lead with how ${noPitch ? 'to think about' : analysis.name + ' solves'} their exact problem.` : `Lead with empathy. Validate their frustration.${noPitch ? '' : ` Mention ${analysis.name} briefly at the end.`}`}

Example of what NOT to do (too clean AND too organized — reads as composed/AI-written):
"This runs into the same thing – it won't work unless permissions are actually granted. Open Settings → Health → Apps, find the app, and make sure everything you want is toggled on (weight, sleep, activity). Then force-quit and reopen the app; the connection usually resets."
(Notice: this also covers multiple steps in sequence — that thoroughness itself is a tell, separate from the punctuation.)

Example of what a real person would actually type instead:
"oh yeah this happened to me too lol. go into settings, then health, then apps, find it in the list and check the permissions are actually turned on (mine had half of them off for no reason). close the app fully after and reopen it, sometimes it just needs a kick to sync"

Notice the difference: opens with a reaction, no dashes/semicolons/arrows, contractions, slightly rambling, trails off instead of wrapping up neatly, and sticks to one thread of thought instead of a organized sequence. Write your reply in that second style.

Second example of what NOT to do — this one sounds casual on the surface but still follows the banned setup → problem → solution → benefit shape, and uses dashes with no spaces around them (still a dash, still a tell):
"zero budget means you gotta go where people already hang out. i stopped chasing cold ads and just started scanning reddit for folks actually saying they need a tool like yours. that's where the buying intent lives, and you can jump into the convo with a tailored reply. Kairo does the heavy lifting—finding those posts, scoring them, and even drafting a response—so you only spend time on prospects that are already primed."

Second example of a real reply instead — same underlying advice, no clean arc, one dropped thread, one self-directed caveat, no tidy ending:
"ok so zero budget thing that actually worked for me: stop making ads nobody asked for and just... go where people are already complaining about not having a tool like this lol. i literally just search reddit for people describing the exact problem my thing solves and reply to them directly. sounds obvious but most people don't do it bc it's tedious as hell to find those posts manually

anyway i've been using kairo for this, it finds the posts and kinda scores how good a fit they are, drafts something to reply with too. still gotta edit the replies myself bc the ai drafts are always a lil off but it saves me from scrolling reddit for 2 hours a day"

Write only the reply text. Nothing else.`,
  }]

  const reply = await generateWithFallback(messages, analysis.name)

  if (!reply) {
    console.log('[reply] both models returned empty or rejected')
    return res.status(200).json({ reply: '' })
  }

  console.log(`[reply] success: ${reply.length} chars`)
  return res.status(200).json({ reply })
}
