import { useState } from 'react'
import Link from 'next/link'
import Head from 'next/head'
import Nav from '../../components/Nav'
import Footer from '../../components/Footer'

const TOOLS = [
  {
    name: 'F5Bot', price: 'Free', intent: 'None (keyword match only)', coverage: 'Reddit, Hacker News, Lobsters',
    detail: "Genuinely free, no card required. Emails you when a keyword appears — that's the entire feature set. No scoring, no reply drafting, no dashboard. Great as a smoke detector, not a lead-gen workflow.",
  },
  {
    name: 'Syften', price: 'From ~$20/mo', intent: 'Basic (AI filtering on higher tiers)', coverage: 'Reddit, HN, Twitter, Indie Hackers',
    detail: 'Boolean/keyword filters with sub-1-minute alerts. AI filtering exists but is gated to higher-priced tiers. No built-in reply drafting — you still write every response yourself.',
  },
  {
    name: 'Redreach', price: 'Paid, tiered', intent: 'Yes — AI relevance scoring + reply drafts', coverage: 'Reddit-focused',
    detail: "The closest feature match to Kairo based on public descriptions — AI scoring, drafted replies, ROI tracking. Worth a direct look if you're comparing feature-for-feature, not just price.",
  },
  {
    name: 'GummySearch', price: 'Discontinued for new users', intent: 'N/A', coverage: 'Reddit only',
    detail: "Shut down for new signups in November 2025 after losing its Reddit Data API license. Existing users keep access until November 30, 2026, then all data is deleted. Not a viable option if you're starting today.",
  },
]

export default function Guide() {
  const [open, setOpen] = useState(null)

  return (
    <>
      <Head>
        <title>Reddit Lead Gen Tools Compared (2026) — Kairo vs. F5Bot, Syften, Redreach</title>
        <meta name="description" content="An honest comparison of Reddit lead generation and monitoring tools — Kairo, F5Bot, Syften, Redreach — pricing, intent scoring, and what GummySearch's shutdown means for you." />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <Nav solid />

      <div className="guide-hero">
        <div className="guide-label">Comparison</div>
        <h1 className="guide-headline">Reddit lead gen<br />tools, <em>compared</em><br />honestly</h1>
        <p className="guide-dek">
          GummySearch — once the default Reddit research tool — stopped taking new customers in November 2025 after losing its Reddit API license. Here's an honest look at what's actually worth using now.
        </p>
      </div>

      <div className="guide-body">
        <div className="guide-tldr">
          <strong>Short version:</strong> F5Bot is free and fine if you can read every alert yourself. Syften and Redreach cost money and add filtering. Kairo adds intent scoring and drafts the reply for you. GummySearch is no longer an option for new users.
        </div>

        <p>
          If you searched for a GummySearch alternative, here's the actual reason it's not showing up as an option: Reddit tightened API access, GummySearch couldn't get a commercial license, and the team wound down new signups. It's not a ranking or quality issue — the tool simply can't onboard new customers anymore. That's left a real gap, and a handful of tools have stepped in with different tradeoffs.
        </p>

        <h2>The comparison</h2>
        <table className="guide-compare-table">
          <thead>
            <tr>
              <th>Tool</th>
              <th className="is-kairo">Kairo</th>
              <th>F5Bot</th>
              <th>Syften</th>
              <th>Redreach</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Price</td>
              <td className="is-kairo">Free to start</td>
              <td>Free</td>
              <td>~$20+/mo</td>
              <td>Paid, tiered</td>
            </tr>
            <tr>
              <td>Intent scoring</td>
              <td className="is-kairo">Yes, active vs. passive</td>
              <td>No</td>
              <td>Basic, higher tiers</td>
              <td>Yes</td>
            </tr>
            <tr>
              <td>Drafts your reply</td>
              <td className="is-kairo">Yes</td>
              <td>No</td>
              <td>No</td>
              <td>Yes</td>
            </tr>
            <tr>
              <td>Coverage</td>
              <td className="is-kairo">Reddit-focused</td>
              <td>Reddit, HN, Lobsters</td>
              <td>Reddit, HN, Twitter, IH</td>
              <td>Reddit-focused</td>
            </tr>
          </tbody>
        </table>

        <div className="guide-pullquote">
          "F5Bot tells you a keyword appeared. The question that matters is whether it's worth your time — that's the part a keyword alert can't answer."
        </div>

        <h2>Tap each tool for the honest detail</h2>
        {TOOLS.map((t, i) => (
          <div className="guide-accordion-item" key={t.name}>
            <button className="guide-accordion-header" onClick={() => setOpen(open === i ? null : i)}>
              <span>{t.name} — {t.price}</span>
              <span>{open === i ? '−' : '+'}</span>
            </button>
            {open === i && (
              <div className="guide-accordion-body">
                <p style={{ marginBottom: '8px' }}><strong>Intent scoring:</strong> {t.intent} · <strong>Coverage:</strong> {t.coverage}</p>
                <p>{t.detail}</p>
              </div>
            )}
          </div>
        ))}

        <h2>Which one is actually right for you</h2>
        <p>
          If your budget is genuinely zero and you're willing to read every alert yourself, F5Bot costs nothing and does its one job reliably. If you want broader coverage beyond Reddit, Syften is worth a look. If you specifically want the scoring and drafting handled for you — the two most time-consuming parts of doing this manually — that's the gap Kairo was built to fill.
        </p>

        <div className="guide-mid-cta">
          <p>See what Kairo finds and drafts for your own subreddits, free.</p>
          <Link href="/onboarding">Run a free scan →</Link>
        </div>

        <h2>Related reading</h2>
        <div className="guide-links-out">
          <Link href="/guides/reddit-lead-generation-tool">Reddit Lead Generation Tool</Link>
          <Link href="/guides/reddit-intent-scoring">How Reddit Intent Scoring Works</Link>
        </div>

        <div className="guide-final-cta">
          <p>Stop reading every alert yourself. Let Kairo score them first.</p>
          <Link href="/onboarding" className="btn-primary">Find My First Customer →</Link>
        </div>
      </div>

      <Footer />
    </>
  )
}
