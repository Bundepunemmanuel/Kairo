// reply.js — On-demand reply generation for a single lead
// Called only when user taps "View Draft Reply"
// Groq qwen-qwq-32b primary, Cerebras llama-3.3-70b fallback

async function groqReply(messages) {
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({ model: 'openai/gpt-oss-120b', messages, max_tokens: 500, temperature: 0.75 }),
    })
    const data = await res.json()
    if (data.error) { console.log('[reply:groq] error:', data.error.message); return '' }
    const raw = data.choices?.[0]?.message?.content || ''
    console.log('[reply:groq] raw output:', JSON.stringify(raw.slice(0, 300)))
    return raw
  } catch (e) {
    console.log('[reply:groq] fetch error:', e.message)
    return ''
  }
}

async function cerebrasReply(messages) {
  try {
    const res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.CEREBRAS_API_KEY}` },
      body: JSON.stringify({ model: 'llama-3.3-70b', messages, max_tokens: 500, temperature: 0.75 }),
    })
    const data = await res.json()
    if (data.error) { console.log('[reply:cerebras] error:', data.error.message); return '' }
    const raw = data.choices?.[0]?.message?.content || ''
    console.log('[reply:cerebras] raw output:', JSON.stringify(raw.slice(0, 300)))
    return raw
  } catch (e) {
    console.log('[reply:cerebras] fetch error:', e.message)
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

const BANNED_PHRASES = [
  'as an ai', 'i cannot', 'i am unable', "i'm unable",
  'i understand your frustration', "i understand how", 'i totally get',
  'in today\'s world', "in today's fast-paced", 'at the end of the day',
  'it sounds like', 'it seems like you', 'have you considered',
  'i hope this helps', 'feel free to', 'happy to help',
  'game changer', 'game-changer', 'seamless', 'streamline',
  'leverage', 'unlock', 'elevate your', 'take it to the next level',
]

// Runs Groq first, falls back to Cerebras if empty/too short/AI-sounding.
// Shared by both initial-reply mode and follow-up conversation mode.
async function generateWithFallback(messages) {
  let reply = await groqReply(messages)
  reply = reply.replace(/<think>[\s\S]*?<\/think>/g, '').trim()

  const hasBannedPhrase = (text) => BANNED_PHRASES.some(p => text.toLowerCase().includes(p))

  if (!reply || reply.length < 15 || hasBannedPhrase(reply)) {
    console.log(reply ? '[reply] Groq sounded AI-generated — trying Cerebras' : '[reply] Groq empty — trying Cerebras')
    reply = await cerebrasReply(messages)
    reply = reply.trim()
  }

  if (reply && hasBannedPhrase(reply)) {
    console.log('[reply] Cerebras also sounded AI-generated — rejecting')
    reply = ''
  }

  return (!reply || reply.length < 15) ? '' : reply
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

    const followupMessages = [{
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
- Be 40-80 words
- Directly respond to what they just said — reference specifics from their last message
- Not repeat the pitch from your first message — this is a continuing conversation, not a fresh intro
- Sound like a real person continuing a conversation, not restarting one
- Avoid generic phrases like "I understand," "it sounds like," "happy to help"`,
    }]

    const raw = await groqReply(followupMessages)
    console.log('[reply] follow-up raw:', JSON.stringify(raw.slice(0, 300)))

    let parsed = parseJSON(raw)
    if (!parsed) {
      console.log('[reply] follow-up parse failed — trying Cerebras')
      const cerebrasRaw = await cerebrasReply(followupMessages)
      parsed = parseJSON(cerebrasRaw)
    }

    if (!parsed) {
      console.log('[reply] follow-up: both models failed to produce valid JSON')
      // Fail safe to "open" with no reply — better to let the user
      // decide manually than to silently close a live conversation.
      return res.status(200).json({ status: 'open', reply: '' })
    }

    const status = parsed.status === 'closed' ? 'closed' : 'open'
    const reply = status === 'open' ? String(parsed.reply || '').trim() : ''
    console.log(`[reply] follow-up result: status=${status}, reply length=${reply.length}`)
    return res.status(200).json({ status, reply })
  }

  // ─── Initial reply mode (existing behavior) ───────────────────────────
  console.log(`[reply] generating for: "${post.title?.slice(0, 50)}"`)

  const voice = pickVoice()

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
- 60-90 words
- Vary sentence length — mix short punchy lines with one longer one. Real people don't write in uniform sentences.
- Sound like a real helpful person, not a marketer
- No hashtags, emojis, or bullet points
- Never start with: I, Hey, Great, Wow, As someone
- Avoid generic phrases like "I understand your frustration," "it sounds like," "game changer," "streamline," "leverage," or "at the end of the day" — these read as AI-written
- Reference their specific situation using their own words
- Mention ${analysis.name} once naturally — not as a pitch
- ${signalType === 'active' ? `Be direct. Lead with how ${analysis.name} solves their exact problem.` : `Lead with empathy. Validate their frustration. Mention ${analysis.name} briefly at the end.`}

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
