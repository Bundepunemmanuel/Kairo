import ScoreGauge from './ScoreGauge'

// DesktopMockup.js — Replaces the old phone-screenshot hero image with a
// wide browser-frame mockup, built as real markup rather than a static
// image. Uses the actual ScoreGauge component and the app's real CSS
// variables (--rust, --ink, --cream, --font-display, --font-mono) so it
// can never visually drift from what the real dashboard looks like.
// Content is illustrative — styled identically to a real lead card, but
// never a real captured post, matching the same standard already used for
// the OG image's fallback card.
export default function DesktopMockup() {
  const leads = [
    {
      subreddit: 'SaaS',
      arrived: '16h ago',
      title: 'Finding clients',
      body: "How do you find clients that may really be interested in what you built? I'm stuck at this point...",
      score: 94,
    },
    {
      subreddit: 'indiehackers',
      arrived: '1d ago',
      title: 'How do u find ur first client',
      body: "It's been 1 month now that I have launched my saas but I have a hard time finding my first client...",
      score: 91,
    },
  ]

  return (
    <div className="desktop-mockup">
      <div className="desktop-mockup-chrome">
        <span className="desktop-mockup-dot" style={{ background: '#e0a598' }} />
        <span className="desktop-mockup-dot" style={{ background: '#ecd8a0' }} />
        <span className="desktop-mockup-dot" style={{ background: '#a9c496' }} />
        <div className="desktop-mockup-url">🔒 kairo-omega.vercel.app/dashboard</div>
      </div>

      <div className="desktop-mockup-nav">
        <div className="desktop-mockup-brand">Kairo</div>
        <div className="desktop-mockup-navlinks">
          <span className="active">Dashboard</span>
          <span>Archive</span>
          <span>Settings</span>
          <span>Billing</span>
        </div>
      </div>

      <div className="desktop-mockup-stats">
        <div>
          <div className="desktop-mockup-stats-label">SCANNING FOR</div>
          <div className="desktop-mockup-stats-name">SubScan</div>
        </div>
        <div className="desktop-mockup-stats-nums">
          <div><span>749</span><small>ACTIVE LEADS</small></div>
          <div><span>67.0</span><small>AVG SCORE</small></div>
          <div><span>22/∞</span><small>TODAY'S QUOTA</small></div>
        </div>
      </div>

      <div className="desktop-mockup-cards">
        {leads.map((lead, i) => (
          <div key={i} className="desktop-mockup-card">
            <div className="desktop-mockup-card-top">
              <span className="desktop-mockup-badge">r/{lead.subreddit}</span>
              <span className="desktop-mockup-arrived">Arrived {lead.arrived}</span>
            </div>
            <div className="desktop-mockup-card-title">{lead.title}</div>
            <p className="desktop-mockup-card-body">{lead.body}</p>
            <div className="desktop-mockup-card-bottom">
              <div className="desktop-mockup-card-actions">
                <span className="desktop-mockup-btn-primary">✍️ View Draft Reply</span>
                <span className="desktop-mockup-btn-secondary">Open in Reddit ↗</span>
              </div>
              <ScoreGauge score={lead.score} size={26} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
