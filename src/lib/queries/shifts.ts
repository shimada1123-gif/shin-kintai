import { getSupabase } from '@/lib/auth/supabase-client'
import { errText } from '@/lib/errors'

/**
 * シフト希望（shift_availability）のデータ層。段階1=希望の提出と収集のみ。
 * 通常セッション + RLS（service_role 不使用）。
 * - 書き込みは avail_ins/upd/del =「本人∧自店」or「shift_edit∧自店」が最終防壁
 * - 閲覧は avail_sel = 自店 or 本人
 * - upsert は unique(staff_id, store_id, work_date) に onConflict
 */

export type AvailKind = 'avail' | 'partial' | 'off'

export interface AvailRow {
  id: string
  store_id: string
  staff_id: string
  work_date: string
  kind: AvailKind
  start_min: number | null
  end_min: number | null
  note: string | null
  staff_name: string
}

const SELECT = 'id, store_id, staff_id, work_date, kind, start_min, end_min, note, staff (full_name)'

function toRow(r: Record<string, unknown>): AvailRow {
  const staff = r.staff as { full_name: string } | null
  return {
    id: r.id as string,
    store_id: r.store_id as string,
    staff_id: r.staff_id as string,
    work_date: r.work_date as string,
    kind: r.kind as AvailKind,
    start_min: r.start_min as number | null,
    end_min: r.end_min as number | null,
    note: r.note as string | null,
    staff_name: staff?.full_name ?? '',
  }
}

/** 自分の希望（期間内・全店舗分）。表示側で店舗を絞る。 */
export async function fetchMyAvailability(
  staffId: string,
  fromDay: string,
  toDay: string,
): Promise<AvailRow[]> {
  const supabase = await getSupabase()
  const { data, error } = await supabase
    .from('shift_availability')
    .select(SELECT)
    .eq('staff_id', staffId)
    .gte('work_date', fromDay)
    .lte('work_date', toDay)
  if (error) throw error
  return (data ?? []).map((r) => toRow(r as Record<string, unknown>))
}

/** 店舗×期間の全員分（管理者マトリクス用）。RLS avail_sel に従う。 */
export async function fetchStoreAvailability(
  storeId: string,
  fromDay: string,
  toDay: string,
): Promise<AvailRow[]> {
  const supabase = await getSupabase()
  const { data, error } = await supabase
    .from('shift_availability')
    .select(SELECT)
    .eq('store_id', storeId)
    .gte('work_date', fromDay)
    .lte('work_date', toDay)
    .order('work_date')
  if (error) throw error
  return (data ?? []).map((r) => toRow(r as Record<string, unknown>))
}

/** partial の時刻バリデーション（アプリ側。0-1439・開始<終了） */
export function validateTimes(kind: AvailKind, startMin: number | null, endMin: number | null) {
  if (kind !== 'partial') return
  if (startMin === null || endMin === null) {
    throw new Error('時間指定（△）は開始と終了の両方を入力してください。')
  }
  if (startMin < 0 || startMin > 1439 || endMin < 0 || endMin > 1439) {
    throw new Error('時刻は 00:00〜23:59 の範囲で入力してください。')
  }
  if (startMin >= endMin) {
    throw new Error('開始時刻は終了時刻より前にしてください。')
  }
}

export interface UpsertAvailArgs {
  tenantId: string
  storeId: string
  staffId: string
  workDate: string
  kind: AvailKind
  startMin: number | null
  endMin: number | null
  note?: string | null
}

export async function upsertAvailability(a: UpsertAvailArgs): Promise<void> {
  validateTimes(a.kind, a.startMin, a.endMin)
  const supabase = await getSupabase()
  const { error } = await supabase.from('shift_availability').upsert(
    {
      tenant_id: a.tenantId,
      store_id: a.storeId,
      staff_id: a.staffId,
      work_date: a.workDate,
      kind: a.kind,
      start_min: a.kind === 'partial' ? a.startMin : null,
      end_min: a.kind === 'partial' ? a.endMin : null,
      note: a.note ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'staff_id,store_id,work_date' },
  )
  if (error) throw error
}

export async function deleteAvailability(id: string): Promise<void> {
  const supabase = await getSupabase()
  const { error } = await supabase.from('shift_availability').delete().eq('id', id)
  if (error) throw error
}

/**
 * 自分の所属店舗（希望を出せる店）= staff_assignments ベース。
 * 管理スコープ（membership.scope_store_id）は使わない。
 * RLS sa_sel は本人行を常に返すため、本人の所属は必ず取れる。
 * 埋め込みの stores(name) は店舗側の RLS で null になりうる（例: 店長の
 * 管理スコープ外の所属店）ので、name は null 許容にして画面側で解決する。
 */
export async function fetchMyStores(
  staffId: string,
): Promise<{ id: string; name: string | null }[]> {
  const supabase = await getSupabase()
  const { data, error } = await supabase
    .from('staff_assignments')
    .select('store_id, is_active, stores (name)')
    .eq('staff_id', staffId)
    .eq('is_active', true)
  if (error) throw error
  return (data ?? []).map((r) => ({
    id: r.store_id,
    name: (r.stores as { name: string } | null)?.name ?? null,
  }))
}

/**
 * 希望保存のエラーを具体的な日本語にする。
 * RLS(avail_ins/upd) 違反は「所属/スコープの問題」であることを明示する
 * （errors.ts の 42501 汎用文言は staff_master_edit 向けでここでは誤解を招く）。
 */
export function availErrText(e: unknown): string {
  if (e instanceof Error) {
    const code = 'code' in e ? (e as { code?: string }).code : undefined
    if (code === '42501' || /row-level security/i.test(e.message)) {
      return (
        'この店舗への希望を保存できません。所属（staff_assignments）が無いか、' +
        '店長・エリアマネージャーの場合は管理スコープ外の店舗です。' +
        '管理者にユーザー管理でスコープと所属の設定を確認してもらってください。'
      )
    }
  }
  return errText(e, '希望を保存できませんでした')
}

/** 祝日（期間内）。date → 名称 */
export async function fetchHolidays(fromDay: string, toDay: string): Promise<Map<string, string>> {
  const supabase = await getSupabase()
  const { data, error } = await supabase
    .from('holidays')
    .select('holiday_date, name')
    .gte('holiday_date', fromDay)
    .lte('holiday_date', toDay)
  if (error) throw error
  return new Map((data ?? []).map((h) => [h.holiday_date, h.name]))
}

/* ------------------------------ 時刻ヘルパー ------------------------------ */

export const minToHHMM = (min: number | null): string => {
  if (min === null) return ''
  const h = Math.floor(min / 60)
  const m = min % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** "HH:MM"（input type=time の値）→ 分。空は null */
export const hhmmToMin = (v: string): number | null => {
  if (!v) return null
  const [h, m] = v.split(':').map(Number)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null
  return h * 60 + m
}
