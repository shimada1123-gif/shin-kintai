import { getSupabase } from '@/lib/auth/supabase-client'

/**
 * オファー（shift_offers / shift_offer_recipients）の閲覧・確定・取消。
 * すべてブラウザの通常セッション + RLS（service_role 不使用）。
 * - 閲覧: so_sel / sor_sel = app_can_store（管理者スコープ）。一般スタッフには元々見えない
 * - 確定: app_offer_confirm（definer）を rpc 直呼び。排他・権限は関数内が最終防壁
 * - 取消: so_write（shift_edit ∧ 自店）。RETURNING×RLS を避けるため .select() は付けない
 */

export type OfferStatus = 'open' | 'filled' | 'cancelled' | 'expired'
export type OfferResponse = 'pending' | 'applied' | 'declined' | 'confirmed' | 'superseded'

export interface OfferRow {
  id: string
  store_id: string
  work_date: string
  position_id: string | null
  start_min: number
  end_min: number
  status: OfferStatus
  winner_staff_id: string | null
  deadline_at: string
}

export async function fetchOffers(storeId: string, from: string, to: string): Promise<OfferRow[]> {
  const supabase = await getSupabase()
  const { data, error } = await supabase
    .from('shift_offers')
    .select('id, store_id, work_date, position_id, start_min, end_min, status, winner_staff_id, deadline_at')
    .eq('store_id', storeId)
    .gte('work_date', from)
    .lte('work_date', to)
    .order('work_date')
    .order('start_min')
  if (error) throw error
  return (data ?? []).map((r) => ({ ...r, status: r.status as OfferStatus }))
}

export interface OfferRecipientRow {
  id: string
  offer_id: string
  staff_id: string
  staff_name: string
  response: OfferResponse
  comment: string | null
  sent_at: string | null
  responded_at: string | null
}

/** 週内の全オファーぶんの招待行を一括取得（氏名は staff join で解決） */
export async function fetchOfferRecipients(offerIds: string[]): Promise<OfferRecipientRow[]> {
  if (offerIds.length === 0) return []
  const supabase = await getSupabase()
  const { data, error } = await supabase
    .from('shift_offer_recipients')
    .select('id, offer_id, staff_id, response, comment, sent_at, responded_at, staff:staff_id (full_name)')
    .in('offer_id', offerIds)
    .order('responded_at', { ascending: false, nullsFirst: false })
  if (error) throw error
  return (data ?? []).map((r) => ({
    id: r.id,
    offer_id: r.offer_id,
    staff_id: r.staff_id,
    staff_name: (r.staff as { full_name: string } | null)?.full_name ?? '(不明)',
    response: r.response as OfferResponse,
    comment: r.comment,
    sent_at: r.sent_at,
    responded_at: r.responded_at,
  }))
}

/** 募集取消。blind update（.select なし＝RETURNING×RLS 回避）。RLS so_write が最終防壁 */
export async function cancelOffer(offerId: string): Promise<void> {
  const supabase = await getSupabase()
  const { error } = await supabase
    .from('shift_offers')
    .update({ status: 'cancelled' })
    .eq('id', offerId)
    .eq('status', 'open') // filled/expired は取り消さない
  if (error) throw error
}

export interface ConfirmOutcome {
  ok: boolean
  reason: string | null
  overlapWarning: boolean
}

/** 管理者の確定。definer 関数を rpc 直呼び（排他・権限チェックは関数内） */
export async function confirmOfferRecipient(recipientId: string): Promise<ConfirmOutcome> {
  const supabase = await getSupabase()
  const { data, error } = await supabase.rpc('app_offer_confirm', { p_recipient_id: recipientId })
  if (error) throw error
  const r = (data ?? {}) as { ok?: boolean; reason?: string; overlap_warning?: boolean }
  return {
    ok: r.ok === true,
    reason: r.reason ?? null,
    overlapWarning: r.overlap_warning === true,
  }
}
