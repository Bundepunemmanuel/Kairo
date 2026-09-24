import { useState, useEffect } from 'react'
import ScoreGauge from './ScoreGauge'

// ScanTicker.js — Continuously sliding strip on the homepage showing scans
// that found qualified leads (product name, lead count, top score). Reads
// from scan_feed, written by /api/log-scan every time onboarding.js's main
// scan or share/[token].js's notify-me scan finds at least one qualified
// lead. Polls periodically rather than using a realtime subscription —
// simple, and "every ~20s" is plenty fresh for a proof-of-activity strip.
export default function ScanTicker() {
  const [scans, setScans] = useState([])

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
    const interval = setInterval(load, 20000)
    return () => { cancelled = true; clearInterval(interval) }
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
            <span className="scan-ticker-name">{s.product_name}</span>
            <span className="scan-ticker-count">{s.lead_count} {s.lead_count === 1 ? 'lead' : 'leads'} found</span>
            <ScoreGauge score={s.top_score} size={22} />
          </div>
        ))}
      </div>
    </div>
  )
}
