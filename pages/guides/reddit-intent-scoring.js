import { useState } from 'react'
import Link from 'next/link'
import Head from 'next/head'
import Nav from '../../components/Nav'
import Footer from '../../components/Footer'

const POSTS = [
  {
    title: 'What tool do you use to find leads on Reddit? Tired of doing this by hand.',
    demand: 'Active', score: '91.0',
    signals: ['Direct question ("what tool do you use")', 'Explicit pain point named ("by hand")', 'No replies yet — first-mover window'],
    replyTone: 'Answer directly and fast. This person is actively comparing options right now.',
  },
  {
    title: "I feel like I'm shouting into the void trying to get people to notice my product",
    demand: 'Passive', score: '64.0',
    signals: ['Frustration language, no direct ask', "Doesn't know a solution category exists yet", 'Needs empathy before any product mention'],
    replyTone: "Validate the frustration first. Don't pitch in the first sentence — lead with something genuinely useful.",
  },
  {
    title: 'Just hit 50 upvotes on my first post here, feeling good today',
    demand: 'None', score: '8.0',
    signals: ['No pain point, no question, no buying language', 'Purely social/celebratory post', 'Correctly filtered out — never reaches your leads list'],
    replyTone: 'Not a lead. This is exactly the kind of post a keyword-only tool would still flag — intent scoring skips it.',
  },
]

export default function Guide() {
  const [i, setI] = useState(0)
  const post = POSTS[i]

  return (
    <>
      <Head>
        <title>Reddit Intent Scoring — How Kairo Reads Buying Signals</title>
        <meta name="description" content="How Kairo scores Reddit posts for buying intent — active vs. passive demand, what signals matter, and why keyword matching alone isn't enough." />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <Nav solid />

      <div className="guide-hero">
        <div className="guide-label">Intent Scoring</div>
        <h1 className="guide-headline">How Kairo reads<br />a thread and<br /><em>understands intent</em></h1>
        <p className="guide-dek">
          Two posts can contain the exact same keyword and mean completely different things. Here's how intent scoring tells them apart — try it yourself below.
        </p>
      </div>

      <div className="guide-body">
        <div className="guide-tldr">
          <strong>Short version:</strong> Keyword matching sees words. Intent scoring reads phrasing, sentiment, and context to tell an active buyer apart from a passive complainer apart from someone just chatting.
        </div>

        <p>
          "My product for X" and "does anyone know a good tool for X" can both contain your exact target keyword. A keyword monitor treats them identically — both trigger the same alert. But one is a competitor mention and the other is someone actively shopping. Intent scoring exists to catch that difference automatically, instead of you reading through every match by hand to figure out which ones matter.
        </p>

        <h2>Try it: click a post to see how it's read</h2>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '18px' }}>
          {POSTS.map((p, idx) => (
            <button
              key={idx}
              onClick={() => setI(idx)}
              style={{
                textAlign: 'left',
                padding: '14px 16px',
                borderRadius: '10px',
                border: idx === i ? '1.5px solid var(--rust)' : '1px solid var(--border)',
                background: idx === i ? 'var(--rust-muted)' : 'var(--white)',
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontSize: 'var(--text-sm)',
                color: 'var(--ink)',
              }}
            >
              "{p.title}"
            </button>
          ))}
        </div>

        <div className="dash-lead-card">
          <div className="dash-lead-top">
            <span className="dash-lead-active">
              {post.demand === 'Active' ? '🔴 ACTIVE DEMAND' : post.demand === 'Passive' ? '🟡 PASSIVE DEMAND' : '⚪ NOT A LEAD'}
            </span>
            <span className="dash-lead-score">{post.score}</span>
          </div>
          <p className="dash-lead-body" style={{ marginBottom: '12px' }}>
            <strong>Signals detected:</strong>
          </p>
          <ul style={{ marginBottom: '12px', paddingLeft: '18px' }}>
            {post.signals.map((s, idx) => (
              <li key={idx} style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-mid)', marginBottom: '6px' }}>{s}</li>
            ))}
          </ul>
          <div className="dash-lead-reason">
            <span className="dash-reason-label">Reply approach:</span>
            <span>{post.replyTone}</span>
          </div>
        </div>
        <p style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-light)', marginTop: '12px' }}>
          Illustrative examples — same scoring logic and card format used for real, live posts in your dashboard.
        </p>

        <div className="guide-pullquote">
          "Same keyword, same subreddit, completely different intent. That difference is the entire job."
        </div>

        <h2>Active vs. passive — why the label changes your reply</h2>
        <p>
          <strong>Active demand</strong> is someone mid-search, comparing options right now — reply fast, answer directly, the window is usually under an hour before someone else answers first. <strong>Passive demand</strong> is someone venting a frustration without knowing a solution exists yet — there's no rush, but the reply needs empathy before any product mention, or it reads as tone-deaf.
        </p>

        <h2>What intent scoring isn't</h2>
        <p>
          It's not a guarantee — no scoring system is perfect, and occasionally a post gets mis-read either direction. What it is: a filter that removes the overwhelming majority of noise (celebratory posts, off-topic chatter, unrelated keyword matches) so what reaches you is worth your actual time, instead of a raw firehose of every keyword hit.
        </p>

        <div className="guide-mid-cta">
          <p>See real intent scores on real posts from your own subreddits.</p>
          <Link href="/onboarding">Run a free scan →</Link>
        </div>

        <h2>Related reading</h2>
        <div className="guide-links-out">
          <Link href="/guides/reddit-lead-generation-tool">Reddit Lead Generation Tool</Link>
          <Link href="/guides/how-to-find-customers-on-reddit">How to Find Customers on Reddit</Link>
        </div>

        <div className="guide-final-cta">
          <p>Stop reading every match yourself. Let intent scoring do the first pass.</p>
          <Link href="/onboarding" className="btn-primary">Find My First Customer →</Link>
        </div>
      </div>

      <Footer />
    </>
  )
}
