// delete-account.js — Actually deletes a user's auth account and all
// their data. Must run server-side with the service role key — the
// client-side supabase.auth.admin API doesn't exist on the anon-key
// client, so any attempt to call it from the browser silently no-ops.

import { createClient } from '@supabase/supabase-js'

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { userId, email, reason, detail } = req.body
  if (!userId) return res.status(400).json({ error: 'userId required' })

  try {
    // Log why they're leaving before anything is deleted — this table has
    // no FK to auth.users, so the feedback survives the account deletion
    // that's about to happen.
    if (reason) {
      const { error: feedbackError } = await supabaseAdmin.from('deletion_feedback').insert({
        user_id: userId, email: email || null, reason, detail: detail || null,
      })
      if (feedbackError) console.error('[delete-account] feedback log error:', feedbackError.message)
      // Non-fatal — never block an account deletion on feedback logging.
    }

    // Explicitly delete from every table keyed by user_id, rather than
    // relying on foreign-key cascade deletes — some of these tables
    // predate this cleanup and their cascade constraints were never
    // directly confirmed, so this is deliberately belt-and-suspenders.
    const tables = [
      'seen_posts', 'upgrade_requests', 'leads',
      'user_settings', 'user_plans', 'product_profiles',
    ]

    for (const table of tables) {
      const { error } = await supabaseAdmin.from(table).delete().eq('user_id', userId)
      if (error) console.error(`[delete-account] error deleting from ${table}:`, error.message)
      // Continue even if one table errors — better to remove as much as
      // possible than abort entirely partway through.
    }

    // Delete the actual auth user last — this is the real account
    // deletion. Only works with the service-role-authenticated client.
    const { error: authError } = await supabaseAdmin.auth.admin.deleteUser(userId)
    if (authError) {
      console.error('[delete-account] auth deletion error:', authError.message)
      return res.status(500).json({ error: 'Account data was cleared, but the login itself could not be removed. Please contact support.' })
    }

    return res.status(200).json({ success: true })
  } catch (err) {
    console.error('[delete-account] fatal:', err.message)
    return res.status(500).json({ error: 'Something went wrong. Please try again or contact support.' })
  }
}
