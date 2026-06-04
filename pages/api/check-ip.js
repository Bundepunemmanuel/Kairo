// In-memory IP store — moves to Supabase in Chunk 2
const ipStore = new Map()

function getIP(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    '127.0.0.1'
  )
}

export default function handler(req, res) {
  const ip = getIP(req)
  const now = Date.now()
  const window = 24 * 60 * 60 * 1000 // 24 hours

  if (req.method === 'GET') {
    const record = ipStore.get(ip)
    if (!record || now > record.resetAt) {
      return res.status(200).json({ blocked: false })
    }
    if (record.count >= 1) {
      return res.status(200).json({ blocked: true })
    }
    return res.status(200).json({ blocked: false })
  }

  if (req.method === 'POST') {
    const record = ipStore.get(ip)
    if (!record || now > record.resetAt) {
      ipStore.set(ip, { count: 1, resetAt: now + window })
    } else {
      ipStore.set(ip, { ...record, count: record.count + 1 })
    }
    return res.status(200).json({ success: true })
  }

  res.status(405).json({ error: 'Method not allowed' })
}
