import Head from 'next/head'
import Link from 'next/link'
import Nav from '../components/Nav'
import Footer from '../components/Footer'

const S = {
  h2: { fontFamily: 'var(--font-display)', fontSize: 'var(--text-lg)', color: 'var(--ink)', margin: '2.2rem 0 0.9rem' },
  p: { fontSize: 'var(--text-base)', lineHeight: 1.7, color: 'var(--ink-mid)', margin: '0 0 1rem' },
  ul: { margin: '0 0 1rem', paddingLeft: '1.3rem', color: 'var(--ink-mid)', lineHeight: 1.7 },
  li: { marginBottom: '0.4rem' },
  strong: { color: 'var(--ink)' },
}

export default function Privacy() {
  return (
    <>
      <Head>
        <title>Privacy Policy — Kairo</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,700;0,900;1,700&family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet" />
      </Head>

      <Nav solid />

      <main style={{ maxWidth: 720, margin: '0 auto', padding: '3rem 1.5rem 4rem' }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-2xl)', color: 'var(--ink)', marginBottom: '0.3rem' }}>
          Privacy Policy
        </h1>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-light)', marginBottom: '2rem' }}>
          Last updated: November 16, 2026
        </p>

        <p style={S.p}>
          This is written around what Kairo actually does, not a generic template. If a sentence
          here doesn't match how Kairo behaves, email <a href="mailto:bundepunemmanuel@gmail.com">bundepunemmanuel@gmail.com</a> and
          we'll fix the sentence or fix the product.
        </p>

        <h2 style={S.h2}>1. Information We Collect</h2>
        <p style={S.p}>
          <strong style={S.strong}>Account information.</strong> If you create an account, we collect your email address
          and, through Supabase (our authentication provider), a securely hashed version of your password — we never see
          or store your password in readable form. If you sign in with Google, we receive the email address and basic
          profile information Google shares under its standard OAuth consent flow.
        </p>
        <p style={S.p}>
          <strong style={S.strong}>The product you ask us to analyze.</strong> When you submit a URL — yours or someone
          else's — we fetch its public content and generate an AI analysis of what the product does and who it's for.
          We store that URL and analysis against your account, or temporarily for a one-off shared scan (see Section 4).
        </p>
        <p style={S.p}>
          <strong style={S.strong}>Public Reddit content.</strong> To find leads, we read public Reddit posts and, for
          some leads, public comments — titles, body text, subreddit, the post's or comment's URL, and timestamps.
          Where we process comments specifically, we also capture the Reddit username attached to that comment, exactly
          as it appears publicly on Reddit. We don't access private messages, locked threads, or anything Reddit
          doesn't already make public.
        </p>
        <p style={S.p}>
          <strong style={S.strong}>AI-drafted replies.</strong> For each lead we find, we generate a suggested reply
          using third-party AI models (Section 3). We store the text we generate.
        </p>
        <p style={S.p}>
          <strong style={S.strong}>Usage and analytics data.</strong> We assign your browser a visitor ID and session
          ID, stored in your browser's local storage — not a cookie. We log which pages you view, how long a session
          lasts, referrer and UTM campaign information, your device type, and actions you take on the site (starting a
          scan, signing up, and so on). This is first-party analytics we operate ourselves; we don't use third-party ad
          trackers.
        </p>
        <p style={S.p}>
          <strong style={S.strong}>Push notification data.</strong> If you opt in to browser notifications, we store
          the subscription details your browser gives us (an endpoint and encryption keys) so we can deliver an alert.
          We only collect this if you explicitly grant the browser's permission prompt.
        </p>

        <h2 style={S.h2}>2. How We Use It</h2>
        <ul style={S.ul}>
          <li style={S.li}>Running the core service: analyzing a submitted product, scanning Reddit, scoring matches, and drafting replies</li>
          <li style={S.li}>Running scheduled background scans for accounts and watchlisted products, so new matches can be found without you re-running a scan by hand</li>
          <li style={S.li}>Sending you leads and notifications, by email or push, if you've asked for them</li>
          <li style={S.li}>Operating, maintaining, and improving the accuracy of the matching and scoring itself</li>
          <li style={S.li}>Internal analytics on how the product is used, to decide what to build next</li>
        </ul>

        <h2 style={S.h2}>3. Who We Share It With</h2>
        <p style={S.p}>
          We don't sell your data, and we don't share it with advertisers. The following third parties process data on
          our behalf, strictly to run the service:
        </p>
        <ul style={S.ul}>
          <li style={S.li}><strong style={S.strong}>Supabase</strong> — our database, authentication, and storage provider. Your account data, submitted product data, and leads live here.</li>
          <li style={S.li}><strong style={S.strong}>Vercel</strong> — our hosting provider.</li>
          <li style={S.li}><strong style={S.strong}>Third-party AI model providers</strong> — the product URL you submit and the Reddit content we scan are sent to one or more third-party AI services to generate the analysis, scoring, and drafted replies. We don't control these providers' own data retention; we send only what's needed to produce a result, never your account credentials.</li>
          <li style={S.li}><strong style={S.strong}>A web push notification service</strong> — only if you opt in to browser alerts.</li>
        </ul>
        <p style={S.p}>
          We may also disclose information if required by law, or to protect the rights, safety, or property of Kairo,
          our users, or the public.
        </p>

        <h2 style={S.h2}>4. Public Shared Scan Links</h2>
        <p style={S.p}>
          This gets its own section because it's unusual: Kairo lets anyone generate a public link from any product's
          URL — including a product they don't own. That link, once created, is viewable by anyone who has it, without
          logging in, for 7 days. The page shows the product's AI-generated analysis and the specific Reddit leads and
          drafted replies found for it.
        </p>
        <p style={S.p}>
          This means information about a product — including one you didn't submit yourself — can become publicly
          accessible this way for up to 7 days, even if you've never used Kairo. After 7 days, the link stops working
          and the page is no longer accessible to anyone.
        </p>

        <h2 style={S.h2}>5. Reddit — Our Relationship to It</h2>
        <p style={S.p}>
          Kairo is not affiliated with, endorsed by, or operated by Reddit, Inc. We read data Reddit already makes
          publicly available through its own feeds and APIs. We don't store anything from private messages, deleted or
          removed content, or non-public subreddits. Usernames that appear in our results are Reddit's own public
          data — we don't modify, verify, or add to them.
        </p>

        <h2 style={S.h2}>6. How Long We Keep Data</h2>
        <ul style={S.ul}>
          <li style={S.li}>Account data is kept for as long as your account exists.</li>
          <li style={S.li}>Shared scan links expire automatically 7 days after creation and are not accessible after that.</li>
          <li style={S.li}>We keep a record of which Reddit posts we've already scored for your account, so we don't re-scan and re-show you the same post twice.</li>
          <li style={S.li}>If you delete your account, we delete the data tied to it, aside from what we're required to retain for a limited period for legal, security, or backup purposes.</li>
        </ul>

        <h2 style={S.h2}>7. Your Choices</h2>
        <ul style={S.ul}>
          <li style={S.li}>You can delete your account at any time from <Link href="/settings">Settings</Link>.</li>
          <li style={S.li}>You can turn off push notifications at the browser level, or from your account settings.</li>
          <li style={S.li}>You can email <a href="mailto:bundepunemmanuel@gmail.com">bundepunemmanuel@gmail.com</a> to request a copy of the data we hold about you, or its deletion.</li>
          <li style={S.li}>If data protection law that applies to you grants additional rights — such as objecting to certain processing, or lodging a complaint with a regulator — nothing in this policy takes those rights away.</li>
        </ul>

        <h2 style={S.h2}>8. Children</h2>
        <p style={S.p}>
          Kairo is not directed at, and we don't knowingly collect information from, anyone under 16. If you believe a
          child has given us information, contact us and we'll delete it.
        </p>

        <h2 style={S.h2}>9. Security</h2>
        <p style={S.p}>
          We use reasonable technical and organizational measures to protect your data, including relying on
          Supabase's security practices for authentication and storage. No method of transmission or storage is
          perfectly secure, and we can't guarantee absolute security.
        </p>

        <h2 style={S.h2}>10. Changes to This Policy</h2>
        <p style={S.p}>
          If we materially change how we collect or use data, we'll update this page and change the "Last updated"
          date above. Continued use of Kairo after a change means you accept the updated policy.
        </p>

        <h2 style={S.h2}>11. Contact</h2>
        <p style={S.p}>
          Questions about this policy, or requests about your data: <a href="mailto:bundepunemmanuel@gmail.com">bundepunemmanuel@gmail.com</a>.
        </p>
      </main>

      <Footer />
    </>
  )
}
