import { useState, useEffect } from 'react'

// ScanTicker.js — Continuously sliding strip showing scans that found
// qualified leads, as a single sentence per entry: "Kairo found 6 leads
// for SubScan · scanned 3 min ago". Reads from scan_feed, written by
// /api/log-scan every time onboarding.js's main scan or share/[token].js's
// notify-me scan finds at least one qualified lead. Polls periodically
// rather than using a realtime subscription — simple, and "every ~20s" is
// plenty fresh for a proof-of-activity strip.
export default function ScanTicker() {
  const [scans, setScans] = useState([])
  // Forces a re-render every 30s so "scanned X ago" text keeps advancing
  // even when no new scan has come in to otherwise trigger a re-render.
  const [, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const res = await fetch('/api/scan-feed')
        if (!res.ok) return
        const data = await res.json()
        if (!cancelled) setScans(data.scans || [])
      } catch {
        // Silent — the ticker just stays empty/stale rather than showing
        // an error on the homepage over something this non-critical.
      }
    }
    load()
    const loadInterval = setInterval(load, 20000)
    const tickInterval = setInterval(() => setTick(t => t + 1), 30000)
    return () => { cancelled = true; clearInterval(loadInterval); clearInterval(tickInterval) }
  }, [])

  if (scans.length === 0) return null

  // Duplicated once so the CSS marquee animation can loop seamlessly at
  // the halfway point instead of jumping.
  const items = [...scans, ...scans]

  return (
    <div className="scan-ticker">
      <div className="scan-ticker-track">
        {items.map((s, i) => (
          <div key={`${s.id}-${i}`} className="scan-ticker-item">
            Kairo found <b>{s.lead_count} {s.lead_count === 1 ? 'lead' : 'leads'}</b> for {s.product_name} · scanned {timeAgo(s.created_at)}
          </div>
        ))}
      </div>
    </div>
  )
}

function timeAgo(isoString) {
  const seconds = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hr ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
