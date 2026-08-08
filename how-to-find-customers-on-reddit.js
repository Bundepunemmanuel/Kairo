import Link from 'next/link'
import Head from 'next/head'
import Nav from '../../components/Nav'
import Footer from '../../components/Footer'

export default function Guide() {
  return (
    <>
      <Head>
        <title>How to Find Customers on Reddit (A Real Playbook) — Kairo</title>
        <meta name="description" content="Reddit is full of people asking for exactly what you built. Here's how to actually find them, what to say, and what gets your comment removed." />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <Nav />

      <div className="guide-hero">
        <div className="guide-label">Reddit</div>
        <h1 className="guide-headline">How to find<br /><em>customers on Reddit</em></h1>
        <p className="guide-dek">
          Somewhere on Reddit right now, someone is describing the exact problem your product solves and asking if anything fixes it. Here's how to actually find that post.
        </p>
      </div>

      <div className="guide-body">
        <div className="guide-tldr">
          <strong>Short version:</strong> Search small, specific subreddits for "recommend," "alternative to," and "is there a tool" posts. Answer the question fully before mentioning your product. Expect your fifteenth reply to convert, not your first.
        </div>

        <p>
          Reddit is the single best free source of buying-intent leads for an early-stage product, and almost nobody uses it right. Most founders either ignore it completely or post one "check out my product" thread that gets removed in ten minutes. What works is treating it like a search problem, not a marketing problem.
        </p>

        <h2>What a real lead looks like</h2>
        <p>
          There are two kinds of posts worth your time. <strong>Active demand</strong> — someone directly asking "what tool do you use for X" — is rare and goes stale fast, usually within an hour or two, because someone else answers first. <strong>Passive demand</strong> — complaints like "I hate how long this takes" or "why is there no good tool for this" — is far more common, and the person hasn't started looking yet, so you're not competing with five other replies.
        </p>

        <div className="guide-pullquote">
          "The reply that gets upvoted is the one that would still be a good comment even if you deleted the product mention entirely."
        </div>

        <h2>Where to actually look</h2>
        <p>
          Start with the two or three subreddits most specific to your niche, not the biggest general one. A tiny, focused subreddit with 8,000 members who all have your exact problem beats a 2-million-member general subreddit where your problem is 1% of the conversation. Search the subreddit directly using terms like "recommend," "alternative to," and "is there a tool" rather than scrolling the feed and hoping.
        </p>

        <h2>What scanning actually means, in practice</h2>
        <p>
          Pull new posts from your target subreddits, check each one for buying-intent language, flag the ones worth a reply, ignore the rest. Doing this by hand for even three subreddits takes two to three hours a day if you're thorough — which is exactly why most people give up after a week. This loop, run automatically, is the entire reason <Link href="/">Kairo exists</Link>.
        </p>

        <div className="guide-mid-cta">
          <p>See exactly what Kairo would flag in your subreddits, right now.</p>
          <Link href="/onboarding">Run a free scan →</Link>
        </div>

        <h2>How to reply without getting your comment removed</h2>
        <p>
          A lot of subreddits explicitly ban self-promotion, and the wider Reddit community is fast to downvote anything that smells like an ad.
        </p>

        <div className="guide-example">
          <div className="guide-example-label">A hypothetical, to make this concrete</div>
          <p style={{ marginBottom: '10px', fontSize: 'var(--text-sm)' }}>Someone posts: "I hate manually searching Reddit for leads every day, feels like a waste of time."</p>
          <div className="guide-example-bad">"I built a tool for this, check it out → [link]"</div>
          <div className="guide-example-good">"Yeah, it's rough at scale — a focused subreddit alone can eat 2+ hours a day if you're doing it properly. Worth automating the search part at minimum, even if you're writing replies yourself. I ended up building something for exactly this after getting tired of it, happy to share the link if you want it."</div>
        </div>

        <p>
          Answer the actual question first. Mention your product second, and only if it's genuinely the answer. If a subreddit's rules ban vendor replies outright, don't reply at all — build karma there instead by being a normal, helpful member, and save product mentions for subreddits that allow them.
        </p>

        <h2>Active vs. passive — reply differently to each</h2>
        <p>
          Active demand needs speed and directness — they're already shopping, so answer plainly and let the product speak for itself. Passive demand needs empathy first. They don't know a solution exists yet, so leading with a pitch reads as tone-deaf. Validate the frustration, then mention what you built almost as an aside.
        </p>

        <h2>The realistic timeline</h2>
        <p>Don't expect your first reply to convert. Here's roughly what the first month actually looks like:</p>
        <ol className="guide-checklist">
          <li><span className="guide-checklist-num">1</span><span>Week 1: mostly ignored replies. This is normal — you have zero history in these communities yet.</span></li>
          <li><span className="guide-checklist-num">2</span><span>Week 2: a few upvotes, maybe a reply back. Trust is starting to build, slowly.</span></li>
          <li><span className="guide-checklist-num">3</span><span>Week 3: someone clicks through to your product without you prompting them to.</span></li>
          <li><span className="guide-checklist-num">4</span><span>Week 4 onward: this is when a well-timed reply is genuinely worth a signup, sometimes worth hundreds in MRR from one thread.</span></li>
        </ol>

        <h2>Related reading</h2>
        <div className="guide-links-out">
          <Link href="/guides/how-to-get-your-first-100-users">How to Get Your First 100 Users</Link>
        </div>

        <div className="guide-final-cta">
          <p>Stop searching Reddit by hand. Let Kairo find the thread worth replying to.</p>
          <Link href="/onboarding" className="btn-primary">Find My First Customer →</Link>
        </div>
      </div>

      <Footer />
    </>
  )
}
