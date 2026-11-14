import { useState } from 'react'

// Shown instead of a form/button that's confirmed broken inside an
// in-app browser (see lib/inAppBrowser.js for which apps and why).
// window.open(href, '_blank') is the one trick that actually escapes
// some Android in-app browsers into the real default browser; iOS
// in-app browsers have no equivalent from a web page, which is why the
// copy below also explains the manual "..." menu route and offers a
// copy-link fallback either way.
export default function OpenInBrowserPrompt({ appName, label }) {
  const [copied, setCopied] = useState(false)

  const handleOpen = () => {
    if (typeof window === 'undefined') return
    window.open(window.location.href, '_blank')
  }

  const handleCopyLink = () => {
    if (typeof window === 'undefined') return
    navigator.clipboard?.writeText(window.location.href)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="in-app-browser-prompt">
      <p className="email-gate-note" style={{ marginBottom: 10 }}>
        {appName ? `${appName}'s` : 'This app\u2019s'} built-in browser blocks {label || 'this'} — tap below to open this page in your regular browser (Safari, Chrome) instead, or use the "⋯" menu and choose "Open in Browser."
      </p>
      <button className="ob-scan-btn" style={{ width: '100%', textAlign: 'center' }} onClick={handleOpen}>
        Open in your browser →
      </button>
      <button
        className="lead-btn-secondary"
        style={{ width: '100%', textAlign: 'center', marginTop: 8 }}
        onClick={handleCopyLink}
      >
        {copied ? 'Link copied!' : 'Copy link instead'}
      </button>
    </div>
  )
}
