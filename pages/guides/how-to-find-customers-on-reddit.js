import Link from 'next/link'
import Head from 'next/head'

export default function Guide() {
  return (
    <>
      <Head>
        <title>How to Find Customers on Reddit (A Real Playbook) — Kairo</title>
        <meta name="description" content="Reddit is full of people asking for exactly what you built. Here's how to actually find them, what to say, and what gets your comment removed." />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <div className="guide-hero">
        <div className="guide-label">Reddit</div>
        <h1 className="guide-headline">How to find<br /><em>customers on Reddit</em></h1>
        <p className="guide-dek">
          Somewhere on Reddit right now, someone is describing the exact problem your product solves and asking if anything fixes it. Here's how to actually find that post.
        </p>
      </div>

      <div className="guide-body">
        <p>
          Reddit is the single best free source of buying-intent leads for an early-stage product, and almost nobody uses it right. Most founders either ignore it completely or post one "check out my product" thread that gets removed in ten minutes. Neither works. What works is treating it like a search problem, not a marketing problem.
        </p>

        <h2>What a real lead looks like</h2>
        <p>
          There are two kinds of posts worth your time. The first is active demand — someone directly asking "what tool do you use for X" or "is there something that does Y." These are rare and go stale fast, usually within an hour or two, because someone else answers first. The second is passive demand — complaints. "I hate how long this takes." "Why is there no good tool for this." These are far more common, and the person hasn't started looking yet, which means you're not competing with five other replies.
        </p>

        <h2>Where to actually look</h2>
        <p>
          Start with the two or three subreddits most specific to your niche, not the biggest general one. A tiny, focused subreddit with 8,000 members who all have your exact problem beats a 2-million-member general subreddit where your problem is 1% of the conversation. Search the subreddit directly using terms like "recommend," "alternative to," and "is there a tool" rather than scrolling the feed and hoping.
        </p>

        <h2>Reddit lead scanning — what it actually means</h2>
        <p>
          Scanning, in practice, is just this loop repeated constantly: pull new posts from your target subreddits, check each one for buying-intent language, flag the ones worth a reply, ignore the rest. Doing this by hand for even three subreddits takes two to three hours a day if you're thorough, which is exactly why most people give up after a week. This is the entire reason <Link href="/">Kairo exists</Link> — it runs that same loop automatically and scores each post for intent so you only see the ones worth your time.
        </p>

        <h2>How to reply without getting your comment removed</h2>
        <p>
          A lot of subreddits explicitly ban self-promotion, and Reddit's community as a whole is fast to downvote anything that smells like an ad. The reply that works: answer the actual question first, mention your product second and briefly, and only if it's genuinely the answer — not "check out my product," but "I built something for exactly this, here's the link if you want it." If a subreddit's rules ban vendor replies outright, don't reply at all. Build karma there instead by being a normal, helpful member, and save the product mentions for subreddits that allow it.
        </p>

        <h2>Active vs. passive — reply differently to each</h2>
        <p>
          Active demand needs speed and directness. They're already shopping — answer their question plainly and let your product speak for itself. Passive demand needs empathy first. They don't know a solution exists yet, so leading with a pitch reads as tone-deaf. Validate the frustration, then mention what you built almost as an aside. The reply that gets upvoted is the one that would still be a good comment even if you deleted the product mention entirely.
        </p>

        <h2>The realistic timeline</h2>
        <p>
          Don't expect your first reply to convert. Expect your fifteenth to. Reddit users are skeptical of anything that looks like marketing, and trust builds slowly — genuinely helpful replies over two or three weeks are what make the eventual product mention land instead of getting ignored or downvoted.
        </p>

        <div className="guide-inline-cta">
          <p style={{ marginBottom: '10px', color: 'var(--ink)' }}>
            <Link href="/onboarding">Kairo</Link> scans your target subreddits every 15 minutes, scores each post for buying intent, and drafts a reply calibrated to whether it's active or passive demand — so you skip the manual searching entirely.
          </p>
        </div>

        <h2>Related reading</h2>
        <div className="guide-links-out">
          <Link href="/guides/how-to-get-your-first-100-users">How to Get Your First 100 Users</Link>
        </div>

        <div className="guide-final-cta">
          <p>Stop searching Reddit by hand. Let Kairo find the thread worth replying to.</p>
          <Link href="/onboarding" className="btn-primary">Find My First Customer →</Link>
        </div>
      </div>
    </>
  )
}
