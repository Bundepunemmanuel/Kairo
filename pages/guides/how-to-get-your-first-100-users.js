import Link from 'next/link'
import Head from 'next/head'
import Nav from '../../components/Nav'
import Footer from '../../components/Footer'

export default function Guide() {
  return (
    <>
      <Head>
        <title>How to Get Your First 100 Users (Without Ads) — Kairo</title>
        <meta name="description" content="No ad budget, no audience, no idea where to start. Here's the actual channel-by-channel breakdown for getting your first 100 users as a solo founder." />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <Nav />

      <div className="guide-hero">
        <div className="guide-label">Distribution</div>
        <h1 className="guide-headline">How to get your<br /><em>first 100 users</em><br />without ads</h1>
        <p className="guide-dek">
          You shipped the product. Nobody's coming. Here's what actually gets your first 100 users when you have no budget, no audience, and no idea where to start.
        </p>
      </div>

      <div className="guide-body">
        <div className="guide-tldr">
          <strong>Short version:</strong> Your first 100 users don't come from ads or an announcement post. They come from finding people who already have your problem, in the places they're already complaining about it, before you've spent a dollar. Reddit is usually the fastest of those places to start.
        </div>

        <p>
          Most founders spend three months building and three days thinking about distribution. That ratio is backwards, and it's the reason so many good products never find anyone. Paid ads don't work when you have no data and no budget — you'll burn $500 finding out your targeting was wrong. Your first 100 users come from finding the people who already have the problem you solve, in the places they already hang out.
        </p>

        <h2>Why your first 100 are different from your next 1,000</h2>
        <p>
          Your first 100 users aren't found through marketing. They're found through search — you searching for them, not the other way around. They're already out there, mid-conversation, already frustrated, already asking "does anyone know a tool for this." Your job isn't to announce your product. It's to notice that conversation and show up in it.
        </p>

        <div className="guide-pullquote">
          "Your job isn't to announce your product. It's to notice a conversation that's already happening and show up in it."
        </div>

        <h2>The channels that actually work</h2>

        <h3>Reddit</h3>
        <p>
          There is a subreddit for almost any problem your product solves, and inside it people post buying-intent questions every single day — "what do you use for X," "is there a tool that does Y," "I'm so tired of doing this manually." Most founders search these manually for a week, get tired, and stop. The ones who keep at it find customers.
        </p>

        <div className="guide-example">
          <div className="guide-example-label">A hypothetical, to make this concrete</div>
          <p style={{ marginBottom: '10px', fontSize: 'var(--text-sm)' }}>Someone posts in r/SaaS: "Anyone know a good way to find leads on Reddit without spending my whole day searching?"</p>
          <div className="guide-example-bad">"Check out my tool, it does exactly this: [link]"</div>
          <div className="guide-example-good">"Manually it's about 2-3 hours a day across a few subs if you're thorough — search terms, watch for 'recommend' and 'alternative to' posts. I got tired of doing that by hand and ended up building something that automates the scanning part, happy to share if useful."</div>
        </div>

        <p>
          Same information, same product mention. The second one reads like a person, not an ad. We built <Link href="/">Kairo</Link> because the manual version of this doesn't scale past week one — read the <Link href="/guides/how-to-find-customers-on-reddit">full breakdown on finding customers on Reddit</Link> if this is your first channel.
        </p>

        <h3>Indie Hacker and maker communities</h3>
        <p>
          Indie Hackers, r/SaaS, r/EntrepreneurRideAlong. These aren't full of your customers — they're full of other founders. But they're a fast way to get eyes on your product, get honest feedback, and occasionally find someone who's building something adjacent and refers you to their audience. Don't expect this to be your main channel. Treat it as a testing ground.
        </p>

        <h3>Cold outreach, done right</h3>
        <p>
          Cold DMs on Twitter almost never work pre-launch — you have no credibility yet, so nobody replies. What does work: finding someone who publicly complained about the exact problem you solve, and replying to that specific complaint with a specific answer. Ten of these beat a hundred generic DMs.
        </p>

        <h3>Answering questions before you ever pitch</h3>
        <p>
          Find the forums, Discords, and subreddits where your future customers ask questions. Answer them. Genuinely, fully, without mentioning your product. Do this for two weeks before you ever bring it up. By the time you do mention it, you're not a stranger pitching — you're the person who already helped.
        </p>

        <div className="guide-mid-cta">
          <p>See what this looks like on Reddit specifically, right now, for your own product.</p>
          <Link href="/onboarding">Run a free scan →</Link>
        </div>

        <h2>The mistake almost every founder makes</h2>
        <p>
          Broadcasting instead of listening. Posting "I built X, check it out" into a subreddit that never asked for it. It gets ignored or removed, and worse, it burns the account for future genuine replies. The founders who get traction are scanning for the conversation that's already happening, not starting a new one nobody asked for.
        </p>

        <h2>A weekly system that actually holds up</h2>
        <p>Nothing complicated. Repeat this on a schedule and you'll know within two weeks whether a channel is working:</p>
        <ol className="guide-checklist">
          <li><span className="guide-checklist-num">1</span><span>Spend 30 minutes a day, same time if you can manage it — consistency matters more than duration.</span></li>
          <li><span className="guide-checklist-num">2</span><span>Check 3-5 relevant communities, not fifteen. Depth beats spread this early.</span></li>
          <li><span className="guide-checklist-num">3</span><span>Reply genuinely to 2-3 threads. Helpful first, product second, only if it's actually relevant.</span></li>
          <li><span className="guide-checklist-num">4</span><span>Track which replies turn into signups, even in a spreadsheet. This is how you find out which channel is actually working instead of guessing.</span></li>
        </ol>

        <h2>Related reading</h2>
        <div className="guide-links-out">
          <Link href="/guides/how-to-find-customers-on-reddit">How to Find Customers on Reddit</Link>
        </div>

        <div className="guide-final-cta">
          <p>Your next customer posted 2 hours ago. They're still waiting for a reply.</p>
          <Link href="/onboarding" className="btn-primary">Find My First Customer →</Link>
        </div>
      </div>

      <Footer />
    </>
  )
}
