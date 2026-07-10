import { getSupabase } from '@/lib/auth/supabase-client'
import {
  confirmOffer,
  createDraftOffers as createDraftOffersSrv,
  markDeclinesSeen as markDeclinesSeenSrv,
  previewDraftOffers as previewDraftOffersSrv,
  sendDraftOffers as sendDraftOffersSrv,
  type CreateDraftOffersResult,
  type MarkDeclinesSeenResult,
  type OfferDraftInput,
  type PreviewDraftOffersResult,
  type SendDraftOffersResult,
} from '@/lib/server/offer-create'

/**
 * オファー（shift_offers / shift_offer_recipients）の閲覧・確定・取消。
 * すべてブラウザの通常セッション + RLS（service_role 不使用）。
 * - 閲覧: so_sel / sor_sel = app_can_store（管理者スコープ）。一般スタッフには元々見えない
 * - 確定: app_offer_confirm（definer）を rpc 直呼び。排他・権限は関数内が最終防壁
 * - 取消: so_write（shift_edit ∧ 自店）。RETURNING×RLS を避けるため .select() は付けない
 */

export type OfferStatus = 'draft' | 'open' | 'filled' | 'cancelled' | 'expired'
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

/**
 * 管理者の確定。フェーズ5-1でサーバ関数（confirmOffer）経由に一本化：
 * サーバ側でスナップショット→rpc（呼び出し者JWT）→確定/落選メール送信まで行う。
 * 戻り値の ok/reason/overlapWarning は従来と同形（UI の結果マッピングはそのまま）。
 */
export async function confirmOfferRecipient(recipientId: string): Promise<ConfirmOutcome> {
  const r = await confirmOffer({ data: { recipient_id: recipientId } })
  return { ok: r.ok, reason: r.reason, overlapWarning: r.overlapWarning }
}

/* ---------- フェーズ②: 下書き→一斉送信（サーバ関数ラッパー） ---------- */

export type { CreateDraftOffersResult, PreviewDraftOffersResult, SendDraftOffersResult }

/** 下書きオファー作成（メール0通）。宛先・トークンはサーバ側で用意される */
export async function createDraftOffers(input: {
  store_id: string
  drafts: OfferDraftInput[]
}): Promise<CreateDraftOffersResult> {
  return createDraftOffersSrv({ data: input })
}

/** 送信前プレビュー（送らない）。スタッフ別の枠数と email 有無 */
export async function previewDraftOffers(storeId: string): Promise<PreviewDraftOffersResult> {
  return previewDraftOffersSrv({ data: { store_id: storeId } })
}

/** 下書きの一斉送信（1人1通に集約）。締切切れは draft のまま残る */
export async function sendDraftOffers(storeId: string): Promise<SendDraftOffersResult> {
  return sendDraftOffersSrv({ data: { store_id: storeId } })
}

/* ---------- 辞退の可視化（0016 mgr_seen_at） ---------- */

export interface UnseenDecline {
  recipient_id: string
  staff_name: string
  work_date: string
  start_min: number
  end_min: number
  offer_id: string
  responded_at: string | null
}

/**
 * 未確認の辞退（全期間・週フィルタなし）。ブラウザ直＋RLS（sor_sel=app_can_store）。
 * cancelled / draft の枠は対象外。新しい辞退が上（responded_at 降順）。
 */
export async function fetchUnseenDeclines(storeId: string): Promise<UnseenDecline[]> {
  const supabase = await getSupabase()
  const { data: offers, error: offErr } = await supabase
    .from('shift_offers')
    .select('id, work_date, start_min, end_min')
    .eq('store_id', storeId)
    .in('status', ['open', 'filled', 'expired'])
  if (offErr) throw offErr
  const offerIds = (offers ?? []).map((o) => o.id)
  if (offerIds.length === 0) return []

  const { data: recs, error } = await supabase
    .from('shift_offer_recipients')
    .select('id, offer_id, responded_at, staff:staff_id (full_name)')
    .in('offer_id', offerIds)
    .eq('response', 'declined')
    .is('mgr_seen_at', null)
  if (error) throw error

  const offerById = new Map((offers ?? []).map((o) => [o.id, o]))
  return (recs ?? [])
    .map((r) => {
      const off = offerById.get(r.offer_id)!
      return {
        recipient_id: r.id,
        staff_name: (r.staff as { full_name: string } | null)?.full_name ?? '(不明)',
        work_date: off.work_date,
        start_min: off.start_min,
        end_min: off.end_min,
        offer_id: r.offer_id,
        responded_at: r.responded_at,
      }
    })
    .sort((a, b) => (b.responded_at ?? '').localeCompare(a.responded_at ?? ''))
}

/** 未確認辞退を一括で確認済みに（サーバ関数・blind update）。戻り値=更新件数 */
export async function markDeclinesSeen(storeId: string): Promise<MarkDeclinesSeenResult> {
  return markDeclinesSeenSrv({ data: { store_id: storeId } })
}
