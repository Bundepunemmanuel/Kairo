// og.js — Generates the image shown in link previews (Slack, Twitter,
// iMessage, etc). Two modes:
//   ?token=xxx  → a dark card built from that share: how many people were
//                 found, the product name, and the top-scoring lead's real
//                 post title with its score, stacked over the other matches
//   no token, an expired/unknown one, or a share with no qualified leads
//                 → a generic branded fallback, no fabricated numbers
//
// Layout note: X draws the page's twitter:title as a caption over the
// bottom-left of the image, so nothing important lives in the bottom
// ~130px — the earlier card put its subreddit chips there and they were
// hidden behind that caption.
//
// Edge runtime is required for next/og's ImageResponse.

import { ImageResponse } from 'next/og'
import { createClient } from '@supabase/supabase-js'

export const config = { runtime: 'edge' }

const CREAM = '#f5f0eb'
const INK = '#1a1208'
const RUST = '#c0584a'
const RUST_TEXT = '#8a3b2c'
const RUST_BG = 'rgba(192,88,74,0.12)'

// Reply windows mirror score.js (active demand 3h, passive 6h, counted
// from when the post went up) and the same copy in pages/share/[token].js —
// keep all three in sync. Used only to decide whether the card may carry
// urgency copy: with the 7-day search window, many leads are already past
// their window, and "go cold in hours" must not imply those are fresh.
const windowMinutes = lead => (lead.signalType === 'active' ? 180 : 360)
const isInsideWindow = lead => {
  if (!lead.createdAt) return false
  return (Date.now() - lead.createdAt) / 60000 < windowMinutes(lead)
}

const clip = (str, max) => (str.length > max ? str.slice(0, max - 1).trimEnd() + '…' : str)

// Embeds the real public/logo.png — needs an absolute URL since this runs
// in the edge runtime with no page context, but otherwise this is just
// the same file every other component in the app already references.
function Logo({ textColor, origin }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <img src={`${origin}/logo.png`} width={34} height={34} style={{ display: 'flex' }} />
      <span style={{ display: 'flex', fontSize: 22, fontWeight: 700, color: textColor }}>Kairo</span>
    </div>
  )
}

export default async function handler(req) {
  const { searchParams, origin } = new URL(req.url)
  const token = searchParams.get('token')

  let shareData = null
  if (token) {
    try {
      // Edge runtime — created per-request rather than at module scope,
      // since this route (unlike the Node API routes elsewhere) can't
      // assume a warm shared connection.
      const supabaseAdmin = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY
      )
      const { data } = await supabaseAdmin
        .from('shared_scans')
        .select('analysis, leads, expires_at')
        .eq('token', token)
        .single()
      if (data && new Date(data.expires_at) > new Date()) shareData = data
    } catch {
      shareData = null
    }
  }

  const qualified = (shareData?.leads || []).filter(l => l.tier !== 'close')

  if (shareData && qualified.length > 0) {
    const n = qualified.length
    const top = [...qualified].sort((a, b) => (b.score || 0) - (a.score || 0))[0]
    const urgent = qualified.some(isInsideWindow)
    const name = clip(shareData.analysis?.name || 'this product', 22)
    const subject = `${n} ${n === 1 ? 'person' : 'people'} on Reddit${urgent ? '' : ' this week'} ${n === 1 ? 'has' : 'have'} the problem`
    const score = Math.round(Math.min(100, Math.max(0, top.score || 0)))
    const circumference = 2 * Math.PI * 26
    const offset = circumference * (1 - score / 100)
    const behind = Math.min(n - 1, 2) // cards peeking out behind the top lead

    return new ImageResponse(
      (
        <div style={{
          width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
          background: INK, padding: '52px 72px 0',
        }}>
          <Logo textColor={CREAM} origin={origin} />

          <div style={{ display: 'flex', alignItems: 'center', marginTop: 26, height: 400 }}>
            <div style={{ display: 'flex', flexDirection: 'column', width: 540, marginRight: 56 }}>
              <div style={{ display: 'flex', fontSize: 46, fontWeight: 700, color: CREAM, lineHeight: 1.18 }}>
                {subject}
              </div>
              <div style={{ display: 'flex', fontSize: 46, fontWeight: 700, color: RUST, lineHeight: 1.18 }}>
                {name} solves
              </div>
              {urgent && (
                <div style={{
                  display: 'flex', alignSelf: 'flex-start', marginTop: 26, fontSize: 21,
                  padding: '9px 22px', borderRadius: 30,
                  background: 'rgba(192,88,74,0.2)', color: '#e79684',
                }}>
                  Leads like these go cold in 3–6 hours
                </div>
              )}
            </div>

            <div style={{ display: 'flex', position: 'relative', width: 460, height: 326 }}>
              {behind >= 2 && (
                <div style={{
                  position: 'absolute', display: 'flex', left: 28, top: 30, width: 424, height: 250,
                  background: CREAM, opacity: 0.22, borderRadius: 18,
                }} />
              )}
              {behind >= 1 && (
                <div style={{
                  position: 'absolute', display: 'flex', left: 14, top: 15, width: 424, height: 250,
                  background: CREAM, opacity: 0.45, borderRadius: 18,
                }} />
              )}
              <div style={{
                position: 'absolute', display: 'flex', flexDirection: 'column', left: 0, top: 0,
                width: 424, height: 250, background: CREAM, borderRadius: 18, padding: '22px 24px',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{
                    display: 'flex', fontSize: 19, padding: '5px 15px', borderRadius: 20,
                    background: RUST_BG, color: RUST_TEXT,
                  }}>
                    r/{top.subreddit}
                  </div>
                  <div style={{ display: 'flex', position: 'relative', width: 64, height: 64, alignItems: 'center', justifyContent: 'center' }}>
                    <div style={{ display: 'flex', position: 'absolute', top: 0, left: 0 }}>
                      <svg width="64" height="64" viewBox="0 0 64 64">
                        <circle cx="32" cy="32" r="26" fill="none" stroke="rgba(192,88,74,0.2)" stroke-width="6" />
                        <circle
                          cx="32" cy="32" r="26" fill="none" stroke="#c0584a" stroke-width="6"
                          stroke-linecap="round" stroke-dasharray={circumference} stroke-dashoffset={offset}
                          transform="rotate(-90 32 32)"
                        />
                      </svg>
                    </div>
                    <div style={{ display: 'flex', fontSize: 22, fontWeight: 700, color: RUST_TEXT }}>{score}</div>
                  </div>
                </div>
                <div style={{ display: 'flex', marginTop: 14, fontSize: 27, fontWeight: 700, color: INK, lineHeight: 1.3 }}>
                  {clip(top.title || '', 96)}
                </div>
              </div>
              {behind > 0 && (
                <div style={{
                  position: 'absolute', display: 'flex', right: 0, bottom: 0,
                  fontSize: 21, color: 'rgba(245,240,235,0.6)',
                }}>
                  +{n - 1} more {n - 1 === 1 ? 'match' : 'matches'}
                </div>
              )}
            </div>
          </div>
        </div>
      ),
      { width: 1200, height: 630 }
    )
  }

  // ── Default fallback — homepage shares, an expired/unknown token, or a
  // share with only close matches (never lead with a weaker lead) ──
  return new ImageResponse(
    (
      <div style={{
        width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
        justifyContent: 'space-between', background: INK, padding: '64px 72px',
      }}>
        <Logo textColor={CREAM} origin={origin} />

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', fontSize: 58, fontWeight: 700, color: CREAM, lineHeight: 1.2, maxWidth: 1000 }}>
            Your next customer is on Reddit right now
          </div>
          <div style={{ display: 'flex', fontSize: 28, color: 'rgba(245,240,235,0.6)', marginTop: 18, maxWidth: 820 }}>
            Kairo finds people already asking for what you sell
          </div>
          <div style={{
            display: 'flex', alignSelf: 'flex-start', alignItems: 'center', gap: 8, marginTop: 30,
            fontSize: 18, padding: '9px 22px', borderRadius: 30,
            background: 'rgba(192,88,74,0.2)', color: '#e79684',
          }}>
            🎯 High-intent leads, every day
          </div>
        </div>

        <div style={{ display: 'flex' }} />
      </div>
    ),
    { width: 1200, height: 630 }
  )
}
