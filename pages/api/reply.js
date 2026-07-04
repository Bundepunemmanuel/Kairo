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
    return data.choices?.[0]?.message?.content || ''
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
    return data.choices?.[0]?.message?.content || ''
  } catch (e) {
    console.log('[reply:cerebras] fetch error:', e.message)
    return ''
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { post, analysis, signalType, specificProblem } = req.body
  if (!post || !analysis) return res.status(400).json({ error: 'post and analysis required' })

  console.log(`[reply] generating for: "${post.title?.slice(0, 50)}"`)

  const messages = [{
    role: 'user',
    content: `Write a Reddit reply for this post.

Product: ${analysis.name} — ${analysis.description}
Post title: "${post.title}"
Post excerpt: "${(post.body || '').slice(0, 200)}"
Subreddit: r/${post.subreddit}
Their problem: ${specificProblem}
Signal type: ${signalType}

Rules:
- 60-90 words
- Sound like a real helpful person, not a marketer
- No hashtags, emojis, or bullet points
- Never start with: I, Hey, Great, Wow, As someone
- Reference their specific situation using their own words
- Mention ${analysis.name} once naturally — not as a pitch
- ${signalType === 'active' ? `Be direct. Lead with how ${analysis.name} solves their exact problem.` : `Lead with empathy. Validate their frustration. Mention ${analysis.name} briefly at the end.`}

Write only the reply text. Nothing else.`,
  }]

  // Try Groq qwen first
  let reply = await groqReply(messages)

  // Strip qwen think blocks
  reply = reply.replace(/<think>[\s\S]*?<\/think>/g, '').trim()

  // Fallback to Cerebras if Groq failed
  if (!reply || reply.length < 15) {
    console.log('[reply] Groq empty — trying Cerebras')
    reply = await cerebrasReply(messages)
    reply = reply.trim()
  }

  // Reject generic AI phrases
  if (reply && ['as an ai', 'i cannot', 'i am unable'].some(p => reply.toLowerCase().startsWith(p))) {
    reply = ''
  }

  if (!reply || reply.length < 15) {
    console.log('[reply] both models returned empty')
    return res.status(200).json({ reply: '' })
  }

  console.log(`[reply] success: ${reply.length} chars`)
  return res.status(200).json({ reply })
}
