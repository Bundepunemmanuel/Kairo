import { useState } from 'react'
import Link from 'next/link'
import Head from 'next/head'
import Nav from '../../components/Nav'
import Footer from '../../components/Footer'

const CHANNELS = [
  { name: 'Reddit replies', time: '30 min', desc: 'Reply to buying-intent threads in relevant subreddits. Slow to start, compounds as trust builds.', fits: ['low', 'mid', 'high'] },
  { name: 'Cold outreach', time: '1-2 hrs', desc: 'Find people who publicly complained about your exact problem, reply with a specific answer.', fits: ['mid', 'high'] },
  { name: 'Community Q&A', time: '30 min', desc: "Answer questions in forums/Discords where your customers already ask them, no pitch for two weeks.", fits: ['low', 'mid', 'high'] },
  { name: 'Content/SEO pages', time: '3-5 hrs', desc: 'Write pages that answer real search queries your customers type into Google. Slow compounding return.', fits: ['high'] },
  { name: 'Indie Hacker communities', time: '30 min', desc: 'Get feedback and visibility among other founders — rarely direct customers, but useful early on.', fits: ['low', 'mid', 'high'] },
]

const LABELS = { low: 'Under 1 hr/week', mid: '3-5 hrs/week', high: '10+ hrs/week' }

export default function Guide() {
  const [filter, setFilter] = useState('low')

  return (
    <>
      <Head>
        <title>Customer Acquisition for Solo Founders (By Time You Actually Have)</title>
        <meta name="description" content="Most customer acquisition advice assumes a team and a budget. Here's what actually fits when you're one person with an hour a week, or ten." />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <Nav solid />

      <div className="guide-hero">
        <div className="guide-label">Customer Acquisition</div>
        <h1 className="guide-headline">Customer acquisition<br />for <em>solo founders</em><br />with real constraints</h1>
        <p className="guide-dek">
          Most acquisition advice assumes a marketing team and a budget. You have neither. Here's what actually fits depending on how much time you genuinely have this week.
        </p>
      </div>

      <div className="guide-body">
        <div className="guide-tldr">
          <strong>Short version:</strong> Time, not budget, is the real constraint for a solo founder. Pick channels that fit the hours you actually have — filter below to see what's realistic for your week.
        </div>

        <p>
          Most "customer acquisition" content is written for a marketing team with a budget and headcount to spread across channels. You're one person, and every hour spent on acquisition is an hour not spent building. The question isn't "what's the best channel" — it's "what's the best channel for the two hours I actually have this week."
        </p>

        <h2>Filter by time you have this week</h2>
        <div className="guide-filter-row">
          {Object.entries(LABELS).map(([key, label]) => (
            <button
              key={key}
              className={`guide-filter-btn${filter === key ? ' is-active' : ''}`}
              onClick={() => setFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>

        {CHANNELS.filter(c => c.fits.includes(filter)).map(c => (
          <div className="guide-channel-card" key={c.name}>
            <span className="guide-channel-time">~{c.time}/session</span>
            <h4>{c.name}</h4>
            <p>{c.desc}</p>
          </div>
        ))}

        <div className="guide-pullquote">
          "The question isn't the best channel. It's the best channel for the two hours you actually have this week."
        </div>

        <h2>Why time matters more than budget here</h2>
        <p>
          A $500 ad budget with no data behind it usually just teaches you your targeting was wrong. Time spent genuinely engaging where your customers already are compounds — the fifteenth Reddit reply converts better than the first, because trust builds. Budget can't buy that shortcut; only consistent time can.
        </p>

        <h2>What changes as you scale up hours</h2>
        <p>
          At under an hour a week, stick to one channel and go deep rather than spreading thin across three. Once you're at 3-5 hours, adding a second channel starts to make sense — Reddit plus community Q&A tends to compound well together since they overlap. Past 10 hours, content/SEO pages start paying off, but they're a bad first move with limited time since the payoff is slow and compounds only after several pages exist.
        </p>

        <div className="guide-mid-cta">
          <p>Automate the Reddit half of this so your hours go further.</p>
          <Link href="/onboarding">Run a free scan →</Link>
        </div>

        <h2>Related reading</h2>
        <div className="guide-links-out">
          <Link href="/guides/how-to-get-your-first-100-users">How to Get Your First 100 Users</Link>
          <Link href="/guides/how-to-find-customers-on-reddit">How to Find Customers on Reddit</Link>
        </div>

        <div className="guide-final-cta">
          <p>However many hours you have, make the Reddit ones count.</p>
          <Link href="/onboarding" className="btn-primary">Find My First Customer →</Link>
        </div>
      </div>

      <Footer />
    </>
  )
}
