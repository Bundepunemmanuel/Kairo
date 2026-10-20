// sw.js — Service worker for browser push notifications.
// Runs in the background, separate from the main app — this is what
// lets a notification appear even if the Kairo tab isn't open.

self.addEventListener('push', (event) => {
  if (!event.data) return

  let payload
  try {
    payload = event.data.json()
  } catch (e) {
    payload = { title: 'Kairo', body: event.data.text() || 'New lead found' }
  }

  const title = payload.title || 'New lead found'
  const options = {
    body: payload.body || '',
    icon: '/logo.png',
    badge: '/logo.png',
    data: { url: payload.url || '/dashboard' },
    tag: payload.tag || undefined, // same tag replaces a prior notification instead of stacking, if provided
  }

  event.waitUntil(self.registration.showNotification(title, options))
})

// Clicking the notification focuses an existing Kairo tab if one's open,
// otherwise opens a new one at the relevant URL.
//
// Also pings send-push.js's mark-opened action with this subscription's
// endpoint, the only reliable signal anywhere in the app that a push was
// actually opened (not just sent) — see supabase-schema.sql's
// push_subscriptions.last_opened_at comment and index.ts's #6 sweep,
// which both depend entirely on this ping existing. Fire-and-forget: a
// failed ping here should never block focusing/opening the tab the
// person is actively trying to use right now.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const targetUrl = event.notification.data?.url || '/dashboard'

  event.waitUntil(
    (async () => {
      try {
        const registration = await self.registration
        const subscription = await registration.pushManager.getSubscription()
        if (subscription?.endpoint) {
          fetch('/api/send-push', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'mark-opened', endpoint: subscription.endpoint }),
          }).catch(() => {})
        }
      } catch (e) {
        // Non-fatal — worst case, #6's clock just doesn't get this one
        // click recorded; it never blocks the person from reaching the app.
      }

      const windowClients = await clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.navigate(targetUrl)
          return client.focus()
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl)
      }
    })()
  )
})
