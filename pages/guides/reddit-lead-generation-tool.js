import Link from 'next/link'
import Head from 'next/head'
import Nav from '../../components/Nav'
import Footer from '../../components/Footer'

export default function Guide() {
  return (
    <>
      <Head>
        <title>Reddit Lead Generation Tool — How Kairo Finds Buyers on Reddit</title>
        <meta name="description" content="A Reddit lead generation tool that scans subreddits for buying intent, scores each post, and drafts your reply. See how it actually works, with real examples." />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <Nav solid />

      <div className="guide-hero">
        <div className="guide-label">Reddit Lead Generation</div>
        <h1 className="guide-headline">A Reddit lead<br /><em>generation tool</em><br />that actually reads the room</h1>
        <p className="guide-dek">
          Most "monitoring" tools just match keywords and dump every result in your inbox. Here's what a tool built specifically to find buyers — not just mentions — actually does differently.
        </p>
      </div>

      <div className="guide-body">
        <div className="guide-tldr">
          <strong>Short version:</strong> Keyword monitoring tells you a word appeared. Lead generation tells you someone's ready to buy. The difference is whether the tool understands intent, not just matches — try the example below.
        </div>

        <p>
          Type "Reddit lead generation tool" into Google and you'll mostly find keyword monitors — set up a rule, get an alert every time your term shows up somewhere on Reddit. That's useful for brand mentions. It's noisy and slow for finding customers, because a keyword match doesn't tell you whether someone's asking for a recommendation or just mentioning the word in passing.
        </p>

        <h2>What "lead generation" actually requires</h2>
        <p>
          A post matching your keyword and a post where someone's ready to buy are very different things. The first is noise. The second is the entire point. A real lead generation tool needs to tell them apart — reading not just <em>whether</em> a word appears, but <em>how</em> it's used: is this a question, a complaint, a recommendation request, or just background chatter.
        </p>

        <h2>See it in action</h2>
        <p>This is a real screenshot of Kairo's dashboard — actual leads, actual scores, not a mockup:</p>

        <img
          src="/mockup.webp"
          alt="Kairo dashboard showing real Reddit leads with intent scores, sorted by score, with View Draft Reply and Open in Reddit actions"
          style={{ width: '100%', maxWidth: '520px', display: 'block', margin: '0 auto 12px', borderRadius: '12px' }}
        />
        <p style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-light)', textAlign: 'center', marginTop: '-4px' }}>
          Live dashboard — new leads sorted by intent score, with a one-click draft reply for each.
        </p>

        <div className="guide-pullquote">
          "A keyword match tells you a word appeared. A score tells you whether it's worth your time."
        </div>

        <h2>What actually gets scored</h2>
        <p>Rather than a black box, here's roughly what goes into a score — in plain terms, not exact internal weighting:</p>
        <ol className="guide-checklist">
          <li><span className="guide-checklist-num">1</span><span><strong>Question vs. statement:</strong> "what tool do you use for X" scores very differently than "I use X for this."</span></li>
          <li><span className="guide-checklist-num">2</span><span><strong>Frustration language:</strong> complaints and "there has to be a better way" phrasing signal passive demand worth nurturing.</span></li>
          <li><span className="guide-checklist-num">3</span><span><strong>Freshness:</strong> a 5-minute-old post is worth replying to fast; a 3-day-old thread has likely already been answered.</span></li>
          <li><span className="guide-checklist-num">4</span><span><strong>Subreddit fit:</strong> the same phrase in a hyper-relevant niche sub scores higher than in a huge general one.</span></li>
        </ol>

        <div className="guide-mid-cta">
          <p>See what this finds in your own subreddits — not a demo, a real scan.</p>
          <Link href="/onboarding">Run a free scan →</Link>
        </div>

        <h2>Where this fits into your week</h2>
        <p>
          You don't need to babysit it. Kairo scans on a fixed interval, scores what it finds, and surfaces only what clears the bar — the rest never reaches you. That's the actual point of a lead generation tool over a keyword monitor: fewer, better results, not more noise to sort through yourself.
        </p>

        <h2>Related reading</h2>
        <div className="guide-links-out">
          <Link href="/guides/reddit-intent-scoring">How Reddit Intent Scoring Works</Link>
          <Link href="/guides/how-to-find-customers-on-reddit">How to Find Customers on Reddit</Link>
        </div>

        <div className="guide-final-cta">
          <p>Your next customer posted a few minutes ago. See if Kairo would have caught it.</p>
          <Link href="/onboarding" className="btn-primary">Find My First Customer →</Link>
        </div>
      </div>

      <Footer />
    </>
  )
}
