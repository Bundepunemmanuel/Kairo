// push.js — Shared browser push-subscription helpers.
//
// Originally lived only in onboarding.js's zero-results capture. Pulled out
// here once the share page needed the exact same permission → register →
// subscribe flow for its own "get notified" form — two independent copies
// of VAPID-key handling and iOS detection is exactly the kind of thing
// that quietly drifts out of sync later. settings.js has its own version
// of this same flow (predates this file) and hasn't been touched, so it's
// not yet fully consolidated — worth folding in if it's ever revisited.

export function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  return Uint8Array.from([...rawData].map(char => char.charCodeAt(0)))
}

export const isIOS = () =>
  typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream

export const isStandalone = () =>
  typeof window !== 'undefined' &&
  (window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches)

export const pushIsSupported = () =>
  typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window

// iOS Safari only supports push once the site's been added to the home
// screen and reopened from there — pushIsSupported() alone doesn't
// capture that, so callers should show home-screen instructions instead
// of the permission-request button when this is true.
export const needsHomeScreenInstructions = () => isIOS() && !isStandalone()

// Requests permission, registers the service worker, and subscribes.
// Throws on denial or failure — callers decide how to surface that.
export async function subscribeToPush() {
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    const err = new Error('Notification permission was denied. You can enable it later in your browser settings.')
    err.code = 'permission_denied'
    throw err
  }
  const registration = await navigator.serviceWorker.register('/sw.js')
  await navigator.serviceWorker.ready
  const sub = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(process.env.NEXT_PUBLIC_VAPID_KEY),
  })
  return sub.toJSON()
}
