import { useState, useEffect } from 'react'
import Link from 'next/link'
import Head from 'next/head'
import { useRouter } from 'next/router'
import { supabase } from '../lib/supabase'
import { useAuth } from './_app'

const PLAN_LABELS = { free: 'Free', starter: 'Starter', pro: 'Pro', unlimited: 'Unlimited' }
const ADMIN_EMAIL = 'bundepunemmanuel@gmail.com'

export default function Archive() {
  const { user, loading: authLoading } = useAuth()
  const router = useRouter()

  const [plan, setPlan] = useState('free')
  const [profile, setProfile] = useState(null)
  const [repliedLeads, setRepliedLeads] = useState([])
  const [deletedLeads, setDeletedLeads] = useState([])
  const [convoLeads, setConvoLeads] = useState([]) // replied=true, conversation_status='open'
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('replied')

  // Conversation detail view
  const [selectedConvoId, setSelectedConvoId] = useState(null)
  const [confirmBox, setConfirmBox] = useState(null) // { leadId, text }
  const [confirmSaving, setConfirmSaving] = useState(false)
  const [theirReplyInput, setTheirReplyInput] = useState({})
  const [followupLoading, setFollowupLoading] = useState({})

  useEffect(() => {
    if (!authLoading && !user) router.replace('/login')
  }, [user, authLoading, router])

  useEffect(() => {
    if (!user) return
    loadData()
  }, [user])

  const loadData = async () => {
    setLoading(true)
    try {
      const { data: planData } = await supabase
        .from('user_plans')
        .select('plan')
        .eq('user_id', user.id)
        .single()
      setPlan(planData?.plan || 'free')

      const { data: profileData } = await supabase
        .from('product_profiles')
        .select('*')
        .eq('user_id', user.id)
        .single()
      setProfile(profileData)

      const { data: replied } = await supabase
        .from('leads')
        .select('*')
        .eq('user_id', user.id)
        .eq('replied', true)
        .order('scanned_at', { ascending: false })
      setRepliedLeads(replied || [])

      const { data: deleted } = await supabase
        .from('leads')
        .select('*')
        .eq('user_id', user.id)
        .eq('deleted', true)
        .eq('replied', false)
        .order('scanned_at', { ascending: false })
      setDeletedLeads(deleted || [])

      const { data: convos } = await supabase
        .from('leads')
        .select('*')
        .eq('user_id', user.id)
        .eq('deleted', false)
        .eq('replied', true)
        .eq('conversation_status', 'open')
        .order('scanned_at', { ascending: false })
      setConvoLeads(convos || [])
    } catch (e) {
      console.log('[archive] load error:', e.message)
    } finally {
      setLoading(false)
    }
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.push('/')
  }

  const handleRestore = async (leadId) => {
    setRepliedLeads(prev => prev.filter(l => l.id !== leadId))
    setDeletedLeads(prev => prev.filter(l => l.id !== leadId))
    const { error } = await supabase.from('leads').update({ replied: false, deleted: false }).eq('id', leadId)
    if (error) { console.log('[archive] restore error:', error.message); await loadData() }
  }

  const handleOpenFollowupConfirmBox = (lead, draftText) => {
    setConfirmBox({ leadId: lead.id, text: draftText })
  }

  const handleConfirmSent = async (lead) => {
    if (!confirmBox || confirmBox.leadId !== lead.id) return
    const finalText = confirmBox.text.trim()
    if (!finalText) return

    setConfirmSaving(true)
    try {
      const existingConvo = Array.isArray(lead.conversation) ? lead.conversation : []
      const newConvo = [...existingConvo, { role: 'sent', text: finalText, at: new Date().toISOString() }]

      const { error } = await supabase
        .from('leads')
        .update({ conversation: newConvo })
        .eq('id', lead.id)
      if (error) throw error

      setConfirmBox(null)
      setConvoLeads(prev => prev.map(l => l.id === lead.id ? { ...l, conversation: newConvo } : l))
    } catch (e) {
      console.log('[archive] confirm sent error:', e.message)
    } finally {
      setConfirmSaving(false)
    }
  }

  const handleSubmitTheirReply = async (lead) => {
    const theirText = (theirReplyInput[lead.id] || '').trim()
    if (!theirText) return

    setFollowupLoading(prev => ({ ...prev, [lead.id]: true }))
    try {
      const existingConvo = Array.isArray(lead.conversation) ? lead.conversation : []
      const convoWithTheirReply = [...existingConvo, { role: 'them', text: theirText, at: new Date().toISOString() }]

      const res = await fetch('/api/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          post: { title: lead.title, body: lead.body, subreddit: lead.subreddit },
          analysis: profile?.analysis,
          signalType: lead.signal_type,
          specificProblem: lead.specific_problem,
          conversation: convoWithTheirReply,
        }),
      })
      const data = await res.json()
      const status = data.status === 'closed' ? 'closed' : 'open'

      await supabase
        .from('leads')
        .update({ conversation: convoWithTheirReply, conversation_status: status })
        .eq('id', lead.id)

      setTheirReplyInput(prev => ({ ...prev, [lead.id]: '' }))

      if (status === 'closed') {
        setConvoLeads(prev => prev.filter(l => l.id !== lead.id))
        setSelectedConvoId(null)
      } else {
        setConvoLeads(prev => prev.map(l => l.id === lead.id ? { ...l, conversation: convoWithTheirReply } : l))
        if (data.reply) {
          handleOpenFollowupConfirmBox({ ...lead, conversation: convoWithTheirReply }, data.reply)
        }
      }
    } catch (e) {
      console.log('[archive] follow-up error:', e.message)
    } finally {
      setFollowupLoading(prev => ({ ...prev, [lead.id]: false }))
    }
  }

  const lastMessagePreview = (lead) => {
    const convo = Array.isArray(lead.conversation) ? lead.conversation : []
    if (!convo.length) return 'No messages yet'
    const last = convo[convo.length - 1]
    const prefix = last.role === 'sent' ? 'You: ' : ''
    return prefix + last.text
  }

  const lastMessageTime = (lead) => {
    const convo = Array.isArray(lead.conversation) ? lead.conversation : []
    if (!convo.length) return lead.scanned_at
    return convo[convo.length - 1].at
  }

  const formatRelativeShort = (ts) => {
    const diffMs = Date.now() - new Date(ts).getTime()
    const mins = Math.floor(diffMs / 60000)
    if (mins < 1) return 'now'
    if (mins < 60) return `${mins}m`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return `${hours}h`
    const days = Math.floor(hours / 24)
    return `${days}d`
  }

  const formatDate = ts => {
    const d = new Date(ts)
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  }

  if (authLoading || loading) {
    return (
      <div className="dash-loading">
        <div className="dash-loading-inner"><p>Loading archive...</p></div>
      </div>
    )
  }

  const currentList = tab === 'replied' ? repliedLeads : deletedLeads

  return (
    <>
      <Head>
        <title>Archive — Kairo</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,700;0,900;1,700&family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet" />
      </Head>

      <div className="dash-page">
        <AppNav user={user} plan={plan} active="archive" onSignOut={handleSignOut} />

        <div className="archive-container">
          <h1 className="settings-page-title">Archive</h1>
          <p className="archive-sub">Leads you've replied to or removed. Restoring a lead moves it back to your active dashboard.</p>

          <div className="archive-tabs">
            <button className={tab === 'replied' ? 'archive-tab active' : 'archive-tab'} onClick={() => { setTab('replied'); setSelectedConvoId(null) }}>
              ✓ Replied ({repliedLeads.length})
            </button>
            <button className={tab === 'deleted' ? 'archive-tab active' : 'archive-tab'} onClick={() => { setTab('deleted'); setSelectedConvoId(null) }}>
              ✕ Deleted ({deletedLeads.length})
            </button>
            <button className={tab === 'conversations' ? 'archive-tab active' : 'archive-tab'} onClick={() => setTab('conversations')}>
              💬 Conversations ({convoLeads.length})
            </button>
          </div>

          {tab === 'conversations' ? (
            selectedConvoId ? (
              // ─── Detail view: one conversation, full thread ──────────
              (() => {
                const lead = convoLeads.find(l => l.id === selectedConvoId)
                if (!lead) return null
                const convo = Array.isArray(lead.conversation) ? lead.conversation : []
                const isFollowupLoading = followupLoading[lead.id]
                return (
                  <div className="convo-detail">
                    <button className="convo-back-btn" onClick={() => setSelectedConvoId(null)}>← Back to conversations</button>

                    <div className="convo-detail-header">
                      <h3 className="dash-lead-title">{lead.title}</h3>
                      <span className="dash-lead-sub">r/{lead.subreddit}</span>
                    </div>

                    <div className="dash-convo-thread">
                      {convo.map((m, idx) => (
                        <div key={idx} className={`dash-convo-msg dash-convo-msg-${m.role}`}>
                          <span className="dash-convo-msg-label">{m.role === 'sent' ? 'You said' : 'They replied'}</span>
                          <p>{m.text}</p>
                        </div>
                      ))}
                    </div>

                    {confirmBox?.leadId === lead.id ? (
                      <div className="dash-confirm-box">
                        <span className="dash-confirm-label">Kairo's suggested next reply — edit if needed</span>
                        <textarea
                          className="dash-confirm-textarea"
                          value={confirmBox.text}
                          onChange={e => setConfirmBox(prev => ({ ...prev, text: e.target.value }))}
                          rows={4}
                        />
                        <div className="dash-confirm-actions">
                          <button className="dash-btn-primary" onClick={() => handleConfirmSent(lead)} disabled={confirmSaving || !confirmBox.text.trim()}>
                            {confirmSaving ? 'Saving...' : '✓ Confirm Sent'}
                          </button>
                          <button className="dash-btn-secondary" onClick={() => setConfirmBox(null)}>Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <div className="dash-convo-input">
                        <textarea
                          className="dash-confirm-textarea"
                          placeholder="Paste what they replied with..."
                          value={theirReplyInput[lead.id] || ''}
                          onChange={e => setTheirReplyInput(prev => ({ ...prev, [lead.id]: e.target.value }))}
                          rows={3}
                        />
                        <button
                          className="dash-btn-primary"
                          onClick={() => handleSubmitTheirReply(lead)}
                          disabled={isFollowupLoading || !(theirReplyInput[lead.id] || '').trim()}
                        >
                          {isFollowupLoading ? 'Thinking...' : 'Submit their reply →'}
                        </button>
                      </div>
                    )}
                  </div>
                )
              })()
            ) : (
              // ─── List view: compact rows, WhatsApp-style ─────────────
              convoLeads.length === 0 ? (
                <div className="dash-no-leads">
                  <p>No active conversations. They'll show up here once you mark a lead as replied.</p>
                </div>
              ) : (
                <div className="convo-list">
                  {convoLeads.map(lead => (
                    <button key={lead.id} className="convo-row" onClick={() => setSelectedConvoId(lead.id)}>
                      <div className="convo-row-icon">{(lead.subreddit || '?')[0].toUpperCase()}</div>
                      <div className="convo-row-info">
                        <span className="convo-row-title">{lead.title}</span>
                        <span className="convo-row-preview">{lastMessagePreview(lead)}</span>
                      </div>
                      <span className="convo-row-time">{formatRelativeShort(lastMessageTime(lead))}</span>
                    </button>
                  ))}
                </div>
              )
            )
          ) : currentList.length === 0 ? (
            <div className="dash-no-leads">
              <p>{tab === 'replied' ? "You haven't marked any leads as replied yet." : "You haven't deleted any leads yet."}</p>
            </div>
          ) : (
            <div className="archive-list">
              {currentList.map(lead => (
                <div key={lead.id} className="archive-card">
                  <div className="archive-card-meta">
                    <span className="dash-lead-sub">r/{lead.subreddit}</span>
                    <span className="dash-lead-score">Score: {Number(lead.score).toFixed(1)}</span>
                    <span className="archive-card-date">{formatDate(lead.scanned_at)}</span>
                  </div>
                  <p className="archive-card-title">{lead.title}</p>
                  <div className="archive-card-actions">
                    <a href={lead.url} target="_blank" rel="noopener noreferrer" className="archive-card-link">Open in Reddit ↗</a>
                    <button className="archive-restore-btn" onClick={() => handleRestore(lead.id)}>↺ Restore to active</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  )
}

function AppNav({ user, plan, active, onSignOut }) {
  const isAdmin = user?.email === ADMIN_EMAIL
  return (
    <nav className="app-nav">
      <div className="app-nav-top">
        <Link href="/dashboard" className="app-nav-logo">
          <KairoLogo size={22} />
          <span>Kairo</span>
        </Link>
        <div className="app-nav-right">
          <span className="app-nav-plan-badge">{PLAN_LABELS[plan] || 'Free'}</span>
          <button className="app-nav-signout" onClick={onSignOut}>Sign out</button>
        </div>
      </div>
      <div className="app-nav-tabs-wrap">
        <div className="app-nav-tabs">
          <Link href="/dashboard" className={active === 'dashboard' ? 'app-nav-tab active' : 'app-nav-tab'}>Dashboard</Link>
          <Link href="/archive" className={active === 'archive' ? 'app-nav-tab active' : 'app-nav-tab'}>Archive</Link>
          <Link href="/settings" className={active === 'settings' ? 'app-nav-tab active' : 'app-nav-tab'}>Settings</Link>
          <Link href="/billing" className={active === 'billing' ? 'app-nav-tab active' : 'app-nav-tab'}>Billing</Link>
          {isAdmin && <Link href="/admin" className={active === 'admin' ? 'app-nav-tab active' : 'app-nav-tab'}>Admin</Link>}
        </div>
      </div>
    </nav>
  )
}

function KairoLogo({ size = 24 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none">
      <rect x="10" y="38" width="45" height="10" rx="5" fill="#c0584a" opacity="0.6" />
      <rect x="20" y="52" width="45" height="10" rx="5" fill="#c0584a" opacity="0.8" />
      <rect x="15" y="66" width="45" height="10" rx="5" fill="#c0584a" opacity="0.7" />
      <circle cx="76" cy="57" r="18" fill="#c0584a" />
    </svg>
  )
}
