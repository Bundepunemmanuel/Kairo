// score.js — Simple, robust, no silent failures
// Scoring: Cerebras gpt-oss-120b (primary, 1M tokens/day) → gpt-oss-20b via OpenRouter free tier (2nd, no shared quota risk with Cerebras — swapped in from Nemotron 3 Ultra 550B, which was too large for the free tier to serve fast enough) → Groq openai/gpt-oss-120b (final fallback — reordered last after its 200K TPD quota ran out mid-day on Aug 20 and wasted the time budget every request needed for a real fallback to complete)

// Vercel Hobby's default timeout (5-10s) isn't enough room for the
// rate-limit retry wait below (up to ~30s). Hobby allows configuring
// maxDuration up to 60s explicitly — without this, a retry would get
// killed by Vercel mid-wait and return a 504 instead of completing.
export const config = { maxDuration: 60 }

// ─── Scoring weights ────────────────────────────────────────────────────
// Final is computed here in code, not by the model, so it can be tuned
// without touching the prompt. Problem and Intent are weighted higher
// than ICP deliberately: someone with a real problem and real buying
// intent is still a workable lead even at an imperfect ICP fit, but a
// perfect-ICP post with no real problem or intent isn't a lead at all.
// ICP modulates the score, it doesn't gate it.
const WEIGHTS = { problem: 0.4, intent: 0.4, icp: 0.2 }

// Starting point, not a final answer. The old single-score bar (score >= 7
// out of 10, i.e. 70%) produced zero qualified leads across 25 posts, so
// 70% is proven too strict for this prompt. 60 leaves real room below that
// failed bar. Revisit after watching real Final-score distributions in the
// logs below — if posts in the 50-60 range look like real leads on manual
// read, lower it; if posts clearing 60 look weak, raise it.
const QUALIFY_THRESHOLD = 60

// Close-match tier — only used when the caller explicitly opts in via
// includeCloseMatches (currently just onboarding's free scan). Posts
// scoring between this and QUALIFY_THRESHOLD are real, genuinely-scored
// posts — just below the strict bar. Never fabricated, never shown as
// equally strong as a qualified lead; the UI must label them clearly.
// cron-scan (paying users' dashboard) never sends this flag, so this
// tier is inert there — zero behavior change for existing users.
const CLOSE_MATCH_THRESHOLD = 40

function parseRetryAfterSeconds(message) {
  // Groq's TPM error looks like: "...Please try again in 30.1725s."
  const match = (message || '').match(/try again in ([\d.]+)s/i)
  return match ? Math.ceil(parseFloat(match[1])) : null
}

async function groq(messages, maxTokens, temperature, model = 'openai/gpt-oss-120b', _isRetry = false) {
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature, reasoning_effort: 'low' }),
    })
    const data = await res.json()
    if (data.error) {
      console.log(`[groq:${model}] error:`, data.error.message)

      // Rate limit hit (TPM/RPM ceiling) — this is transient, not a real
      // "no content" failure. Wait the time Groq tells us and retry once,
      // instead of silently treating it as zero qualifying leads.
      const isRateLimit = res.status === 429 || /rate.?limit/i.test(data.error.message || '')
      if (isRateLimit && !_isRetry) {
        const waitSeconds = parseRetryAfterSeconds(data.error.message) || 15
        console.log(`[groq:${model}] rate limited — retrying in ${waitSeconds}s`)
        await new Promise(r => setTimeout(r, waitSeconds * 1000))
        return groq(messages, maxTokens, temperature, model, true)
      }

      return ''
    }
    return data.choices?.[0]?.message?.content || ''
  } catch (e) {
    console.log(`[groq:${model}] fetch error:`, e.message)
    return ''
  }
}

// Third fallback only — no retry logic. By the time both Cerebras and
// Groq have failed, burning more time on a retry risks the function
// timeout. Single best-effort attempt, fail-empty if it doesn't work.
// Free-tier fallback via OpenRouter. Was nvidia/nemotron-3-ultra-550b-a55b
// (550B params) — too large for a free/shared endpoint to serve reliably;
// it was hanging past the 20s timeout during the Aug 20 outage. Swapped
// to gpt-oss-20b: same model family already run as primary/secondary on
// Cerebras and Groq, just far smaller (20B), so it's fast enough for a
// free tier and behaves consistently with the rest of the fallback chain.
async function gptOss20b(messages, maxTokens, temperature) {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
      body: JSON.stringify({
        model: 'openai/gpt-oss-20b:free',
        messages,
        max_tokens: maxTokens,
        temperature,
      }),
      // No timeout here previously — during the Aug 20 outage this let a
      // hung request run until Vercel's own 60s hard-kill, instead of
      // failing fast enough to let Groq (now the final fallback) get a
      // real shot. 20s leaves genuine room for Groq afterward within the
      // 60s ceiling.
      signal: AbortSignal.timeout(20000),
    })
    const data = await res.json()
    if (data.error) { console.log('[gpt-oss-20b] error:', data.error.message); return '' }
    let content = data.choices?.[0]?.message?.content || ''
    // Reasoning models emit a <think>...</think> trace before the real
    // answer — strip it so it doesn't break JSON parsing or leak into
    // whatever the caller actually wants (scoring JSON / reply text).
    content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
    return content
  } catch (e) {
    console.log('[gpt-oss-20b] fetch error:', e.message)
    return ''
  }
}

async function cerebras(messages, maxTokens, temperature, _isRetry = false) {
  try {
    const res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.CEREBRAS_API_KEY}` },
      body: JSON.stringify({ model: 'gpt-oss-120b', messages, max_tokens: maxTokens, temperature, reasoning_effort: 'low' }),
    })

    if (res.status === 429 && !_isRetry) {
      // Cerebras reports reset time via headers, not error message text.
      const resetSeconds = parseFloat(res.headers.get('x-ratelimit-reset-tokens-minute') || '')
      const waitSeconds = Number.isFinite(resetSeconds) ? Math.ceil(resetSeconds) + 1 : 15
      console.log(`[cerebras] rate limited — retrying in ${waitSeconds}s`)
      await new Promise(r => setTimeout(r, waitSeconds * 1000))
      return cerebras(messages, maxTokens, temperature, true)
    }

    const data = await res.json()
    if (data.error) { console.log('[cerebras] error:', data.error.message); return '' }
    const content = data.choices?.[0]?.message?.content || ''

    // Cerebras sometimes returns 200 with genuinely blank content — not an
    // error, just nothing. Retry once before falling through to Groq.
    if (!content && !_isRetry) {
      console.log('[cerebras] empty content on success response — retrying once')
      await new Promise(r => setTimeout(r, 3000))
      return cerebras(messages, maxTokens, temperature, true)
    }
    return content
  } catch (e) {
    console.log('[cerebras] fetch error:', e.message)
    return ''
  }
}

function parseJSON(raw) {
  try {
    // Strip qwen think blocks and markdown fences
    const clean = raw
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/```json|```/g, '')
      .trim()
    const match = clean.match(/\[[\s\S]*\]/)
    if (!match) return null
    return JSON.parse(match[0])
  } catch {
    return null
  }
}

// ─── Score all posts in one call (no batching complexity) ─────────────────
// Takes up to 40 posts, returns { scored: [...], scoredUrls: [...] }
// scoredUrls is every post actually sent to an AI — used by cron-scan to
// mark them in seen_posts so they're never re-scored, whether they
// qualified as a lead or not.
async function scorePosts(posts, analysis) {
  // Take first 40 posts — safely within budget for either provider.
  // Posts arrive already round-robin'd across subreddits from cron-scan,
  // so this sample is spread fairly rather than dominated by whichever
  // subreddit was fetched first.
  const sample = posts.slice(0, 40)
  const scoredUrls = sample.map(p => p.url).filter(Boolean)

  const input = sample.map((p, i) => ({
    i,
    title: p.title,
    body: (p.body || '').slice(0, 300),
    sub: p.subreddit,
  }))

  const messages = [
    {
      role: 'system',
      content: 'Lead qualification engine. Return only a valid JSON array. No markdown. No explanation.',
    },
    {
      role: 'user',
      content: `Score EVERY one of these Reddit posts as a potential lead for this product. Return a score for all of them, even posts that clearly don't qualify — do not skip any, do not return [] to mean "nothing qualifies here."

PRODUCT: ${analysis.name}
WHAT IT DOES: ${analysis.description}
TARGET CUSTOMER: ${analysis.targetCustomer || ''}
SPECIFIC PROBLEMS IT SOLVES: ${analysis.specificProblems?.slice(0, 5).join(' | ') || ''}
COMPETITORS: ${analysis.competitors?.join(', ') || 'none'}

Score each post on THREE separate 0-100 scales:

PROBLEM (0-100): imagine highlighting every sentence in this post that's actually about one of the specific problems above. Is most of the post highlighted, or is there just one throwaway line buried in something unrelated?
This is about substance, not phrasing — a post can score high whether the person is complaining, calmly reflecting, realizing something out loud, or telling a story, as long as the problem is genuinely what the post is about. Do NOT infer a generic need (e.g. "every founder needs users/growth/customers") onto a post just because they're a founder — that must actually be what THIS post is substantively about, not something true of founders in general.
- 70-100: most of the post's substance is this problem — it's what the post is actually about, regardless of tone or whether they explicitly ask for help
- 30-69: the problem appears, but it's one part of a post that's mostly about something else
- 0-29: not present, or only a passing/incidental line while the post is fundamentally about something unrelated (e.g. a launch announcement, an unrelated question, a milestone post)

ICP (0-100): how well the poster matches the target customer described above.
- 80-100: clearly matches the target customer
- 40-79: plausible fit, not explicit
- 0-39: wrong business type / audience for this product

INTENT (0-100): how actively they're seeking a solution right now.
- 80-100: actively asking for a solution/recommendation now
- 40-79: has the pain, not actively shopping (passive)
- 0-39: no real intent signal — sharing, announcing, general discussion, networking, or asking how to start with no existing product

Do not let one dimension bleed into another — e.g. a post can have a real Problem but low Intent if they're just venting, not asking.

Format: [{"i":0,"problem":72,"icp":65,"intent":88,"type":"active","problem_text":"exact problem they have","why":"one sentence from their words"}]
"type" is "active" (seeking solution now) or "passive" (has pain, not shopping)

Posts: ${JSON.stringify(input)}`,
    },
  ]

  // Cerebras first — 1M tokens/day vs Groq's 200K for this workload, and
  // scoring is by far the highest-volume call in the app (every cron run,
  // every user).
  //
  // gpt-oss-20b (via OpenRouter free tier) is second, not last, as of the
  // Aug 20 outage: Groq's 200K TPD budget was exhausted mid-day, and every
  // request during that window burned 15-30s on a doomed rate-limit retry
  // before ever reaching the real final fallback — which then had almost
  // no time left before Vercel's 60s hard timeout killed the whole
  // function. This fallback has no shared daily-token risk with Cerebras's
  // own outages, so it gets tried while there's still real time budget
  // left, and Groq — the one actually prone to running dry — is now the
  // true last resort instead of a wasted middle step.
  console.log('[score] trying Cerebras (primary)')
  let raw = await cerebras(messages, 1500, 0.1)

  if (!raw) {
    console.log('[score] Cerebras empty — falling back to gpt-oss-20b')
    raw = await gptOss20b(messages, 2500, 0.1)
  }

  if (!raw) {
    console.log('[score] gpt-oss-20b empty — falling back to Groq (final)')
    raw = await groq(messages, 1500, 0.1)
  }

  console.log(`[score] raw (150): ${raw.slice(0, 150)}`)

  const scored = parseJSON(raw)
  if (!scored) { console.log('[score] parse failed'); return { scored: [], scoredUrls } }

  console.log(`[score] model returned ${scored.length} posts scored`)

  const allResults = scored
    .filter(s => typeof s.i === 'number' && s.i >= 0 && s.i < sample.length)
    .map(s => {
      const post = sample[s.i]
      if (!post) { console.log(`[score] post at index ${s.i} is undefined`); return null }

      const problem = Number(s.problem) || 0
      const icp = Number(s.icp) || 0
      const intent = Number(s.intent) || 0

      // Floor gate: if the problem barely appears in the post at all, no
      // amount of ICP/Intent should be able to rescue it. Without this, a
      // founder posting about literally anything in the right subreddit,
      // phrased as a question, could clear threshold on ICP+Intent alone
      // even with almost no real problem match — which is exactly the
      // false-positive pattern seen in production (e.g. a payment-processor
      // question scoring Problem 40 but still qualifying at Final 68).
      const PROBLEM_FLOOR = 30
      const final = problem < PROBLEM_FLOOR
        ? problem
        : Math.round(problem * WEIGHTS.problem + intent * WEIGHTS.intent + icp * WEIGHTS.icp)
      const qualifies = final >= QUALIFY_THRESHOLD
      const tier = qualifies ? 'qualified' : final >= CLOSE_MATCH_THRESHOLD ? 'close' : null

      // Log every post's breakdown, pass or fail — this is what the old
      // code never gave us: visibility into *why* a post didn't qualify,
      // not just a silent drop.
      console.log(
        `[score] "${(post.title || '').slice(0, 60)}" — ` +
        `Problem: ${problem} | ICP: ${icp} | Intent: ${intent} | Final: ${final} — ` +
        (qualifies ? 'Qualified' : `Rejected (threshold ${QUALIFY_THRESHOLD})`)
      )

      return {
        post,
        problem,
        icp,
        intent,
        score: final, // kept as `score` downstream so cron-scan/leads consumers don't need to change
        qualifies,
        tier,
        signalType: s.type === 'active' ? 'active' : 'passive',
        specificProblem: s.problem_text || '',
        reason: s.why || '',
      }
    })
    .filter(Boolean)

  const results = allResults.filter(r => r.qualifies)
  // Real, genuinely-scored posts just below the strict bar. Never
  // fabricated. Only surfaced to callers that explicitly opt in via
  // includeCloseMatches — cron-scan never sends that flag, so this is
  // inert for paying users' dashboards, unchanged from before.
  const closeMatches = allResults.filter(r => r.tier === 'close')

  return { scored: results, closeMatches, scoredUrls }
}

// ─── Main handler ─────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { posts, analysis, includeCloseMatches } = req.body
  if (!posts?.length || !analysis) return res.status(400).json({ error: 'posts and analysis required' })

  console.log(`[score] ${posts.length} posts | product: ${analysis.name}`)

  try {
    const { scored, closeMatches, scoredUrls } = await scorePosts(posts, analysis)
    console.log(`[score] qualified: ${scored.length}${includeCloseMatches ? ` | close matches: ${closeMatches.length}` : ''}`)

    if (!scored.length && !(includeCloseMatches && closeMatches.length)) {
      return res.status(200).json({ leads: [], scoredUrls })
    }

    const toLead = ({ post, score, signalType, specificProblem, reason, tier }) => {
      const ageMinutes = (Date.now() - (post.createdAt || Date.now())) / 60000
      const maxWindow = signalType === 'active' ? 180 : 360
      return {
        ...post,
        score,
        signalType,
        specificProblem,
        reason,
        tier: tier || 'qualified',
        draftReply: null, // generated on demand
        expiresIn: maxWindow - ageMinutes,
        expired: (maxWindow - ageMinutes) <= 0,
        commentLead: null,
      }
    }

    const top3 = scored.sort((a, b) => b.score - a.score).slice(0, 3)
    console.log('[score] top3:', top3.map(s => `"${s.post.title.slice(0, 35)}" (${s.score})`).join(' | '))

    // No reply generation here — replies are generated on-demand via /api/reply
    let leads = top3.map(toLead)

    // Close matches are additive, never a substitute for qualified leads,
    // and only included when the caller explicitly asks — currently just
    // onboarding's free scan. Capped at 2 so they support the qualified
    // leads rather than crowding them out.
    if (includeCloseMatches && closeMatches.length) {
      const topClose = closeMatches.sort((a, b) => b.score - a.score).slice(0, 2)
      console.log('[score] close matches:', topClose.map(s => `"${s.post.title.slice(0, 35)}" (${s.score})`).join(' | '))
      leads = [...leads, ...topClose.map(toLead)]
    }

    console.log(`[score] returning ${leads.length} leads`)
    return res.status(200).json({ leads, scoredUrls })

  } catch (err) {
    console.error('[score] fatal:', err.message)
    return res.status(500).json({ error: 'Scoring failed' })
  }
}
