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

export interface RosterEntry {
  staffId: string
  name: string
  kindLabel: string | null
  /** 社員区分か（employment_kinds.is_regular・0022/0023） */
  isRegular: boolean
  /** 既定ポジション（staff_assignments.position_default_id・スキル表の「既定」印用） */
  positionDefaultId: string | null
}

/**
 * 店舗の所属スタッフ（有効所属 ∧ 在籍 ∧ 打刻対象の区分のみ。業務委託と区分未設定は対象外）。
 * 希望の有無に関わらず直接配置する「＋スタッフを追加」の候補リスト用。
 * 賃金列を返さない definer 関数（0012 app_store_roster）を rpc で呼ぶため、
 * 個人賃金閲覧権限（wage_individual_view）が無い店長でも候補が取れる。
 * 絞り込み（is_active・在籍・requires_clock・app_can_store）はすべてサーバー側。
 */
export async function fetchStoreRoster(storeId: string): Promise<RosterEntry[]> {
  const supabase = await getSupabase()
  const { data, error } = await supabase.rpc('app_store_roster', { p_store_id: storeId })
  if (error) throw error

  const rows: RosterEntry[] = (data ?? []).map((r) => ({
    staffId: r.staff_id,
    name: r.full_name,
    kindLabel: r.kind_label ?? null,
    isRegular: r.is_regular === true,
    positionDefaultId: r.position_default_id ?? null,
  }))
  rows.sort((a, b) => a.name.localeCompare(b.name, 'ja'))
  return rows
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
  /** null=時間帯を分けない「通し」行（0020） */
  time_band_id: string | null
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
    .select('day_type, time_band_id, need_count, need_by_position, min_by_kind, memo')
    .eq('store_id', storeId)
  if (error) throw error
  return (data ?? []).map((r) => ({
    day_type: r.day_type as DayType,
    time_band_id: r.time_band_id,
    need_count: r.need_count,
    need_by_position: (r.need_by_position ?? {}) as Record<string, number>,
    min_by_kind: (r.min_by_kind ?? {}) as Record<string, number>,
    memo: r.memo,
  }))
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 後方互換シム（0024）: need_by_position のキーを position_id に正規化する。
 * - キーが uuid ならそのまま（正）
 * - 名前キー（旧データ）なら tenant×store で解決: store_id is null or =storeId、
 *   同名は店専用優先（store_id nulls last 相当）で1件目
 * - 解決不能キーは落とす（表示は 0/未設定扱い・保存対象外）
 * 書込は常に id キーのみ（このシムは読取専用の安全弁）。
 */
export function normalizeNeedByPosition(
  need: Record<string, number>,
  positions: { id: string; name: string; store_id: string | null }[],
  storeId: string,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(need)) {
    if (UUID_RE.test(k)) {
      out[k] = v
      continue
    }
    const hit = positions
      .filter((p) => p.name === k && (p.store_id === null || p.store_id === storeId))
      .sort((a, b) => (a.store_id === null ? 1 : 0) - (b.store_id === null ? 1 : 0))[0]
    if (hit) out[hit.id] = v
  }
  return out
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
  /** null=通し（時間帯を分けない）。帯指定はその帯の id（0020） */
  timeBandId: string | null
  /** ポジションが定義されている店では need_by_position の合計を渡す運用（B案） */
  needCount: number
  needByPosition: Record<string, number>
  minByKind: Record<string, number>
  memo: string | null
}

/**
 * 保存は upsert。conflict target は 0020 の
 * unique nulls not distinct (store_id, day_type, time_band_id) — null（通し）行も正しく1行に潰れる。
 * 防壁は req_write = shift_edit ∧ 自店。
 */
export async function upsertRequirement(a: UpsertRequirementArgs): Promise<void> {
  const supabase = await getSupabase()
  const { error } = await supabase.from('shift_requirements').upsert(
    {
      tenant_id: a.tenantId,
      store_id: a.storeId,
      day_type: a.dayType,
      time_band_id: a.timeBandId,
      need_count: Math.max(0, Math.trunc(a.needCount)),
      need_by_position: cleanCounts(a.needByPosition),
      min_by_kind: cleanCounts(a.minByKind),
      memo: a.memo,
    },
    { onConflict: 'store_id,day_type,time_band_id' },
  )
  if (error) throw error
}

/* ------------- 必要人数の日付上書き（0026 shift_requirement_overrides） ------------- */
// テンプレ(shift_requirements)の"上に重ねる"例外日レイヤ。テンプレ経路は無改変。
// 解決順(確定): ovr[date,band] → ovr[date,通し] → tpl[day_type,band] → tpl[day_type,通し] → 定休0(UI層)。
// 防壁は ovr_write = shift_edit ∧ 自店（req型ミラー）。RPCなしのクライアント直接upsert。

export interface RequirementOverrideRow {
  work_date: string
  /** null=通し。帯指定はその帯の id（テンプレと同粒度） */
  time_band_id: string | null
  need_count: number
  /** position_id キーのみ（0024踏襲。読取は normalizeNeedByPosition を通す） */
  need_by_position: Record<string, number>
  min_by_kind: Record<string, number>
  memo: string | null
}

export async function fetchRequirementOverrides(
  storeId: string,
  fromDate: string,
  toDate: string,
): Promise<RequirementOverrideRow[]> {
  const supabase = await getSupabase()
  const { data, error } = await supabase
    .from('shift_requirement_overrides')
    .select('work_date, time_band_id, need_count, need_by_position, min_by_kind, memo')
    .eq('store_id', storeId)
    .gte('work_date', fromDate)
    .lte('work_date', toDate)
  if (error) throw error
  return (data ?? []).map((r) => ({
    work_date: r.work_date,
    time_band_id: r.time_band_id,
    need_count: r.need_count,
    need_by_position: (r.need_by_position ?? {}) as Record<string, number>,
    min_by_kind: (r.min_by_kind ?? {}) as Record<string, number>,
    memo: r.memo,
  }))
}

export interface UpsertRequirementOverrideArgs {
  tenantId: string
  storeId: string
  workDate: string
  timeBandId: string | null
  needCount: number
  needByPosition: Record<string, number>
  minByKind: Record<string, number>
  memo: string | null
}

/** conflict target は 0026 の unique nulls not distinct (store_id, work_date, time_band_id) */
export async function upsertRequirementOverride(a: UpsertRequirementOverrideArgs): Promise<void> {
  const supabase = await getSupabase()
  const { error } = await supabase.from('shift_requirement_overrides').upsert(
    {
      tenant_id: a.tenantId,
      store_id: a.storeId,
      work_date: a.workDate,
      time_band_id: a.timeBandId,
      need_count: Math.max(0, Math.trunc(a.needCount)),
      need_by_position: cleanCounts(a.needByPosition),
      min_by_kind: cleanCounts(a.minByKind),
      memo: a.memo,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'store_id,work_date,time_band_id' },
  )
  if (error) throw error
}

/** 「テンプレに戻す」＝該当 (store, date, band) の上書き行を削除 */
export async function deleteRequirementOverride(a: {
  storeId: string
  workDate: string
  timeBandId: string | null
}): Promise<void> {
  const supabase = await getSupabase()
  let q = supabase
    .from('shift_requirement_overrides')
    .delete()
    .eq('store_id', a.storeId)
    .eq('work_date', a.workDate)
  q = a.timeBandId === null ? q.is('time_band_id', null) : q.eq('time_band_id', a.timeBandId)
  const { error } = await q
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

/* ---------------- C-2: 人件費概算（0027 app_labor_cost・集計のみ） ---------------- */

/** 集計6列のみ（個別staff_id/個別額/個別時給は構造上返らない） */
export interface LaborCostRow {
  work_date: string
  status: string // 'draft' | 'published'
  total_min: number
  staff_count: number
  cost_yen: number
  excluded_count: number
}

/**
 * 日別×status の人件費集計。呼び出し者JWT（ガード=labor_cost_view ∧ app_can_store は関数側）。
 * 対象は保存済み shift_assignments のみ（未保存草案は含まれない）。
 */
export async function fetchLaborCost(
  storeId: string,
  fromDay: string,
  toDay: string,
): Promise<LaborCostRow[]> {
  const supabase = await getSupabase()
  const { data, error } = await supabase.rpc('app_labor_cost', {
    p_store_id: storeId,
    p_from: fromDay,
    p_to: toDay,
  })
  if (error) throw error
  return (data ?? []) as LaborCostRow[]
}

/* ---------------- C-1c: 自動シフト草案の一括保存（draftのみ） ---------------- */

export interface SaveDraftRow {
  staffId: string
  workDate: string
  startMin: number
  endMin: number
  positionId: string | null
}

/**
 * 草案（衝突分割後の toSave）を shift_assignments へ配列 insert（status='draft' 固定）。
 * - .select() を付けない（RETURNING×RLS 回避の作法・0009/0011の教訓）
 * - getSupabase()＝呼び出し者JWT。防壁は sa2_write（shift_edit ∧ 自店・行ごとに評価）
 * - 1リクエスト=1トランザクション: 1行でも失敗すれば全行ロールバック（部分保存なし）
 * - 既存行の update/delete は一切しない（insert のみ・既存優先スキップは呼び出し側で分割済み）
 */
export async function saveDraftPlan(a: {
  tenantId: string
  storeId: string
  rows: SaveDraftRow[]
}): Promise<void> {
  if (a.rows.length === 0) return
  for (const r of a.rows) validateAsgTimes(r.startMin, r.endMin)
  const supabase = await getSupabase()
  const { error } = await supabase.from('shift_assignments').insert(
    a.rows.map((r) => ({
      tenant_id: a.tenantId,
      store_id: a.storeId,
      staff_id: r.staffId,
      work_date: r.workDate,
      start_min: r.startMin,
      end_min: r.endMin,
      position_id: r.positionId,
      weight_half: false,
      status: 'draft' as const,
      note: null,
    })),
  )
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
  /** 賄いの自己申告（0030）に必要。記録は勤務した店に紐づく */
  store_id: string
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
    .select('id, work_date, start_min, end_min, note, store_id, stores (name), positions (name)')
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
    store_id: r.store_id,
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

/** 分→表示ラベル。1440超は「翌HH:MM」（深夜跨ぎの時間帯表示用。例 1560→「翌02:00」） */
export const minToLabel = (min: number): string =>
  min >= 1440 ? `翌${minToHHMM(min - 1440)}` : minToHHMM(min)

/** "HH:MM"（input type=time の値）→ 分。空は null */
export const hhmmToMin = (v: string): number | null => {
  if (!v) return null
  const [h, m] = v.split(':').map(Number)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null
  return h * 60 + m
}

/* ---------- 社員の公休（staff_day_off・0022） ---------- */

export interface StaffDayOffRow {
  id: string
  staff_id: string
  work_date: string
  kind: string
}

/**
 * C-0: 自動シフトのハードゲート（社員の公休を先に固定）。純関数・決定的。
 * 解除条件: 各社員(regulars)が対象週内に「定休日(closedDows)以外の日」の明示的公休を1件以上持つ。
 * - kind(public/paid/other)は不問＝全て休みとしてカウント（公休タブ 976-988 のカウント規則と同一）。
 * - 定休日上の行は充足に数えない（公休タブ「定休日は個別の公休には数えません」と一致）。
 * - regulars 0人 → ok=true（ゲート対象なし・自動通過）。
 * - missing は regulars の元順序（roster順）を保つ＝決定的。
 */
export function gateAutoShift(
  regulars: { staffId: string; name: string }[],
  dayOffs: { staff_id: string; work_date: string }[],
  weekDays: string[],
  closedDows: number[],
): { ok: boolean; missing: { staffId: string; name: string }[] } {
  if (regulars.length === 0) return { ok: true, missing: [] }
  const days = new Set(weekDays)
  const dowOf = (date: string) => new Date(`${date}T00:00:00`).getDay()
  const satisfied = new Set<string>()
  for (const o of dayOffs) {
    if (days.has(o.work_date) && !closedDows.includes(dowOf(o.work_date))) {
      satisfied.add(o.staff_id)
    }
  }
  const missing = regulars.filter((r) => !satisfied.has(r.staffId))
  return { ok: missing.length === 0, missing }
}

/** その店・期間の公休。sdo_sel（管理者=自店全件 / 本人=自分の分）に従う */
export async function fetchStaffDayOffs(
  storeId: string,
  fromDay: string,
  toDay: string,
): Promise<StaffDayOffRow[]> {
  const supabase = await getSupabase()
  const { data, error } = await supabase
    .from('staff_day_off')
    .select('id, staff_id, work_date, kind')
    .eq('store_id', storeId)
    .gte('work_date', fromDay)
    .lte('work_date', toDay)
  if (error) throw error
  return data ?? []
}

/** 公休を追加。防壁は sdo_write（shift_edit ∧ 自店）。戻り値=作成した行の id */
export async function addStaffDayOff(a: {
  tenantId: string
  staffId: string
  storeId: string
  workDate: string
  kind?: 'public' | 'paid' | 'other'
}): Promise<string> {
  const supabase = await getSupabase()
  const id = crypto.randomUUID()
  const { data, error } = await supabase
    .from('staff_day_off')
    .insert({
      id,
      tenant_id: a.tenantId,
      staff_id: a.staffId,
      store_id: a.storeId,
      work_date: a.workDate,
      kind: a.kind ?? 'public',
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

/** 公休の取り消し。防壁は sdo_write */
export async function removeStaffDayOff(id: string): Promise<void> {
  const supabase = await getSupabase()
  const { error } = await supabase.from('staff_day_off').delete().eq('id', id)
  if (error) throw error
}

/* ---------- 確定と通知の分離（0017 notified_at・サーバ関数ラッパー） ---------- */

import {
  previewShiftNotify as previewShiftNotifySrv,
  sendShiftNotify as sendShiftNotifySrv,
  type PreviewShiftNotifyResult,
  type SendShiftNotifyResult,
} from '@/lib/server/shift-notify'

export type { PreviewShiftNotifyResult, SendShiftNotifyResult }

/** 未通知の確定シフト（全期間）のスタッフ別プレビュー（送らない） */
export async function getShiftNotifyPreview(storeId: string): Promise<PreviewShiftNotifyResult> {
  return previewShiftNotifySrv({ data: { store_id: storeId } })
}

/** 未通知の確定シフトを1人1通で通知メール送信（成功分に notified_at スタンプ） */
export async function sendShiftNotifications(storeId: string): Promise<SendShiftNotifyResult> {
  return sendShiftNotifySrv({ data: { store_id: storeId } })
}
