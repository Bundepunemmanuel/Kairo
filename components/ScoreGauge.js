// ScoreGauge.js — Small radial signal-strength ring, replacing the plain
// "Score: 94.0" text that used to sit on every lead card. This is the
// single highest-impact piece of the "signal, not vibe" pass: the whole
// product's job is measuring signal strength in noise, and up to now
// nothing in the UI actually looked like that — it was just a number.
// One shared component so dashboard.js, archive.js, onboarding.js, and
// share/[token].js can't quietly drift into four different renderings of
// the same idea.

export default function ScoreGauge({ score, size = 34 }) {
  const value = Number(score) || 0
  const pct = Math.max(0, Math.min(100, value)) / 100
  const strokeWidth = 3
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const offset = circumference * (1 - pct)

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: 'block', transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="rgba(192,88,74,0.15)" strokeWidth={strokeWidth} />
        <circle
          cx={size / 2} cy={size / 2} r={radius} fill="none"
          stroke="#c0584a" strokeWidth={strokeWidth} strokeLinecap="round"
          strokeDasharray={circumference} strokeDashoffset={offset}
        />
      </svg>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.82rem', fontWeight: 600, color: 'var(--rust)' }}>
        {value.toFixed(1)}
      </span>
    </span>
  )
}
