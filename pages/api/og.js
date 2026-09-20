// og.js — Generates the image shown in link previews (Slack, Twitter,
// iMessage, etc). Two modes:
//   ?token=xxx  → real numbers from that share: qualified lead count,
//                 product name, actual subreddits scanned
//   no token, or an expired/unknown one → a generic branded fallback with
//                 an illustrative example card (NOT a real captured lead —
//                 deliberately generic so it never misrepresents a
//                 specific real post as something it isn't)
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

function Logo() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ display: 'flex', width: 28, height: 28, borderRadius: 6, background: RUST }} />
      <span style={{ fontSize: 22, fontWeight: 700, color: INK }}>Kairo</span>
    </div>
  )
}

export default async function handler(req) {
  const { searchParams } = new URL(req.url)
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
          <Logo />
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
  return new ImageResponse(
    (
      <div style={{
        width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
        justifyContent: 'space-between', background: CREAM, padding: '56px 72px',
      }}>
        <Logo />

        <div style={{
          display: 'flex', flexDirection: 'column', background: 'white', borderRadius: 16,
          padding: '28px 32px', border: `1px solid rgba(26,18,8,0.1)`, maxWidth: 640,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <div style={{ display: 'flex', fontSize: 16, padding: '4px 14px', borderRadius: 20, background: RUST_BG, color: RUST_TEXT }}>
              r/SaaS
            </div>
            <div style={{ display: 'flex', fontSize: 16, color: INK_MUTED }}>Score: 94.0</div>
          </div>
          <div style={{ display: 'flex', fontSize: 27, fontWeight: 700, color: INK, marginBottom: 10 }}>
            Finding clients
          </div>
          <div style={{ display: 'flex', fontSize: 18, color: '#5c5346', lineHeight: 1.5 }}>
            &quot;How do you find clients that may really be interested in what you built?&quot;
          </div>
          <div style={{ display: 'flex', marginTop: 16, fontSize: 16, color: RUST_TEXT, fontWeight: 600 }}>
            🎯 High-intent match
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', fontSize: 48, fontWeight: 700, color: INK, lineHeight: 1.2 }}>
            Your next customer is on Reddit right now
          </div>
          <div style={{ display: 'flex', fontSize: 24, color: INK_MUTED, marginTop: 10 }}>
            Kairo finds posts like this and drafts your reply
          </div>
        </div>
      </div>
    ),
    { width: 1200, height: 630 }
  )
}
