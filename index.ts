// Supabase Edge Function — cron-scan
// Runs every 30 minutes via pg_cron
// For each user under their daily quota: fetch fresh Reddit posts using their
// SAVED analysis (no Jina/Groq analyze call), score them, append new leads.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const GROQ_API_KEY = Deno.env.get('GROQ_API_KEY')!
const NEXTJS_BASE_URL = Deno.env.get('NEXTJS_BASE_URL')! // e.g. https://kairo-omega.vercel.app

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

const PLAN_LIMITS: Record<string, number> = {
  free: 3,
  starter: 10,
  pro: 50,
  unlimited: 999999,
}

// ─── Reddit RSS fetching (Deno-compatible, no Next.js route needed) ───────
function parseAtom(xml: string, subreddit: string) {
  const posts = []
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)]
  for (const m of entries) {
    const entry = m[1]
    const title = (entry.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1]
      ?.replace(/<!\[CDATA\[|\]\]>/g, '')?.trim() ?? ''
    const link = (entry.match(/<link[^>]*href="([^"]+)"/) || [])[1]?.trim() ?? ''
    const rawContent = (entry.match(/<content[^>]*>([\s\S]*?)<\/content>/) || [])[1] || ''
    const content = rawContent
      .replace(/<!\[CDATA\[|\]\]>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&[^;]{1,6};/g, ' ').replace(/<!--.*?-->/gs, '')
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600)
    const published = (entry.match(/<published>([\s\S]*?)<\/published>/) || [])[1] || ''
    if (!title || !link.includes('/comments/')) continue
    const urlParts = link.split('/')
    const commentsIdx = urlParts.indexOf('comments')
    const postId = commentsIdx !== -1 ? urlParts[commentsIdx + 1] : urlParts.filter(Boolean).pop()
    posts.push({
      id: postId || Math.random().toString(36).slice(2),
      title: title.trim(),
      body: content,
      url: link.trim(),
      subreddit,
      createdAt: published ? new Date(published).getTime() : Date.now(),
    })
  }
  return posts
}

async function fetchSubreddit(subreddit: string) {
  const sorts = ['new', 'hot']
  for (const sort of sorts) {
    try {
      const res = await fetch(`https://www.reddit.com/r/${subreddit}/${sort}.rss?limit=25`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        signal: AbortSignal.timeout(10000),
      })
      const text = await res.text()
      if (!text.includes('<entry>')) continue
      return parseAtom(text, subreddit)
    } catch {
      continue
    }
  }
  return []
}

// ─── Scoring (calls existing Next.js /api/score route — reuses all the prompt logic) ───
async function scorePosts(posts: any[], analysis: any) {
  try {
    const res = await fetch(`${NEXTJS_BASE_URL}/api/score`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ posts, analysis }),
    })
    const data = await res.json()
    return data.leads || []
  } catch (e) {
    console.log('[cron-scan] score error:', e.message)
    return []
  }
}

// ─── Main handler ──────────────────────────────────────────────────────
Deno.serve(async (req) => {
  console.log('[cron-scan] starting run at', new Date().toISOString())

  try {
    // Get all users with a saved product profile
    const { data: profiles, error: profilesErr } = await supabase
      .from('product_profiles')
      .select('user_id, url, analysis')

    if (profilesErr) throw profilesErr
    if (!profiles?.length) {
      console.log('[cron-scan] no profiles found')
      return new Response(JSON.stringify({ processed: 0 }), { status: 200 })
    }

    console.log(`[cron-scan] found ${profiles.length} profiles to check`)

    let processedCount = 0
    let skippedCount = 0

    for (const profile of profiles) {
      const userId = profile.user_id

      // Get user's plan
      const { data: planRow } = await supabase
        .from('user_plans')
        .select('plan')
        .eq('user_id', userId)
        .single()

      const plan = planRow?.plan || 'free'
      const limit = PLAN_LIMITS[plan] ?? 3

      // Count leads created for this user in the last 24 hours
      // IMPORTANT: count ALL leads regardless of deleted flag — deletion doesn't refund quota
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      const { count } = await supabase
        .from('leads')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .gte('scanned_at', twentyFourHoursAgo)

      const leadsToday = count || 0

      if (leadsToday >= limit) {
        console.log(`[cron-scan] user ${userId} (${plan}) at quota: ${leadsToday}/${limit} — skipping`)
        skippedCount++
        continue
      }

      const remainingQuota = limit - leadsToday

      // Fetch fresh Reddit posts using the SAVED analysis — no Jina, no analyze call
      const analysis = profile.analysis
      const subreddits = (analysis.subreddits || []).slice(0, 6)
      const postArrays = await Promise.all(subreddits.map(fetchSubreddit))
      const allPosts = postArrays.flat().filter((p: any) =>
        p.body && p.body.length > 40 && !p.body.includes('[comments]')
      )

      if (!allPosts.length) {
        console.log(`[cron-scan] user ${userId}: no posts fetched`)
        continue
      }

      // Score against saved analysis
      const scoredLeads = await scorePosts(allPosts, analysis)

      if (!scoredLeads.length) {
        console.log(`[cron-scan] user ${userId}: no qualifying leads this run`)
        continue
      }

      // Only take up to remaining quota
      const leadsToInsert = scoredLeads.slice(0, remainingQuota)

      // Avoid inserting duplicate posts (same post_id already exists for this user)
      const { data: existingLeads } = await supabase
        .from('leads')
        .select('post_id')
        .eq('user_id', userId)

      const existingIds = new Set((existingLeads || []).map((l: any) => l.post_id))
      const newLeads = leadsToInsert.filter((lead: any) => !existingIds.has(lead.id || lead.url))

      if (!newLeads.length) {
        console.log(`[cron-scan] user ${userId}: all leads already seen, no new inserts`)
        continue
      }

      // APPEND new leads — never delete old ones (per product requirement)
      const { error: insertErr } = await supabase.from('leads').insert(
        newLeads.map((lead: any) => ({
          user_id: userId,
          post_id: lead.id || lead.url,
          title: lead.title,
          body: lead.body || '',
          url: lead.url,
          subreddit: lead.subreddit,
          score: lead.score,
          signal_type: lead.signalType,
          specific_problem: lead.specificProblem || '',
          reason: lead.reason || '',
          created_at_post: lead.createdAt || Date.now(),
          deleted: false,
          replied: false,
        }))
      )

      if (insertErr) {
        console.log(`[cron-scan] user ${userId} insert error:`, insertErr.message)
        continue
      }

      console.log(`[cron-scan] user ${userId} (${plan}): added ${newLeads.length} new leads (${leadsToday + newLeads.length}/${limit} today)`)
      processedCount++
    }

    console.log(`[cron-scan] run complete: ${processedCount} processed, ${skippedCount} skipped (quota)`)

    return new Response(
      JSON.stringify({ processed: processedCount, skipped: skippedCount, total: profiles.length }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    console.error('[cron-scan] fatal error:', err.message)
    return new Response(JSON.stringify({ error: err.message }), { status: 500 })
  }
})
