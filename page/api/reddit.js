export default async function handler(req, res) {
  const { sub, sort = 'new' } = req.query
  if (!sub) return res.status(400).json({ error: 'sub required' })

  const sorts = sort === 'new' ? ['new', 'hot', 'top'] : [sort, 'new', 'hot']

  for (const s of sorts) {
    try {
      const response = await fetch(
        `https://www.reddit.com/r/${encodeURIComponent(sub)}/${s}.rss?limit=25`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
          },
          signal: AbortSignal.timeout(10000),
        }
      )

      const text = await response.text()

      if (!text.includes('<entry>')) continue

      res.setHeader('Content-Type', 'text/xml; charset=utf-8')
      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate')
      return res.status(200).send(text)
    } catch {
      continue
    }
  }

  return res.status(200).send('<feed></feed>')
}
