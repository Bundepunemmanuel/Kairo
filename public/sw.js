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
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const targetUrl = event.notification.data?.url || '/dashboard'

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.navigate(targetUrl)
          return client.focus()
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl)
      }
    })
  )
})
