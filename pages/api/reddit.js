export default async function handler(req, res) {
  const { sub, sort = 'new' } = req.query
  if (!sub) return res.status(400).json({ error: 'sub required' })

  try {
    const response = await fetch(
      `https://www.reddit.com/r/${sub}/${sort}.rss`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Kairo/1.0)',
          'Accept': 'application/atom+xml',
        },
        signal: AbortSignal.timeout(8000),
      }
    )
    const text = await response.text()
    res.setHeader('Content-Type', 'text/xml')
    res.status(response.status).send(text)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
}
