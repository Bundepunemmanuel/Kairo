// debug.js — Temporary page to diagnose scoring. Remove before launch.
// Visit /debug to use

import { useState } from 'react'

function parseAtom(xml, subreddit) {
  const posts = []
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)]
  for (const m of entries) {
    const entry = m[1]
    const title = (entry.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1]
      ?.replace(/<!\[CDATA\[|\]\]>/g, '')?.trim() ?? ''
    const link = (entry.match(/<link[^>]*href="([^"]+)"/) || [])[1]?.trim() ?? ''
    const rawContent = (entry.match(/<content[^>]*>([\s\S]*?)<\/content>/) || [])[1] || ''
    const content = rawContent
      .replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&[^;]{1,6};/g, ' ').replace(/<!--.*?-->/gs, '')
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600)
    const published = (entry.match(/<published>([\s\S]*?)<\/published>/) || [])[1] || ''
    if (!title || !link.includes('/comments/')) continue
    const urlParts = link.split('/')
    const commentsIdx = urlParts.indexOf('comments')
    const postId = commentsIdx !== -1 ? urlParts[commentsIdx + 1] : urlParts.filter(Boolean).pop()
    posts.push({
      id: postId || Math.random().toString(36).slice(2),
      title: title.trim(), body: content, url: link.trim(), subreddit,
      createdAt: published ? new Date(published).getTime() : Date.now(),
    })
  }
  return posts
}

async function fetchSub(subreddit) {
  try {
    const res = await fetch(`/api/reddit?sub=${encodeURIComponent(subreddit)}&sort=new`, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) return []
    const xml = await res.text()
    if (!xml.includes('<entry>')) return []
    return parseAtom(xml, subreddit)
  } catch { return [] }
}

export default function Debug() {
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')

  const run = async () => {
    setLoading(true)
    setResult(null)
    setError('')
    try {
      const clean = url.startsWith('http') ? url : `https://${url}`

      const aRes = await fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: clean }) })
      const { analysis } = await aRes.json()

      const subreddits = (analysis.subreddits || []).slice(0, 6)
      const postArrays = await Promise.all(subreddits.map(fetchSub))
      const allPosts = postArrays.flat().filter(p => p.body && p.body.length > 40 && !p.body.includes('[comments]'))

      const dRes = await fetch('/api/debug-scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ posts: allPosts, analysis }) })
      const data = await dRes.json()
      setResult({ ...data, allPostCount: allPosts.length })
    } catch (e) {
      setError(e.message)
    }
    setLoading(false)
  }

  let scores = []
  if (result?.rawGroqResponse) {
    try {
      const clean = result.rawGroqResponse.replace(/```json|```/g, '').trim()
      const match = clean.match(/\[[\s\S]*\]/)
      if (match) scores = JSON.parse(match[0])
    } catch {}
  }

  return (
    <div style={{ fontFamily: 'monospace', padding: 20, maxWidth: 900, margin: '0 auto', fontSize: 13 }}>
      <h1 style={{ fontSize: 18, marginBottom: 16 }}>🔍 Kairo Debug Scanner</h1>

      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        <input value={url} onChange={e => setUrl(e.target.value)} placeholder="notion.so" style={{ flex: 1, padding: '8px 12px', border: '1px solid #ccc', borderRadius: 6, fontSize: 13 }} onKeyDown={e => e.key === 'Enter' && run()} />
        <button onClick={run} disabled={loading} style={{ padding: '8px 16px', background: '#c0584a', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
          {loading ? 'Scanning...' : 'Run Debug Scan'}
        </button>
      </div>

      {error && <div style={{ color: 'red', marginBottom: 12 }}>Error: {error}</div>}

      {result && (
        <div>
          {/* Analysis */}
          <section style={{ marginBottom: 20, background: '#f5f5f5', padding: 12, borderRadius: 8 }}>
            <h2 style={{ fontSize: 14, marginBottom: 8 }}>📦 Product Analysis</h2>
            <div><b>Name:</b> {result.analysis.name}</div>
            <div><b>Subreddits:</b> {result.analysis.subreddits?.join(', ')}</div>
            <div><b>Specific Problems:</b></div>
            <ul style={{ margin: '4px 0 8px 16px' }}>{result.analysis.specificProblems?.map((p, i) => <li key={i}>{p}</li>)}</ul>
            <div><b>Problem Keywords:</b> {result.analysis.problemKeywords?.join(', ')}</div>
            <div><b>False Positive Signals:</b> {result.analysis.falsePositiveSignals?.join(', ')}</div>
            <div style={{ marginTop: 6 }}><b>Posts fetched:</b> {result.allPostCount}</div>
          </section>

          {/* Sample posts */}
          <section style={{ marginBottom: 20 }}>
            <h2 style={{ fontSize: 14, marginBottom: 8 }}>📋 Sample Posts (first 10)</h2>
            {result.samplePosts?.map((p, i) => (
              <div key={i} style={{ border: '1px solid #ddd', borderRadius: 6, padding: 10, marginBottom: 8 }}>
                <div style={{ fontWeight: 'bold' }}>[{p.subreddit}] {p.title}</div>
                <div style={{ color: '#666', marginTop: 4 }}>{p.body?.slice(0, 150)}...</div>
                <div style={{ color: '#999', fontSize: 11, marginTop: 4 }}>{p.ageMinutes}m old</div>
              </div>
            ))}
          </section>

          {/* Scores */}
          <section>
            <h2 style={{ fontSize: 14, marginBottom: 8 }}>🎯 Groq Scores ({scores.length} posts scored)</h2>
            {scores.length === 0 && <div style={{ color: 'red' }}>⚠️ Groq returned no scores — raw response below</div>}
            {scores.sort((a, b) => b.score - a.score).map((s, i) => {
              const post = result.samplePosts?.[s.index]
              return (
                <div key={i} style={{ border: `2px solid ${s.score >= 5 ? '#4caf50' : s.rejected ? '#f44336' : '#ff9800'}`, borderRadius: 6, padding: 10, marginBottom: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ fontWeight: 'bold' }}>Score: {s.score} — {s.signalType}</span>
                    <span style={{ color: s.rejected ? '#f44336' : '#4caf50' }}>{s.rejected ? '❌ REJECTED' : '✅ QUALIFIED'}</span>
                  </div>
                  <div style={{ marginTop: 4 }}><b>Post:</b> {result.allPostCount > 10 ? `[index ${s.index}]` : post?.title || `index ${s.index}`}</div>
                  {s.specificProblem && <div><b>Problem:</b> {s.specificProblem}</div>}
                  <div><b>Reason:</b> {s.reason}</div>
                  {s.rejectionReason && <div style={{ color: '#f44336' }}><b>Rejected because:</b> {s.rejectionReason}</div>}
                </div>
              )
            })}

            {scores.length === 0 && (
              <details style={{ marginTop: 12 }}>
                <summary style={{ cursor: 'pointer', color: '#666' }}>Raw Groq response</summary>
                <pre style={{ background: '#f5f5f5', padding: 10, borderRadius: 6, overflow: 'auto', fontSize: 11, marginTop: 8 }}>{result.rawGroqResponse}</pre>
              </details>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
