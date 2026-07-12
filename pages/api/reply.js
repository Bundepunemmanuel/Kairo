// reply.js — On-demand reply generation for a single lead
// Called only when user taps "View Draft Reply", or from the follow-up
// conversation loop after pasting the thread owner's response.
// Cerebras gpt-oss-120b (primary, 1M tokens/day) → Groq openai/gpt-oss-120b (fallback) → Nemotron 3 Ultra via OpenRouter free tier (final fallback, no retry)

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

  // Curly/typographic quotes → straight quotes. Real people typing on
  // mobile Reddit essentially never produce proper typographic
  // punctuation; AI output frequently does by default.
  result = result
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')

  // Catch every dash variant, not just em dash — en dash (–), minus sign
  // (−), and double-hyphen-as-dash (--) all get used by AI models in the
  // same unnatural "formal writing" way. Same contextual handling for all:
  //   - dash joining two things that could each stand alone as a
  //     sentence → split into two sentences with a period
  //   - dash used as a short parenthetical aside → comma instead
  const dashPattern = /\s*(?:—|–|−|--)\s*/g
  result = result.replace(dashPattern, (match, offset, full) => {
    const before = full.slice(0, offset).trim()
    const after = full.slice(offset + match.length).trim()
    const beforeWords = before.split(/\s+/).length
    const afterWords = after.split(/\s+/).length

    // Both sides substantial (5+ words) — likely two joined complete
    // thoughts. Split into separate sentences.
    if (beforeWords >= 5 && afterWords >= 5) {
      const afterCapitalized = after.charAt(0).toUpperCase() + after.slice(1)
      return '. ' + afterCapitalized
    }
    // Otherwise treat as a short aside — comma reads more like natural
    // typing than a dash.
    return ', '
  })

  // Semicolons are a strong formal-writing tell — real Reddit replies
  // essentially never use them. Split into two sentences instead.
  result = result.replace(/\s*;\s*/g, (match, offset, full) => {
    const after = full.slice(offset + match.length).trim()
    const afterCapitalized = after.charAt(0).toUpperCase() + after.slice(1)
    return '. ' + afterCapitalized
  })

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
// their presence can still be detected as a signal. Scores 0-6; 3+ means
// the reply reads more like composed prose than something typed quickly,
// and triggers the casualize pass below. This threshold is a starting
// guess, not scientifically tuned — watch [reply] too-clean-score logs
// and adjust if it's firing too often or not enough.
function tooCleanScore(text) {
  let score = 0
  if (/;/.test(text)) score++
  if (/→/.test(text)) score++
  if (/\([^)]+,\s*[^)]+\)/.test(text)) score++ // parenthetical list, e.g. "(weight, sleep, activity)"

  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean)
  const allProperlyPunctuated = sentences.every(s => /[.!?]$/.test(s.trim()))
  if (allProperlyPunctuated && sentences.length > 1) score++

  const hasContraction = /\b(won't|don't|it's|can't|didn't|isn't|i'm|that's|there's|wasn't)\b/i.test(text)
  if (!hasContraction) score++

  const hasCasualFiller = /\b(lol|tbh|ngl|yeah|honestly|kinda|gonna|idk|anyway)\b/i.test(text)
  if (!hasCasualFiller) score++

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
async function generateWithFallback(messages) {
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
  const cleanScore = tooCleanScore(reply)
  console.log(`[reply] too-clean-score: ${cleanScore}/6`)
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

// Subreddits with explicit anti-self-promotion / anti-vendor AutoMod
// rules — confirmed via a real removal (r/SaaS's rules explicitly ban
// "Vendor Spam," "Promotional or Advertising SaaS," and "I'll review
// your product" posts). No amount of humanizing the writing avoids
// removal here, since the rule targets the *structure* (problem → pitch),
// not the wording. For these, drop the product mention entirely and
// just write a genuinely helpful, plug-free comment.
// Add more here as you confirm other subreddits enforce the same rule.
const NO_PITCH_SUBREDDITS = ['saas']

function isNoPitchSubreddit(subreddit) {
  return NO_PITCH_SUBREDDITS.includes((subreddit || '').toLowerCase())
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

Write like a real person continuing a casual conversation, not composed prose — no dashes, no semicolons, no arrow notation, contractions are good, a little rambling is fine.`,
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
      const cleanScore = tooCleanScore(reply)
      console.log(`[reply] follow-up too-clean-score: ${cleanScore}/6`)
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
  const noPitch = isNoPitchSubreddit(post.subreddit)
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
- ${noPitch
    ? `This subreddit (r/${post.subreddit}) bans vendor/promotional replies. Do NOT mention ${analysis.name} or any product at all. Just give genuinely useful, specific advice for their exact situation — the goal here is being helpful, not generating a lead.`
    : `Mention ${analysis.name} once naturally — not as a pitch`}
- ${signalType === 'active' ? `Be direct. Lead with how ${noPitch ? 'to think about' : analysis.name + ' solves'} their exact problem.` : `Lead with empathy. Validate their frustration.${noPitch ? '' : ` Mention ${analysis.name} briefly at the end.`}`}

Example of what NOT to do (too clean, reads as composed/AI-written):
"This runs into the same thing – it won't work unless permissions are actually granted. Open Settings → Health → Apps, find the app, and make sure everything you want is toggled on (weight, sleep, activity). Then force-quit and reopen the app; the connection usually resets."

Example of what a real person would actually type instead:
"oh yeah this happened to me too lol. go into settings, then health, then apps, find it in the list and check the permissions are actually turned on (mine had half of them off for no reason). close the app fully after and reopen it, sometimes it just needs a kick to sync"

Notice the difference: opens with a reaction, no dashes/semicolons/arrows, contractions, slightly rambling, trails off instead of wrapping up neatly. Write your reply in that second style.

Write only the reply text. Nothing else.`,
  }]

  const reply = await generateWithFallback(messages)

  if (!reply) {
    console.log('[reply] both models returned empty or rejected')
    return res.status(200).json({ reply: '' })
  }

  console.log(`[reply] success: ${reply.length} chars`)
  return res.status(200).json({ reply })
}
