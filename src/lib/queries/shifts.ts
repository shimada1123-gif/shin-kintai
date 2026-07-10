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

/* --------------------------- 必要人数（要件定義） --------------------------- */

export type DayType = 'weekday' | 'fri' | 'sat' | 'sun' | 'holiday'

export const DAY_TYPES: { key: DayType; label: string; badgeCls: string }[] = [
  { key: 'weekday', label: '平日', badgeCls: 'dt-w' },
  { key: 'fri', label: '金曜', badgeCls: 'dt-fri' },
  { key: 'sat', label: '土曜', badgeCls: 'dt-sat' },
  { key: 'sun', label: '日曜', badgeCls: 'dt-sun' },
  { key: 'holiday', label: '祝日', badgeCls: 'dt-hol' },
]

export interface RequirementRow {
  day_type: DayType
  need_count: number
  /** ポジション名 → 必要人数（B案の主軸。例 {"キッチン":2,"フロア":2}） */
  need_by_position: Record<string, number>
  /** 雇用区分ラベル → 最低人数（補助制約。例 {"社員":1,"パート":1}） */
  min_by_kind: Record<string, number>
  memo: string | null
}

export async function fetchRequirements(storeId: string): Promise<RequirementRow[]> {
  const supabase = await getSupabase()
  const { data, error } = await supabase
    .from('shift_requirements')
    .select('day_type, need_count, need_by_position, min_by_kind, memo')
    .eq('store_id', storeId)
  if (error) throw error
  return (data ?? []).map((r) => ({
    day_type: r.day_type as DayType,
    need_count: r.need_count,
    need_by_position: (r.need_by_position ?? {}) as Record<string, number>,
    min_by_kind: (r.min_by_kind ?? {}) as Record<string, number>,
    memo: r.memo,
  }))
}

/** 0以下・非数を除いて整数化（jsonb を汚さない） */
function cleanCounts(src: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(src)) {
    if (Number.isFinite(v) && v > 0) out[k] = Math.trunc(v)
  }
  return out
}

export interface UpsertRequirementArgs {
  tenantId: string
  storeId: string
  dayType: DayType
  /** ポジションが定義されている店では need_by_position の合計を渡す運用（B案） */
  needCount: number
  needByPosition: Record<string, number>
  minByKind: Record<string, number>
  memo: string | null
}

/** 保存は upsert（unique(store_id, day_type)）。防壁は req_write = shift_edit ∧ 自店。 */
export async function upsertRequirement(a: UpsertRequirementArgs): Promise<void> {
  const supabase = await getSupabase()
  const { error } = await supabase.from('shift_requirements').upsert(
    {
      tenant_id: a.tenantId,
      store_id: a.storeId,
      day_type: a.dayType,
      need_count: Math.max(0, Math.trunc(a.needCount)),
      need_by_position: cleanCounts(a.needByPosition),
      min_by_kind: cleanCounts(a.minByKind),
      memo: a.memo,
    },
    { onConflict: 'store_id,day_type' },
  )
  if (error) throw error
}

/** 要件保存のRLS違反を具体的な日本語に */
export function reqErrText(e: unknown): string {
  if (e instanceof Error) {
    const code = 'code' in e ? (e as { code?: string }).code : undefined
    if (code === '42501' || /row-level security/i.test(e.message)) {
      return '必要人数を保存できません。シフト編集権限（shift_edit）と、自分のスコープ内の店舗であることが必要です。'
    }
  }
  return errText(e, '必要人数を保存できませんでした')
}

/* --------------------------- 確定シフト（段階2-b） --------------------------- */

export interface ShiftAsg {
  id: string
  store_id: string
  staff_id: string
  work_date: string
  start_min: number
  end_min: number
  position_id: string | null
  weight_half: boolean
  status: 'draft' | 'published'
  note: string | null
  staff_name: string
}

const ASG_SELECT =
  'id, store_id, staff_id, work_date, start_min, end_min, position_id, weight_half, status, note, staff (full_name)'

function toAsg(r: Record<string, unknown>): ShiftAsg {
  const staff = r.staff as { full_name: string } | null
  return {
    id: r.id as string,
    store_id: r.store_id as string,
    staff_id: r.staff_id as string,
    work_date: r.work_date as string,
    start_min: r.start_min as number,
    end_min: r.end_min as number,
    position_id: r.position_id as string | null,
    weight_half: r.weight_half as boolean,
    status: r.status as 'draft' | 'published',
    note: r.note as string | null,
    staff_name: staff?.full_name ?? '',
  }
}

export async function fetchAssignments(
  storeId: string,
  fromDay: string,
  toDay: string,
): Promise<ShiftAsg[]> {
  const supabase = await getSupabase()
  const { data, error } = await supabase
    .from('shift_assignments')
    .select(ASG_SELECT)
    .eq('store_id', storeId)
    .gte('work_date', fromDay)
    .lte('work_date', toDay)
    .order('work_date')
    .order('start_min')
  if (error) throw error
  return (data ?? []).map((r) => toAsg(r as Record<string, unknown>))
}

export function validateAsgTimes(startMin: number | null, endMin: number | null) {
  if (startMin === null || endMin === null) {
    throw new Error('開始と終了の時刻を入力してください。')
  }
  if (startMin < 0 || startMin > 1439 || endMin < 0 || endMin > 1439) {
    throw new Error('時刻は 00:00〜23:59 の範囲で入力してください。')
  }
  if (startMin >= endMin) {
    throw new Error('開始時刻は終了時刻より前にしてください。')
  }
}

export interface CreateAsgArgs {
  tenantId: string
  storeId: string
  staffId: string
  workDate: string
  startMin: number | null
  endMin: number | null
  positionId: string | null
  weightHalf: boolean
  note?: string | null
}

/** 段階2-b は下書き（draft）のみ作成する。公開（published）は次の段階。 */
export async function createAssignment(a: CreateAsgArgs): Promise<void> {
  validateAsgTimes(a.startMin, a.endMin)
  const supabase = await getSupabase()
  const { error } = await supabase.from('shift_assignments').insert({
    tenant_id: a.tenantId,
    store_id: a.storeId,
    staff_id: a.staffId,
    work_date: a.workDate,
    start_min: a.startMin!,
    end_min: a.endMin!,
    position_id: a.positionId,
    weight_half: a.weightHalf,
    status: 'draft',
    note: a.note ?? null,
  })
  if (error) throw error
}

export interface UpdateAsgArgs {
  startMin: number | null
  endMin: number | null
  positionId: string | null
  weightHalf: boolean
  note?: string | null
}

export async function updateAssignment(id: string, a: UpdateAsgArgs): Promise<void> {
  validateAsgTimes(a.startMin, a.endMin)
  const supabase = await getSupabase()
  const { error } = await supabase
    .from('shift_assignments')
    .update({
      start_min: a.startMin!,
      end_min: a.endMin!,
      position_id: a.positionId,
      weight_half: a.weightHalf,
      note: a.note ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
  if (error) throw error
}

export async function deleteAssignment(id: string): Promise<void> {
  const supabase = await getSupabase()
  const { error } = await supabase.from('shift_assignments').delete().eq('id', id)
  if (error) throw error
}

/**
 * 週の確定・公開: その店舗×期間の draft を published に一括更新。
 * published を draft に戻す経路は用意しない（要件）。
 * 防壁は sa2_write（shift_edit ∧ 自店）。スタッフには write ポリシー自体が無い。
 */
export async function publishWeek(
  storeId: string,
  fromDay: string,
  toDay: string,
): Promise<number> {
  const supabase = await getSupabase()
  const { data, error } = await supabase
    .from('shift_assignments')
    .update({ status: 'published', updated_at: new Date().toISOString() })
    .eq('store_id', storeId)
    .eq('status', 'draft')
    .gte('work_date', fromDay)
    .lte('work_date', toDay)
    .select('id')
  if (error) throw error
  return (data ?? []).length
}

/* ---------------------------- マイシフト（本人） ---------------------------- */

export interface MyShift {
  id: string
  work_date: string
  start_min: number
  end_min: number
  note: string | null
  store_name: string
  position_name: string | null
}

/** 自分の公開済みシフトのみ（draft は本人に見せない）。日付順。 */
export async function fetchMyShifts(
  staffId: string,
  fromDay: string,
  toDay: string,
): Promise<MyShift[]> {
  const supabase = await getSupabase()
  const { data, error } = await supabase
    .from('shift_assignments')
    .select('id, work_date, start_min, end_min, note, stores (name), positions (name)')
    .eq('staff_id', staffId)
    .eq('status', 'published')
    .gte('work_date', fromDay)
    .lte('work_date', toDay)
    .order('work_date')
    .order('start_min')
  if (error) throw error
  return (data ?? []).map((r) => ({
    id: r.id,
    work_date: r.work_date,
    start_min: r.start_min,
    end_min: r.end_min,
    note: r.note,
    store_name: (r.stores as { name: string } | null)?.name ?? '所属店舗',
    position_name: (r.positions as { name: string } | null)?.name ?? null,
  }))
}

/** 確定シフト操作のRLS違反を具体的な日本語に */
export function asgErrText(e: unknown): string {
  if (e instanceof Error) {
    const code = 'code' in e ? (e as { code?: string }).code : undefined
    if (code === '42501' || /row-level security/i.test(e.message)) {
      return 'シフトを保存できません。シフト編集権限（shift_edit）と、自分のスコープ内の店舗であることが必要です。'
    }
  }
  return errText(e, 'シフトを保存できませんでした')
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
