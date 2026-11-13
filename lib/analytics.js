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
const SESSION_META_KEY = 'kairo_session_meta'
const SESSION_TIMEOUT_MS = 30 * 60 * 1000 // 30 minutes of inactivity starts a new session

// Cached in memory, set by _app.js's auth listener via
// setCurrentAccessToken() whenever the Supabase session changes — avoids
// every single track() call round-tripping to Supabase's local session
// store just to check whether someone's signed in. Read synchronously by
// track() below. Specific call sites (signup_completed, monitoring_activated)
// pass their own freshly-obtained token explicitly instead of relying on
// this cache, since there's a real race between a just-completed signUp()
// and this cache catching up via the separate onAuthStateChange listener.
let cachedAccessToken = null
export function setCurrentAccessToken(token) {
  cachedAccessToken = token || null
}

// Session boundary + first-touch attribution. A session persists across
// page loads until SESSION_TIMEOUT_MS of inactivity, at which point a new
// one starts and referrer/UTM/landing page are recaptured fresh —
// document.referrer only reflects the ACTUAL external referrer on that
// first page of a visit; by the second internal navigation it would just
// say the previous Kairo page, so capturing it once per session (not per
// event) is what keeps attribution meaningful.
function getSessionMeta() {
  if (typeof window === 'undefined') return {}
  try {
    const now = Date.now()
    let meta = null
    try { meta = JSON.parse(localStorage.getItem(SESSION_META_KEY) || 'null') } catch {}

    if (!meta || now - meta.lastSeen > SESSION_TIMEOUT_MS) {
      const params = new URLSearchParams(window.location.search)
      meta = {
        sessionId: crypto.randomUUID ? crypto.randomUUID() : `s_${now}_${Math.random().toString(36).slice(2)}`,
        referrer: document.referrer || null,
        utmSource: params.get('utm_source') || null,
        utmMedium: params.get('utm_medium') || null,
        utmCampaign: params.get('utm_campaign') || null,
        landingPage: window.location.pathname,
      }
    }
    meta.lastSeen = now
    localStorage.setItem(SESSION_META_KEY, JSON.stringify(meta))
    return meta
  } catch {
    return {}
  }
}

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

// Direct toggle, for a one-tap control in the admin panel — same
// permanent localStorage flag ?kairo_owner=1 sets, just reachable with a
// button instead of needing to remember/paste that URL param on every
// device you want excluded. Returns the new state so the caller can
// update its own UI without a second isOwnerDevice() read.
export function setOwnerDevice(value) {
  if (typeof window === 'undefined') return false
  try {
    if (value) localStorage.setItem(OWNER_DEVICE_KEY, '1')
    else localStorage.removeItem(OWNER_DEVICE_KEY)
    return value
  } catch {
    return isOwnerDevice()
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

// Same fields track() attaches to every /api/log-scan call, exposed
// directly for the rare caller (currently just onboarding.js's
// /api/score request) that needs to attach visitor/session/attribution
// data to a DIFFERENT endpoint's request body — e.g. so score.js can log
// scan_completed itself, server-side, in the same request that computed
// the real result, rather than depending on a separate track() call
// afterward.
export function getTrackingFields({ accessToken } = {}) {
  if (typeof window === 'undefined') return {}
  const session = getSessionMeta()
  return {
    visitorId: getVisitorId(),
    deviceType: getDeviceType(),
    isOwner: isOwnerDevice(),
    path: window.location.pathname,
    sessionId: session.sessionId || null,
    referrer: session.referrer || null,
    utmSource: session.utmSource || null,
    utmMedium: session.utmMedium || null,
    utmCampaign: session.utmCampaign || null,
    landingPage: session.landingPage || null,
    accessToken: accessToken || cachedAccessToken || null,
  }
}

// track() — same event/properties signature every existing call site
// already uses, so nothing elsewhere needed to change for this. The new
// third argument is optional and additive: { accessToken } lets a caller
// that JUST obtained a fresh token (right after signUp() or a
// product_profiles write) pass it explicitly, bypassing the cached-token
// race described above — used by signup_completed and
// monitoring_activated specifically, since those are the events
// log-scan.js requires real verification for before accepting them as
// confirmed rather than merely claimed.
//
// Still fire-and-forget, still silently no-ops on the server or on any
// failure — analytics should never be able to break or visibly slow down
// the app.
export function track(event, properties = {}, { accessToken } = {}) {
  if (typeof window === 'undefined') return
  try {
    const payload = {
      eventType: event,
      properties,
      ...getTrackingFields({ accessToken }),
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
