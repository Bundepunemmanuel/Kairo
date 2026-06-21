// telegram-webhook.js — Receives all messages sent to the Kairo bot.
// When a user sends /start, replies immediately with their Chat ID so they
// can paste it into Settings without needing a third-party bot.

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const botToken = process.env.TELEGRAM_BOT_TOKEN
  if (!botToken) {
    console.log('[telegram-webhook] TELEGRAM_BOT_TOKEN not configured')
    return res.status(200).json({ ok: true }) // Always 200 to Telegram, even on misconfig
  }

  try {
    const update = req.body
    const message = update?.message
    if (!message) return res.status(200).json({ ok: true })

    const chatId = message.chat?.id
    const text = (message.text || '').trim()

    if (!chatId) return res.status(200).json({ ok: true })

    let replyText = ''

    if (text === '/start') {
      replyText = `👋 Welcome to Kairo!\n\nYour Chat ID is:\n\`${chatId}\`\n\nCopy this number and paste it into Kairo → Settings → Notifications → Telegram Chat ID. Then tap "Test Telegram" to confirm it's connected.`
    } else if (text === '/help') {
      replyText = `Kairo sends you a message here whenever a new Reddit lead matches your product.\n\nYour Chat ID: \`${chatId}\`\n\nPaste it into Kairo Settings to get started.`
    } else {
      // For any other message, just remind them of their Chat ID — low-cost, helpful default
      replyText = `Your Kairo Chat ID is:\n\`${chatId}\`\n\nPaste this into Kairo → Settings → Notifications to receive lead alerts here.`
    }

    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: replyText,
        parse_mode: 'Markdown',
      }),
      signal: AbortSignal.timeout(8000),
    })

    return res.status(200).json({ ok: true })
  } catch (err) {
    console.error('[telegram-webhook] error:', err.message)
    // Still return 200 — Telegram will retry/disable the webhook on repeated non-200s
    return res.status(200).json({ ok: true })
  }
}
