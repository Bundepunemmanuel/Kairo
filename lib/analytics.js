// lib/analytics.js — Self-hosted replacement for PostHog. track() keeps
// the exact same signature every existing call site already uses
// (`track(event, properties)`, imported from pages/_app.js), so nothing
// elsewhere in the app needed to change — only where the implementation
// lives and where it writes to.
//
// Every event carries: a stable per-browser visitor ID, a simple
// mobile/tablet/desktop device type, and an owner flag — all computed
// client-side at track time, then written server-side (via
// /api/log-scan's eventType branch) to visitor_events.

const VISITOR_ID_KEY = 'kairo_visitor_id'
const OWNER_DEVICE_KEY = 'kairo_owner_device'

// Stable per-browser ID — created once, reused for the lifetime of this
// browser's localStorage. Not tied to any account; a logged-in user and
// an anonymous visitor on the same browser share the same visitor ID,
// which is exactly what lets the funnel follow someone across signing up.
export function getVisitorId() {
  if (typeof window === 'undefined') return null
  try {
    let id = localStorage.getItem(VISITOR_ID_KEY)
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : `v_${Date.now()}_${Math.random().toString(36).slice(2)}`)
      localStorage.setItem(VISITOR_ID_KEY, id)
    }
    return id
  } catch {
    // Private browsing / storage blocked — fall back to an in-memory id
    // for this page load only, rather than throwing.
    return `v_session_${Math.random().toString(36).slice(2)}`
  }
}

// ?kairo_owner=1 on ANY page marks this browser permanently (localStorage,
// not sessionStorage) so the admin analytics view can exclude it by
// default. Called once per route change from _app.js, same place the
// pageview itself fires, so it works regardless of which page the link
// with the param lands on.
export function markOwnerDeviceIfRequested() {
  if (typeof window === 'undefined') return
  try {
    const params = new URLSearchParams(window.location.search)
    if (params.get('kairo_owner') === '1') {
      localStorage.setItem(OWNER_DEVICE_KEY, '1')
    }
  } catch {
    // Storage blocked — the toggle just won't stick on this browser;
    // never worth throwing over.
  }
}

export function isOwnerDevice() {
  if (typeof window === 'undefined') return false
  try {
    return localStorage.getItem(OWNER_DEVICE_KEY) === '1'
  } catch {
    return false
  }
}

// Simple, deliberately non-fancy device detection — a UA check for
// mobile, then a width threshold to split tablet from desktop. Good
// enough for the admin device breakdown; not meant to be exact.
export function getDeviceType() {
  if (typeof window === 'undefined') return 'unknown'
  const ua = navigator.userAgent || ''
  const isMobileUA = /Mobi|Android(?!.*Tablet)|iPhone/i.test(ua)
  if (isMobileUA && window.innerWidth < 768) return 'mobile'
  const isTabletUA = /iPad|Tablet/i.test(ua)
  if (isTabletUA || (window.innerWidth >= 768 && window.innerWidth < 1024 && 'ontouchstart' in window)) return 'tablet'
  if (window.innerWidth < 768) return 'mobile'
  return 'desktop'
}

// track() — same signature PostHog's track() had. Fire-and-forget,
// silently no-ops on the server or on any failure, exactly like the old
// `if (!posthogReady) return` behavior: analytics should never be able to
// break or visibly slow down the app.
export function track(event, properties = {}) {
  if (typeof window === 'undefined') return
  try {
    const payload = {
      eventType: event,
      visitorId: getVisitorId(),
      deviceType: getDeviceType(),
      isOwner: isOwnerDevice(),
      path: window.location.pathname,
      properties,
    }
    fetch('/api/log-scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true, // lets the request survive a route change that fires right after
    }).catch(() => {})
  } catch {
    // Never let analytics throw into the caller.
  }
}
