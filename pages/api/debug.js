export default async function handler(req, res) {
  const results = {}

  // Test 1: Groq API key exists
  results.hasGroqKey = !!process.env.GROQ_API_KEY
  results.groqKeyLength = process.env.GROQ_API_KEY?.length || 0

  // Test 2: Reddit fetch
  try {
    const r = await fetch('https://www.reddit.com/r/SaaS/new.json?limit=3', {
      headers: { 'User-Agent': 'Kairo/1.0' },
      signal: AbortSignal.timeout(8000),
    })
    const d = await r.json()
    results.redditStatus = r.status
    results.redditPostCount = d?.data?.children?.length || 0
    results.firstPostTitle = d?.data?.children?.[0]?.data?.title || 'none'
  } catch (e) {
    results.redditError = e.message
  }

  // Test 3: Groq API
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: 'Reply with just the word: working' }],
        max_tokens: 10,
      }),
    })
    const d = await r.json()
    results.groqStatus = r.status
    results.groqResponse = d.choices?.[0]?.message?.content || d.error?.message || 'no response'
  } catch (e) {
    results.groqError = e.message
  }

  return res.status(200).json(results)
}
