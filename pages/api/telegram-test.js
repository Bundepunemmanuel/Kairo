// telegram-test.js — Sends a test message via Telegram Bot API
// Lets a user confirm their chat ID is correct before relying on it for lead alerts

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { chatId } = req.body
  if (!chatId) return res.status(400).json({ error: 'chatId required' })

  const botToken = process.env.TELEGRAM_BOT_TOKEN
  if (!botToken) {
    return res.status(500).json({ error: 'Telegram bot not configured on server' })
  }

  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: '✅ Kairo is connected! You\'ll get a message here whenever a new lead matches your product.',
      }),
    })
    const data = await tgRes.json()

    if (!data.ok) {
      console.log('[telegram-test] error:', data.description)
      return res.status(400).json({ error: data.description || 'Telegram rejected the request. Check your Chat ID.' })
    }

    return res.status(200).json({ success: true })
  } catch (err) {
    console.error('[telegram-test] fatal:', err.message)
    return res.status(500).json({ error: 'Could not reach Telegram. Please try again.' })
  }
}
