import { createServerFn } from '@tanstack/react-start'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'
import { assert } from './permissions'

/**
 * オファー承諾/拒否の受け口。メールリンク（未ログイン）から踏まれるため認証は不要。
 * - rpc は anon キーで呼ぶ（service_role 不使用）。実行可否は 0013 の grant（anon 実行可）と
 *   definer 関数内の sha256 トークン照合が最終防壁
 * - 生トークンはここを素通りするだけで、ログにも DB にも保存しない（DB側は token_hash のみ）
 */

let _anon: SupabaseClient<Database> | undefined

function getAnonClient(): SupabaseClient<Database> {
  if (_anon) return _anon
  const url = process.env.SUPABASE_URL ?? import.meta.env.VITE_SUPABASE_URL
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
  if (!url || !anonKey) throw new Error('Supabase の接続設定が見つかりません。')
  _anon = createClient<Database>(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return _anon
}

export type OfferAction = 'accept' | 'decline'

export interface OfferOutcome {
  ok: boolean
  reason: string | null
  workDate: string | null
  startMin: number | null
  endMin: number | null
  overlapWarning: boolean
}

interface RpcResult {
  ok?: boolean
  reason?: string
  work_date?: string
  start_min?: number
  end_min?: number
  overlap_warning?: boolean
  // decline 応答のみ（フェーズ4の管理者通知用）
  offer_id?: string
  store_id?: string
  created_by?: string | null
  staff_id?: string
}

export const respondOffer = createServerFn({ method: 'POST' })
  .inputValidator((d: { action: OfferAction; token: string; comment?: string }) => {
    assert(d.action === 'accept' || d.action === 'decline', '不正なリクエストです。')
    assert(typeof d.token === 'string' && d.token.length > 0, 'トークンがありません。')
    assert(d.comment === undefined || typeof d.comment === 'string', '不正なコメントです。')
    return d
  })
  .handler(async ({ data }): Promise<OfferOutcome> => {
    const supabase = getAnonClient()
    // accept は 0014 の二段階承認（申請 applied ＋任意コメント）。空コメントは関数側で null 化される
    const { data: raw, error } =
      data.action === 'accept'
        ? await supabase.rpc('app_offer_accept', {
            p_token: data.token,
            p_comment: data.comment ?? '',
          })
        : await supabase.rpc('app_offer_decline', { p_token: data.token })
    if (error) {
      throw new Error('処理に失敗しました。時間をおいて再度お試しください。')
    }
    const r = (raw ?? {}) as RpcResult

    // TODO(フェーズ4): decline で ok:true のとき、r.created_by / r.store_id / r.work_date / r.staff_id を
    // 使って管理者へ Resend 通知を送る（文面と合わせて実装。この段では受け口のみ）

    return {
      ok: r.ok === true,
      reason: r.reason ?? null,
      workDate: r.work_date ?? null,
      startMin: typeof r.start_min === 'number' ? r.start_min : null,
      endMin: typeof r.end_min === 'number' ? r.end_min : null,
      overlapWarning: r.overlap_warning === true,
    }
  })
