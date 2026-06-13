# Kairo — Customer Acquisition Platform for Solo Founders

Kairo automatically finds people on Reddit who are ready to buy products like yours.
Paste your URL → Kairo reads your product → finds live Reddit posts with buying intent → scores them → drafts your reply → shows a decay timer and

---

## File Structure

```
kairo/
├── pages/
│   ├── _app.js           ← App wrapper. Imports global CSS. Do not delete.
│   ├── index.js          ← Landing page (route: /)
│   ├── onboarding.js     ← Onboarding flow (route: /onboarding)
│   └── api/
│       ├── check-ip.js   ← Rate limiting. 1 free scan per IP per 24h.
│       └── scan.js       ← Main pipeline: Jina → Groq → Reddit → Score → Draft
│
├── styles/
│   └── globals.css       ← All styles. Design tokens, components, responsive.
│
├── .env.local            ← Your secret keys. Never commit this file.
├── .gitignore            ← Ignores node_modules, .next, .env.local
├── next.config.js        ← Next.js config
├── package.json          ← Dependencies
└── README.md             ← This file
```

---

## Setup Instructions

### Step 1 — Get your Groq API key
Go to https://console.groq.com
Sign up → Create API Key → Copy it

### Step 2 — Add it to .env.local
Open the `.env.local` file and replace the placeholder:
```
GROQ_API_KEY=paste_your_key_here
```

### Step 3 — Install dependencies
Open your terminal in the kairo folder and run:
```
npm install
```

### Step 4 — Run locally
```
npm run dev
```
Open http://localhost:3000

### Step 5 — Deploy to Vercel
1. Push to GitHub
2. Go to vercel.com → New Project → Import your repo
3. Add environment variable: GROQ_API_KEY = your key
4. Deploy

---

## How The Scan Pipeline Works

```
User pastes URL
      ↓
Check localStorage — already scanned? → Show gate
      ↓
GET /api/check-ip — IP already used? → Show gate
      ↓
POST /api/scan
      ↓
Jina Reader fetches website text
https://r.jina.ai/{url}
      ↓
Groq analyzes the product
→ name, description, target customer
→ pain points, keywords, subreddits
      ↓
Fetch Reddit posts in parallel
reddit.com/r/{subreddit}/new.json
for each subreddit identified
      ↓
Groq scores all posts 1-10
→ filters to 6+ only
→ labels active or passive demand
      ↓
Groq generates draft reply
for top 3 posts
→ tone calibrated to signal type
      ↓
Calculate decay timer
based on post age + signal type
      ↓
Return leads to frontend
Show cards with timers
```

---

## Rate Limiting Logic

**Anonymous users:**
- 1 free scan per browser (localStorage key: `kairo_scan_used`)
- 1 free scan per IP per 24 hours (tracked in memory)
- Both checks happen before the scan runs
- Gate screen shown if either check fails

**After email capture:**
- Email saved to localStorage (key: `kairo_email`)
- Will connect to Supabase in Chunk 2

**Paid plans (Chunk 2+):**
- Starter $29/mo → 10 leads/day, 3 subreddits
- Pro $49/mo → 50 leads/day, 10 subreddits, draft replies
- Unlimited $99/mo → unlimited everything

---

## Design System

All design tokens live at the top of `styles/globals.css`

| Token | Value | Used for |
|---|---|---|
| --rust | #c0584a | Primary accent, CTAs, highlights |
| --cream | #f5f0eb | Page background |
| --ink | #1a1208 | Primary text, dark sections |
| --ink-light | #6b5a48 | Secondary text |
| --font-display | Playfair Display | All headlines |
| --font-body | DM Sans | All body text |
| --font-mono | DM Mono | Scores, timers |

---

## Files To Create In Future Chunks

### Chunk 2 — Supabase Auth + Database

Files to add:
```
pages/
├── login.js              ← Login page
├── signup.js             ← Signup page
└── api/
    ├── auth.js           ← Supabase auth handler
    └── waitlist.js       ← Save email to Supabase

lib/
└── supabase.js           ← Supabase client
```

Supabase SQL to run:
```sql
CREATE TABLE users (
  id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  plan TEXT DEFAULT 'free',
  leads_used_today INTEGER DEFAULT 0,
  last_scan_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE products (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  url TEXT,
  name TEXT,
  description TEXT,
  target_customer TEXT,
  pain_points TEXT[],
  keywords TEXT[],
  subreddits TEXT[],
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE leads (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  post_title TEXT,
  post_body TEXT,
  post_url TEXT,
  subreddit TEXT,
  score NUMERIC,
  signal_type TEXT,
  draft_reply TEXT,
  reason TEXT,
  expires_at TIMESTAMPTZ,
  status TEXT DEFAULT 'new',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE waitlist (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Chunk 3 — Dashboard

Files to add:
```
pages/
└── dashboard.js          ← Lead Hunter Dashboard
```

### Chunk 4 — Cron Job

Files to add:
```
supabase/
└── functions/
    └── scan-cron/
        └── index.ts      ← Runs every 15 min, scans all active users
```

### Chunk 5 — Payments

Files to add:
```
pages/
├── billing.js            ← Billing and upgrade page
└── api/
    └── webhook.js        ← Lemon Squeezy webhook handler
```

### Chunk 6 — Settings + Admin

Files to add:
```
pages/
├── settings.js           ← User settings
└── admin.js              ← Admin dashboard
```

---

## Pages at Launch (August 13)

| Page | File | Status |
|---|---|---|
| Landing | pages/index.js | ✅ Done |
| Onboarding | pages/onboarding.js | ✅ Done |
| Login | pages/login.js | 🔲 Chunk 2 |
| Signup | pages/signup.js | 🔲 Chunk 2 |
| Dashboard | pages/dashboard.js | 🔲 Chunk 3 |
| Billing | pages/billing.js | 🔲 Chunk 5 |
| Settings | pages/settings.js | 🔲 Chunk 6 |
| Admin | pages/admin.js | 🔲 Chunk 6 |

---

## Launch Date
**August 13, 2026**

Built by Emmanuel — solo founder, building in public.
