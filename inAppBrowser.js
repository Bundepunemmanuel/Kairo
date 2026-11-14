// Detects known in-app "mini browsers" (X/Twitter, Instagram, TikTok —
// plus a couple of other common ones) that break things here in two
// separate, confirmed ways:
//   1. The notify-me form on the share page doesn't work when opened
//      inside X's own in-app browser (confirmed in production).
//   2. Google's OAuth policy separately and deliberately blocks
//      "Sign in with Google" from loading inside these same in-app
//      browsers (its own disallowed_useragent error) — this is Google's
//      policy, not something we can work around with a different OAuth
//      call.
// One detector covers both, rather than building it twice.
const IN_APP_BROWSER_PATTERNS = [
  { name: 'X', re: /Twitter/i }, // the X app's webview UA still says "Twitter" post-rebrand
  { name: 'Instagram', re: /Instagram/i },
  { name: 'TikTok', re: /BytedanceWebview|TikTok|musical_ly/i },
  { name: 'Facebook', re: /FBAN|FBAV/i },
  { name: 'LinkedIn', re: /LinkedInApp/i },
]

function resolveUserAgent(userAgent) {
  if (userAgent) return userAgent
  if (typeof navigator !== 'undefined') return navigator.userAgent || ''
  return ''
}

export function isInAppBrowser(userAgent) {
  const ua = resolveUserAgent(userAgent)
  if (!ua) return false
  return IN_APP_BROWSER_PATTERNS.some(({ re }) => re.test(ua))
}

// Human-readable name for the detected app, used in the "open in your
// browser" copy. Falls back to a generic label if nothing named matched
// (isInAppBrowser should be checked first either way).
export function inAppBrowserName(userAgent) {
  const ua = resolveUserAgent(userAgent)
  const match = IN_APP_BROWSER_PATTERNS.find(({ re }) => re.test(ua))
  return match ? match.name : 'this app'
}
