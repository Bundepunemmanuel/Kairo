import { useState } from 'react'
import Link from 'next/link'
import Head from 'next/head'
import Nav from '../../components/Nav'
import Footer from '../../components/Footer'

const CHECKS = [
  "I've read this specific subreddit's rules, not just assumed they're the same as another sub.",
  'My account has genuine comment history in this community, not just a fresh account.',
  "I'm answering a real question, not starting a new thread just to mention my product.",
  "The product mention is genuinely the answer, not tacked on at the end.",
  "I'd be comfortable if a moderator read this and asked why I posted it.",
  "I'm not posting the same or similar comment across multiple subreddits within a short window.",
]

export default function Guide() {
  const [checked, setChecked] = useState({})
  const toggle = (i) => setChecked(c => ({ ...c, [i]: !c[i] }))
  const allChecked = CHECKS.every((_, i) => checked[i])

  return (
    <>
      <Head>
        <title>Reddit Marketing Without Getting Banned — A Pre-Post Checklist</title>
        <meta name="description" content="Most self-promotion posts don't get removed by accident. Here's the specific, avoidable reason most of them get filtered, and a checklist to run before you post." />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <Nav solid />

      <div className="guide-hero">
        <div className="guide-label">Reddit Marketing</div>
        <h1 className="guide-headline">Reddit marketing<br />without getting<br /><em>banned</em></h1>
        <p className="guide-dek">
          Most self-promotion posts don't get removed by accident. There's a specific, avoidable reason most of them get filtered or downvoted — and it's rarely the one founders assume.
        </p>
      </div>

      <div className="guide-body">
        <div className="guide-tldr">
          <strong>Short version:</strong> It's almost never "you mentioned a product." It's "you mentioned a product without first being a real participant in the community." Fix the second thing and the first stops being a problem.
        </div>

        <p>
          The common assumption is that Reddit just hates marketing. That's not quite right. Reddit hates being treated like a billboard by an account that showed up only to post a link. The exact same product mention, from an account with real comment history, in response to a genuine question, rarely gets removed. The mention isn't the problem. The context around it is.
        </p>

        <h2>What actually triggers removal</h2>
        <p>
          Subreddit auto-moderators and human moderators are both looking for the same pattern: low account activity, a post that reads like an announcement rather than a reply, and language that sounds like marketing copy rather than a person talking. Any one of these alone is often fine. All three together is what gets filtered.
        </p>

        <div className="guide-pullquote">
          "Reddit doesn't ban marketing. It bans accounts that showed up only to post one."
        </div>

        <h2>Run this checklist before you post</h2>
        <div>
          {CHECKS.map((c, i) => (
            <label key={i} className={`guide-check-item${checked[i] ? ' is-checked' : ''}`}>
              <input type="checkbox" checked={!!checked[i]} onChange={() => toggle(i)} />
              <span>{c}</span>
            </label>
          ))}
        </div>
        {allChecked && (
          <div className="guide-inline-cta">
            <p style={{ marginBottom: 0, color: 'var(--ink)' }}>
              All checked — you're in reasonable shape to post. This isn't a guarantee against removal, but it addresses the most common reasons it happens.
            </p>
          </div>
        )}

        <h2>If it still gets removed</h2>
        <p>
          Sometimes a post gets removed even when you've done everything right — a strict moderator, a subreddit rule you didn't know about, or a bad day for the auto-filter. This isn't necessarily a sign to change your approach; it happens even to genuine, well-intentioned posts. Don't argue with moderators in the thread. If it seems like a genuine misunderstanding, a polite modmail message explaining your intent occasionally gets a post reinstated — but treat that as a bonus, not an expectation.
        </p>

        <div className="guide-mid-cta">
          <p>Kairo scores posts for the same signals moderators look for — genuine question, real context, right timing.</p>
          <Link href="/onboarding">Run a free scan →</Link>
        </div>

        <h2>Related reading</h2>
        <div className="guide-links-out">
          <Link href="/guides/reddit-karma-builder">How to Build Reddit Karma</Link>
          <Link href="/guides/how-to-find-customers-on-reddit">How to Find Customers on Reddit</Link>
        </div>

        <div className="guide-final-cta">
          <p>Post with confidence. Kairo flags threads where a mention actually fits.</p>
          <Link href="/onboarding" className="btn-primary">Find My First Customer →</Link>
        </div>
      </div>

      <Footer />
    </>
  )
}
