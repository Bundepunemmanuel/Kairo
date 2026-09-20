// get-share.js — Fetches a shared scan snapshot. Kept as a plain API route
// for anything that wants to check a share's status client-side; the
// /share/[token] page itself now uses getShareByToken directly via
// getServerSideProps (see lib/getShareData.js) rather than calling this,
// since crawlers need the data present at first render, not after a
// client-side fetch resolves.

import { getShareByToken } from '../../lib/getShareData'

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const { token } = req.query
  const result = await getShareByToken(token)

  if (result.status === 'not_found') return res.status(404).json({ error: 'not_found' })
  if (result.status === 'expired') return res.status(410).json({ error: 'expired' })
  return res.status(200).json(result.data)
}
