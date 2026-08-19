import { useState } from 'react'
import Link from 'next/link'
import Head from 'next/head'
import Nav from '../../components/Nav'
import Footer from '../../components/Footer'

const STAGES = [
  { name: 'Found', tip: 'Someone describes your exact problem, publicly, right now. This is the easy part — the internet is full of people with problems.' },
  { name: 'Replied', tip: "Answer their actual question first. If your product is genuinely the answer, say so plainly — don't bury it, don't oversell it." },
  { name: 'Clicked', tip: "A click isn't a customer. Most people who click are still just checking if this is real. Your landing page has to answer 'is this actually for me' in about five seconds." },
  { name: 'Signed up', tip: "This is a trial, not a sale. Free signups are curiosity, not commitment — don't celebrate revenue that isn't there yet." },
  { name: 'Paid', tip: "This is the only step that actually proves the whole thing worked. Everything before it was necessary, but this is the one that pays your bills." },
]

export default function Guide() {
  const [step, setStep] = useState(0)

  return (
    <>
      <Head>
        <title>How to Find Your First Paying Customer (Not Just a Signup)</title>
        <meta name="description" content="Getting found is the easy part. Here's what actually happens between someone discovering your product and someone paying for it — and where most founders lose people." />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <Nav solid />

      <div className="guide-hero">
        <div className="guide-label">Conversion</div>
        <h1 className="guide-headline">How to find your<br />first <em>paying</em><br />customer</h1>
        <p className="guide-dek">
          Getting discovered is the easy part. Here's what actually happens between someone finding your product and someone paying for it — and exactly where most founders lose people along the way.
        </p>
      </div>

      <div className="guide-body">
        <div className="guide-tldr">
          <strong>Short version:</strong> A signup isn't a customer. Most founders celebrate too early at the "found" or "signed up" stage. The only stage that actually matters is the last one — click through the stages below to see where things usually break.
        </div>

        <p>
          There's a lot of advice about getting your first users, and most of it stops at "signup." But a free trial signup and a paying customer are very different events, and treating them the same is how founders end up with a hundred trial users and zero revenue, wondering what went wrong.
        </p>

        <h2>The five stages — click through each</h2>
        <div className="guide-filter-row">
          {STAGES.map((s, i) => (
            <button
              key={i}
              className={`guide-filter-btn${step === i ? ' is-active' : ''}`}
              onClick={() => setStep(i)}
            >
              {i + 1}. {s.name}
            </button>
          ))}
        </div>
        <div className="guide-channel-card">
          <h4>{STAGES[step].name}</h4>
          <p>{STAGES[step].tip}</p>
        </div>

        <div className="guide-pullquote">
          "A hundred trial signups and zero paying customers isn't traction. It's a funnel with a hole in it."
        </div>

        <h2>Where founders actually lose people</h2>
        <p>
          Almost never at "found." The internet has plenty of people with your exact problem. The real drop-off is usually between "signed up" and "paid" — someone tries the product, doesn't hit the moment where it clicks, and quietly disappears. That gap is worth more of your attention than finding more top-of-funnel leads.
        </p>

        <h2>What closes that gap</h2>
        <p>
          Usually it's not more leads — it's making the value obvious faster. If it takes someone ten minutes of setup before they see any benefit, most won't get there. The founders who convert trial signups into payments are usually the ones who shortened that gap, not the ones who found more signups to pour into the same leaky funnel.
        </p>

        <div className="guide-mid-cta">
          <p>Fill the top of the funnel while you fix the rest — Kairo finds the people already asking.</p>
          <Link href="/onboarding">Run a free scan →</Link>
        </div>

        <h2>Related reading</h2>
        <div className="guide-links-out">
          <Link href="/guides/how-to-get-your-first-100-users">How to Get Your First 100 Users</Link>
          <Link href="/guides/customer-acquisition-for-solo-founders">Customer Acquisition for Solo Founders</Link>
        </div>

        <div className="guide-final-cta">
          <p>Your next paying customer starts as a Reddit post. Kairo finds it.</p>
          <Link href="/onboarding" className="btn-primary">Find My First Customer →</Link>
        </div>
      </div>

      <Footer />
    </>
  )
}
