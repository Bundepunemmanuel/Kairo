// score.js — Simple, robust, no silent failures
// Scoring: Gemini 3.5 Flash Lite (primary) → gpt-oss-20b via OpenRouter free tier (2nd, no shared quota risk with Gemini — swapped in from Nemotron 3 Ultra 550B, which was too large for the free tier to serve fast enough) → Groq openai/gpt-oss-120b (final fallback — reordered last after its 200K TPD quota ran out mid-day on Aug 20 and wasted the time budget every request needed for a real fallback to complete)

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
      // 12s, down from 20s — see gemini()'s comment for the full budget
      // reasoning. Groq is now raced against gpt-oss-20b (see
      // raceForContent below) rather than tried after it sequentially, so
      // this and gpt-oss-20b's timeout no longer sum in the worst case —
      // but Groq ALSO has its own rate-limit retry below, which is a
      // second, separate way this function alone could eat the whole 60s
      // budget if left uncapped.
      signal: AbortSignal.timeout(12000),
    })
    const data = await res.json()
    if (data.error) {
      console.log(`[groq:${model}] error:`, data.error.message)

      // Rate limit hit (TPM/RPM ceiling) — this is transient, not a real
      // "no content" failure. Wait the time Groq tells us and retry once,
      // instead of silently treating it as zero qualifying leads.
      //
      // Capped at 10s regardless of what Groq's error message actually
      // says — it's been seen asking for 30s+, and an uncapped wait here
      // means groq() alone (12s attempt + uncapped wait + 12s retry) could
      // burn most of the 60s ceiling by itself, independent of anything
      // else in the fallback chain. 10s is a real wait, just a bounded one.
      const isRateLimit = res.status === 429 || /rate.?limit/i.test(data.error.message || '')
      if (isRateLimit && !_isRetry) {
        const waitSeconds = Math.min(parseRetryAfterSeconds(data.error.message) || 10, 10)
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

// Races several labeled {label, promise} entries, resolving with whichever
// gives the first NON-EMPTY result — not just whichever settles first.
// Plain Promise.any/Promise.race would consider a fast-but-empty result a
// "win" over a slower-but-real one still in flight, since both
// gptOss20b() and groq() already catch their own errors and resolve with
// '' rather than rejecting. Only resolves '' once every entry has settled
// empty (or rejected) — so a slow-but-successful provider still gets used
// if the other one comes back empty first.
async function raceForContent(labeledPromises) {
  return new Promise((resolve) => {
    let remaining = labeledPromises.length
    let resolved = false
    for (const { label, promise } of labeledPromises) {
      promise
        .then((content) => {
          if (resolved) return
          if (content) {
            resolved = true
            console.log(`[score] race winner: ${label}`)
            resolve(content)
          } else {
            remaining--
            if (remaining === 0 && !resolved) resolve('')
          }
        })
        .catch((e) => {
          console.log(`[score] race participant ${label} rejected:`, e.message)
          remaining--
          if (remaining === 0 && !resolved) resolve('')
        })
    }
  })
}

// Third fallback only — no retry logic. By the time both Gemini and
// Groq have failed, burning more time on a retry risks the function
// timeout. Single best-effort attempt, fail-empty if it doesn't work.
// Free-tier fallback via OpenRouter. Was nvidia/nemotron-3-ultra-550b-a55b
// (550B params) — too large for a free/shared endpoint to serve reliably;
// it was hanging past the 20s timeout during the Aug 20 outage. Swapped
// to gpt-oss-20b: fast enough for a free tier and behaves consistently
// with the rest of the fallback chain.
//
// The ":free" suffix stopped resolving — OpenRouter started rejecting it
// ("This model is unavailable for free. The paid version is available
// now - use this slug instead: openai/gpt-oss-20b"), which meant this
// whole tier was erroring out instantly on every call, collapsing the
// fallback chain from three real tiers to two (Gemini → Groq) without it
// being obvious from the error alone. Using the slug OpenRouter's own
// error message named.
async function gptOss20b(messages, maxTokens, temperature) {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
      body: JSON.stringify({
        model: 'openai/gpt-oss-20b',
        messages,
        max_tokens: maxTokens,
        temperature,
      }),
      // 12s, down from 20s. Previously this and Groq's timeout summed
      // worst-case (tried sequentially, one full timeout each) — confirmed
      // in production: Gemini (20s) then gpt-oss-20b (20s) both timed out
      // back-to-back before Groq finally answered, burning 40s of the 60s
      // budget on two dead ends. Now raced against Groq instead of tried
      // after it (see raceForContent above), so the worst case is
      // whichever of the two is slower, not both summed — but keeping the
      // per-attempt timeout itself tight still matters, since a hung
      // request here would otherwise drag the whole race out regardless.
      signal: AbortSignal.timeout(12000),
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

async function gemini(messages, maxTokens, temperature, _isRetry = false) {
  try {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GEMINI_API_KEY}` },
      body: JSON.stringify({ model: 'gemini-3.5-flash-lite', messages, max_tokens: maxTokens, temperature }),
      // 12s, down from 20s — three tiers at 20s each meant the worst case
      // for the whole fallback chain could sit right at the 60s ceiling
      // before accounting for anything else the function does (fetching
      // Reddit, parsing, the Supabase writes around it). At 12s per
      // attempt, plus gpt-oss-20b/Groq now racing each other instead of
      // running sequentially (see raceForContent below), the worst
      // realistic case drops to roughly 12s (Gemini) + ~12-15s (the
      // slower of the race) + retry waits — comfortably under 60s with
      // real margin left over, instead of exactly at it.
      signal: AbortSignal.timeout(12000),
    })

    if (res.status === 429 && !_isRetry) {
      console.log('[gemini] rate limited — retrying in 8s')
      await new Promise(r => setTimeout(r, 8000))
      return gemini(messages, maxTokens, temperature, true)
    }

    const data = await res.json()
    if (data.error) { console.log('[gemini] error:', data.error.message); return '' }
    const content = data.choices?.[0]?.message?.content || ''

    // Gemini sometimes returns 200 with genuinely blank content — not an
    // error, just nothing. Retry once before falling through to Groq.
    //
    // This has been firing on most pass-2 calls in production (4 of 5 in
    // one recent window) — far more than occasional flakiness. Logging
    // finish_reason and usage here, diagnostic-only for now, rather than
    // guessing at a fix: if finish_reason comes back "length" with
    // completion_tokens near maxTokens, it means Gemini is spending its
    // whole budget on internal reasoning before ever emitting visible
    // content, and the real fix is raising max_tokens (or disabling
    // reasoning for this call) — not something else like a prompt or
    // safety-filter issue, which would show a different finish_reason.
    // Don't change the token budgets based on this alone until a real run
    // confirms which one it actually is.
    if (!content && !_isRetry) {
      console.log(
        `[gemini] empty content on success response — finish_reason: ${data.choices?.[0]?.finish_reason ?? 'none'}, ` +
        `usage: ${data.usage ? JSON.stringify(data.usage) : 'none'} — retrying once`
      )
      await new Promise(r => setTimeout(r, 3000))
      return gemini(messages, maxTokens, temperature, true)
    }
    return content
  } catch (e) {
    console.log('[gemini] fetch error:', e.message)
    return ''
  }
}

function parseJSON(raw) {
  // Strip qwen think blocks and markdown fences
  const clean = (raw || '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/```json|```/g, '')
    .trim()

  const match = clean.match(/\[[\s\S]*\]/)
  const candidate = match ? match[0] : clean

  try {
    return JSON.parse(candidate)
  } catch {
    // Didn't parse as-is — most likely the response got cut off mid-array
    // by hitting max_tokens before finishing (confirmed in production: a
    // Groq response ending mid-string lost all 40 scored posts in that
    // batch, even though everything before the cutoff had scored fine).
    // Salvage whatever complete objects came back instead of discarding
    // the entire result over the one that got cut off.
    return salvageTruncatedArray(clean)
  }
}

// Walks the text looking for the LAST point at which a top-level object
// genuinely closed — tracking brace depth and whether we're inside a
// quoted string, so a "}" that's just a character inside someone's post
// body doesn't get mistaken for the end of an object. Returns null if not
// even one complete object can be recovered.
function salvageTruncatedArray(clean) {
  const start = clean.indexOf('[')
  if (start === -1) return null
  const body = clean.slice(start + 1)

  let depth = 0
  let inString = false
  let escape = false
  let lastCompleteEnd = -1

  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (escape) { escape = false; continue }
    if (c === '\\') { escape = true; continue }
    if (c === '"') { inString = !inString; continue }
    if (inString) continue
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) lastCompleteEnd = i
    }
  }

  if (lastCompleteEnd === -1) return null

  try {
    const parsed = JSON.parse(`[${body.slice(0, lastCompleteEnd + 1)}]`)
    console.log(`[score] response was truncated mid-array — salvaged ${parsed.length} complete object(s) before the cutoff instead of discarding the whole batch`)
    return parsed
  } catch {
    return null
  }
}

// ─── Score all posts, two passes ───────────────────────────────────────
// Takes up to 250 posts, returns { scored: [...], closeMatches: [...], scoredUrls: [...] }.
// Pass 1 (relevanceFilter, above) is a cheap loose screen over the full
// sample; pass 2 (below, inside scorePosts) is the existing full-reasoning
// prompt, unchanged, run only on whoever survives pass 1.
// scoredUrls is every post actually sent to an AI across both passes —
// used by cron-scan to mark them in seen_posts so they're never re-scored,
// whether they qualified as a lead or not.
// Interleaves posts round-robin by subreddit (r1-s1, r1-s2, r1-s3, r2-s1,
// ...) instead of leaving them in whatever order they arrived. Moved here
// from being each caller's own responsibility — cron-scan did its own
// round-robin before calling this, but onboarding.js and share/[token].js
// never did, meaning their first N posts were silently biased toward
// whichever subreddit's request happened to land first. Doing it once,
// centrally, guarantees every caller gets a fair sample regardless of
// whether they remembered to interleave upstream.
function interleaveBySubreddit(posts) {
  const bySubreddit = new Map()
  for (const p of posts) {
    const key = p.subreddit || ''
    if (!bySubreddit.has(key)) bySubreddit.set(key, [])
    bySubreddit.get(key).push(p)
  }
  const buckets = [...bySubreddit.values()]
  const result = []
  for (let i = 0; result.length < posts.length; i++) {
    for (const bucket of buckets) if (bucket[i]) result.push(bucket[i])
  }
  return result
}

// ─── Pass 1: cheap relevance screen ─────────────────────────────────────
// reddit.js requests up to 250 posts per combined multireddit request (up
// from 25/sub via separate requests), though Reddit's .rss endpoint
// silently clamps that to 100 in practice — see reddit.js for the full
// explanation. Either way, running the full sample through the full
// scoring prompt (below) isn't affordable: this pass is what makes that
// tradeoff workable. One cheap call, relevance
// only (0-10, no sub-scores, no reasoning text), deliberately loose cutoff
// — a false positive here just costs a few extra tokens in pass 2, but a
// false negative drops a real lead before the real scoring prompt ever
// sees it. Passive-demand posts in particular (quiet, not phrased as an
// ask) are exactly what a stricter cutoff would wrongly filter here.
const RELEVANCE_THRESHOLD = 2 // out of 10 — intentionally loose, see above

async function relevanceFilter(sample, analysis) {
  const input = sample.map((p, i) => ({
    i,
    title: p.title,
    body: (p.body || '').slice(0, 150),
    sub: p.subreddit,
  }))

  const messages = [
    {
      role: 'system',
      content: 'Fast relevance screen. Return only a valid JSON array. No markdown. No explanation.',
    },
    {
      role: 'user',
      content: `Rate how plausibly relevant EVERY one of these Reddit posts is to this product, on a 0-10 scale. This is a loose first pass, not the real scoring — when in doubt, score it higher rather than lower. Rate every post, even ones that obviously don't fit — do not skip any, do not return [] to mean "nothing fits."

PRODUCT: ${analysis.name}
WHAT IT DOES: ${analysis.description}
SPECIFIC PROBLEMS IT SOLVES: ${analysis.specificProblems?.slice(0, 5).join(' | ') || ''}

0-1 = nothing to do with this product's problem space, even loosely
2-10 = any plausible connection at all — including posts that only quietly mention the problem without explicitly asking for help

Format: [{"i":0,"r":7}]

Posts: ${JSON.stringify(input)}`,
    },
  ]

  console.log('[score:pass1] trying Gemini (primary)')
  let raw = await gemini(messages, 4000, 0.1)

  if (!raw) {
    // gpt-oss-20b and Groq raced concurrently instead of tried one after
    // the other — same reasoning as pass 2 below, applied here too since
    // this fallback chain has the identical sequential-timeout risk.
    console.log('[score:pass1] Gemini empty — racing gpt-oss-20b and Groq')
    raw = await raceForContent([
      { label: 'gpt-oss-20b', promise: gptOss20b(messages, 3000, 0.1) },
      { label: 'groq', promise: groq(messages, 2000, 0.1) },
    ])
  }

  // Previously the only pass-1 visibility was the survivor count — no way
  // to tell "model genuinely rated everything low" apart from some other
  // cause without the actual ratings. Matches pass 2's existing raw-log
  // line below.
  console.log(`[score:pass1] raw (150): ${raw.slice(0, 150)}`)

  const rated = parseJSON(raw)
  if (!rated) {
    // Fail-open: if this cheap pass itself comes back unparseable, don't
    // let a flaky relevance call silently drop every post before pass 2
    // ever runs — send the whole sample through instead. Costs more
    // tokens on a bad day; never silently loses every lead to it.
    console.log('[score:pass1] parse failed — passing full sample through to pass 2 unfiltered')
    return sample
  }

  const relevance = new Map(
    rated.filter(r => typeof r.i === 'number').map(r => [r.i, Number(r.r) || 0])
  )

  // Pairs each post's own title with its index and rating — the raw
  // model-output log above (just {"i":5,"r":4} pairs) gave no way to
  // check a rating against what the post actually said. "(unrated)"
  // marks an index the model skipped despite instructions, which still
  // fails open to r=10 below, same as a parse failure does for the whole
  // batch.
  sample.forEach((p, i) => {
    const r = relevance.has(i) ? relevance.get(i) : 10
    const unrated = relevance.has(i) ? '' : ' (unrated, failed open)'
    console.log(`[score:pass1] i=${i} r=${r}${unrated} — "${(p.title || '').slice(0, 80)}"`)
  })

  // Unrated indices (the model skipped one despite instructions) fail open
  // too, same reasoning as a parse failure above — treated as relevant
  // rather than silently dropped.
  const survivors = sample
    .map((p, i) => ({ post: p, r: relevance.has(i) ? relevance.get(i) : 10 }))
    .filter(x => x.r >= RELEVANCE_THRESHOLD)
    .sort((a, b) => b.r - a.r)
    .map(x => x.post)

  console.log(`[score:pass1] ${sample.length} posts → ${survivors.length} survived (threshold ${RELEVANCE_THRESHOLD})`)
  return survivors
}

async function scorePosts(posts, analysis) {
  // Capped at 250 (was 60) — matches reddit.js's requested limit, even
  // though in practice Reddit's own 100-post ceiling means this rarely
  // slices anything off (a single request currently returns ~100 at
  // most). Every post in this full sample is what scoredUrls (below)
  // marks as "sent to an AI for scoring" in cron-scan's seen_posts dedup —
  // pass 1 genuinely did score all of them, even the ones that don't make
  // it to pass 2.
  const fullSample = interleaveBySubreddit(posts).slice(0, 250)
  const scoredUrls = fullSample.map(p => p.url).filter(Boolean)

  if (!fullSample.length) return { scored: [], closeMatches: [], scoredUrls }

  // ─── Pass 1 — cheap relevance screen over the full up-to-100 sample ───
  const relevant = await relevanceFilter(fullSample, analysis)

  if (!relevant.length) {
    // Confirmed in production (Caloriesai.com, 97 posts → 0 survived):
    // without this, pass 2 still ran — a full Gemini call (including its
    // empty-content retry) spent scoring an empty list, for no reason.
    // scoredUrls still covers the full pass-1 sample above, so these
    // posts are correctly marked seen either way.
    console.log('[score] 0 posts survived pass 1 — skipping pass 2 (nothing to score)')
    return { scored: [], closeMatches: [], scoredUrls }
  }

  // ─── Pass 2 — existing full scoring prompt, completely unchanged below,
  // including this 60-post cap: it's what the max_tokens budgets on
  // gemini/groq/gptOss20b were actually sized for, and pass 1 already did
  // the real work of cutting 250 down to the posts worth that budget —
  // sorted by relevance above, so if more than 60 survive, these are the
  // 60 most promising, not just the first 60 encountered.
  const sample = relevant.slice(0, 60)

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

  // Gemini first — highest-volume call in the app (every cron run, every
  // user), so it needs a fast, reliable primary.
  //
  // gpt-oss-20b and Groq are RACED (raceForContent, above) rather than
  // tried one after the other, since Gemini (primary) → gpt-oss-20b → Groq
  // sequentially meant a bad run could burn each tier's full timeout one
  // after another — confirmed in production: Gemini and gpt-oss-20b both
  // timed out in full (20s each) back to back before Groq finally
  // answered, 40 of the 60s budget gone on two dead ends before the
  // provider that actually worked ever got a chance. Racing the two
  // fallbacks means the worst case is whichever of them is slower, not
  // both summed. Groq still never goes first/alone, though — its own
  // daily token budget has run dry mid-day before (the Aug 20 outage),
  // which is exactly the kind of failure a race against gpt-oss-20b
  // covers for, rather than leaving Groq to carry the whole fallback step
  // by itself again.
  // Previously 6000 / 3800 / 2300 — raised proportionally to the
  // sample-size increase (40→60 posts, ~1.5x) on all three providers, but
  // that scaling was backwards for what each tier actually needs: by the
  // time a call reaches gpt-oss-20b or Groq, it's because Gemini already
  // failed, and each one is the LAST chance for this batch — there's
  // nothing after them to catch a truncation. Giving the final fallback
  // the smallest budget of the three is exactly how Runway's 40 scored
  // posts got lost in production: Groq's 2300-token budget wasn't enough
  // for 40 full objects (each with two free-text fields — problem_text
  // and why — this schema isn't small per post), the response cut off
  // mid-string, and the whole batch failed to parse. All three now get
  // the same generous budget instead of shrinking down the fallback
  // chain — parseJSON's salvage path (above) is the backstop if a
  // response is still cut off at this size.
  console.log('[score] trying Gemini (primary)')
  let raw = await gemini(messages, 6000, 0.1)

  if (!raw) {
    console.log('[score] Gemini empty — racing gpt-oss-20b and Groq')
    raw = await raceForContent([
      { label: 'gpt-oss-20b', promise: gptOss20b(messages, 6000, 0.1) },
      { label: 'groq', promise: groq(messages, 6000, 0.1) },
    ])
  }

  console.log(`[score] raw (150): ${raw.slice(0, 150)}`)

  const scored = parseJSON(raw)
  if (!scored) { console.log('[score] parse failed'); return { scored: [], closeMatches: [], scoredUrls } }

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
