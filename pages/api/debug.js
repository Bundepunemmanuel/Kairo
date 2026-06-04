export default async function handler(req, res) {
  const results = {}

  // Test RSS feed
  try {
    const r = await fetch('https://www.reddit.com/r/SaaS/new.rss', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Kairo/1.0)',
        'Accept': 'application/rss+xml',
      },
      signal: AbortSignal.timeout(8000),
    })
    const text = await r.text()
    results.rssStatus = r.status
    results.rssFirst200Chars = text.slice(0, 200)
    results.containsItems = text.includes('<item>')
    results.itemCount = (text.match(/<item>/g) || []).length
  } catch (e) {
    results.rssError = e.message
  }

  return res.status(200).json(results)
}
