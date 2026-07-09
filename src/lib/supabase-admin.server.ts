// このモジュールはサーバー（Workers）専用。
// クライアントから import された時点でビルドが violation として落ちる。
import '@tanstack/react-start/server-only'

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from './database.types'

export type AdminClient = SupabaseClient<Database>

let _admin: AdminClient | undefined

/**
 * service_role キーを持つクライアント。RLS を完全にバイパスするため、
 * これを使う処理は必ず呼び出し元の権限を自前で検証すること。
 *
 * キーは VITE_ 接頭辞を持たない env から読む（= クライアントバンドルに載らない）。
 * ローカル開発では .dev.vars に SUPABASE_SERVICE_ROLE_KEY を置く。
 */
export function getAdminClient(): AdminClient {
  if (_admin) return _admin

  const url = process.env.SUPABASE_URL ?? import.meta.env.VITE_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url) throw new Error('SUPABASE_URL / VITE_SUPABASE_URL が未設定です')
  if (!serviceRoleKey) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY が未設定です。ローカルは .dev.vars、本番は wrangler secret で設定してください。',
    )
  }

  _admin = createClient<Database>(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return _admin
}
