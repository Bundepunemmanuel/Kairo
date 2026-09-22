// og.js — Generates the image shown in link previews (Slack, Twitter,
// iMessage, etc). Two modes:
//   ?token=xxx  → real numbers from that share: qualified lead count,
//                 product name, actual subreddits scanned (light/cream card)
//   no token, or an expired/unknown one → a generic branded fallback, dark
//                 background, no fabricated numbers or captured leads
//
// Edge runtime is required for next/og's ImageResponse.

import { ImageResponse } from 'next/og'
import { createClient } from '@supabase/supabase-js'

export const config = { runtime: 'edge' }

const CREAM = '#f5f0eb'
const INK = '#1a1208'
const INK_MUTED = '#8a7a65'
const RUST = '#c0584a'
const RUST_TEXT = '#8a3b2c'
const RUST_BG = 'rgba(192,88,74,0.12)'

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

  if (shareData) {
    const leads = shareData.leads || []
    const qualified = leads.filter(l => l.tier !== 'close')
    const subreddits = [...new Set(leads.map(l => l.subreddit).filter(Boolean))].slice(0, 3)
    const headline = qualified.length > 0
      ? `${qualified.length} qualified ${qualified.length === 1 ? 'lead' : 'leads'} found`
      : 'Kairo is watching for leads'

    return new ImageResponse(
      (
        <div style={{
          width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
          justifyContent: 'space-between', background: CREAM, padding: '64px 72px',
        }}>
          <Logo textColor={INK} origin={origin} />
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', fontSize: 66, fontWeight: 700, color: INK, lineHeight: 1.15 }}>
              {headline}
            </div>
            <div style={{ display: 'flex', fontSize: 30, color: INK_MUTED, marginTop: 14 }}>
              for {shareData.analysis?.name || 'this product'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            {subreddits.map(sr => (
              <div key={sr} style={{
                display: 'flex', fontSize: 20, padding: '8px 22px', borderRadius: 30,
                background: RUST_BG, color: RUST_TEXT,
              }}>
                r/{sr}
              </div>
            ))}
          </div>
        </div>
      ),
      { width: 1200, height: 630 }
    )
  }

  // ── Default fallback — homepage shares, or an expired/unknown token ──
  // Dark background, no example card: headline + subheadline carry the
  // whole thing, with one small badge instead of a full mocked lead card.
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
