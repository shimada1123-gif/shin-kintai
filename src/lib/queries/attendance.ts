import { getSupabase } from '@/lib/auth/supabase-client'

/**
 * 勤怠一覧・補正のデータ層。通常のログインセッション + RLS のみ（service_role 不使用）。
 * - 一覧は att_sel（自店 or 本人）に従う
 * - 直接修正/承認は att_upd（本人 or correction_approve+自店）に従う
 * - 補正履歴は corr_ins / corr_upd に従う
 * - デモ打刻（is_demo=true）は常に除外する
 *
 * 補正履歴の target_field 規約:
 *   attendance 本体   … 'clock_in_at' | 'clock_out_at'
 *   休憩（行を特定） … 'break_start_at#<break_id>' | 'break_end_at#<break_id>'
 */

export interface AttBreak {
  id: string
  break_start_at: string
  break_end_at: string | null
}

export interface AttRow {
  id: string
  staff_id: string
  store_id: string
  clock_in_at: string
  clock_out_at: string | null
  gps_status: string
  staff_name: string
  store_name: string
  breaks: AttBreak[]
}

const ROW_SELECT =
  'id, staff_id, store_id, clock_in_at, clock_out_at, gps_status, staff (full_name), stores (name), attendance_breaks (id, break_start_at, break_end_at)'

function toRow(r: Record<string, unknown>): AttRow {
  const staff = r.staff as { full_name: string } | null
  const store = r.stores as { name: string } | null
  const breaks = ((r.attendance_breaks ?? []) as AttBreak[]).slice()
  breaks.sort((a, b) => a.break_start_at.localeCompare(b.break_start_at))
  return {
    id: r.id as string,
    staff_id: r.staff_id as string,
    store_id: r.store_id as string,
    clock_in_at: r.clock_in_at as string,
    clock_out_at: r.clock_out_at as string | null,
    gps_status: r.gps_status as string,
    staff_name: staff?.full_name ?? '(不明)',
    store_name: store?.name ?? '', // RLSで店舗が見えない場合は空 → 画面側で解決
    breaks,
  }
}

/** 日別: その日（端末ローカル 00:00〜24:00）に出勤した行。デモ除外。 */
export async function fetchDay(day: string, storeId?: string | null): Promise<AttRow[]> {
  const supabase = await getSupabase()
  const start = new Date(`${day}T00:00:00`)
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000)

  let q = supabase
    .from('attendance')
    .select(ROW_SELECT)
    .eq('is_demo', false)
    .gte('clock_in_at', start.toISOString())
    .lt('clock_in_at', end.toISOString())
    .order('clock_in_at')
  if (storeId) q = q.eq('store_id', storeId)

  const { data, error } = await q
  if (error) throw error
  return (data ?? []).map((r) => toRow(r as Record<string, unknown>))
}

/** スタッフ別×期間。デモ除外。 */
export async function fetchStaffRange(
  staffId: string,
  fromDay: string,
  toDay: string,
): Promise<AttRow[]> {
  const supabase = await getSupabase()
  const start = new Date(`${fromDay}T00:00:00`)
  const end = new Date(new Date(`${toDay}T00:00:00`).getTime() + 24 * 60 * 60 * 1000)

  const { data, error } = await supabase
    .from('attendance')
    .select(ROW_SELECT)
    .eq('is_demo', false)
    .eq('staff_id', staffId)
    .gte('clock_in_at', start.toISOString())
    .lt('clock_in_at', end.toISOString())
    .order('clock_in_at')
  if (error) throw error
  return (data ?? []).map((r) => toRow(r as Record<string, unknown>))
}

/**
 * 期間内の全スタッフ分（CSV用）。デモ除外・RLSスコープ内。
 * 大量件数に備えて1000行ずつ分割取得する。
 */
export async function fetchRangeAll(
  fromDay: string,
  toDay: string,
  storeId?: string | null,
): Promise<AttRow[]> {
  const supabase = await getSupabase()
  const start = new Date(`${fromDay}T00:00:00`)
  const end = new Date(new Date(`${toDay}T00:00:00`).getTime() + 24 * 60 * 60 * 1000)

  const PAGE = 1000
  const all: AttRow[] = []
  for (let offset = 0; ; offset += PAGE) {
    let q = supabase
      .from('attendance')
      .select(ROW_SELECT)
      .eq('is_demo', false)
      .gte('clock_in_at', start.toISOString())
      .lt('clock_in_at', end.toISOString())
      .order('clock_in_at')
      .range(offset, offset + PAGE - 1)
    if (storeId) q = q.eq('store_id', storeId)

    const { data, error } = await q
    if (error) throw error
    const page = (data ?? []).map((r) => toRow(r as Record<string, unknown>))
    all.push(...page)
    if (page.length < PAGE) break
  }
  return all
}

async function currentUserId(): Promise<string> {
  const supabase = await getSupabase()
  const { data } = await supabase.auth.getSession()
  const uid = data.session?.user.id
  if (!uid) throw new Error('ログインが必要です。')
  return uid
}

/* ------------------------- 補正A: 管理者の直接修正 ------------------------- */

export interface FieldChange {
  /** 'clock_in_at' | 'clock_out_at' | 'break_start_at#<id>' | 'break_end_at#<id>' */
  target: string
  oldValue: string | null
  newValue: string
}

/**
 * attendance / attendance_breaks を直接更新し、同時に補正履歴（approved）を残す。
 * 権限は RLS（att_upd / brk_write / corr_ins）が最終防壁。
 */
export async function applyDirectCorrection(
  tenantId: string,
  attendanceId: string,
  changes: FieldChange[],
  reason: string,
): Promise<void> {
  if (changes.length === 0) return
  const supabase = await getSupabase()
  const uid = await currentUserId()

  for (const c of changes) {
    await applyFieldUpdate(attendanceId, c.target, c.newValue)
    const { error } = await supabase.from('attendance_corrections').insert({
      tenant_id: tenantId,
      attendance_id: attendanceId,
      requested_by: uid,
      target_field: c.target,
      old_value: c.oldValue,
      new_value: c.newValue,
      reason,
      status: 'approved',
      approved_by: uid,
    })
    if (error) throw error
  }
}

/** target_field 規約に従って attendance / attendance_breaks を1フィールド更新する */
async function applyFieldUpdate(
  attendanceId: string,
  target: string,
  newValue: string,
): Promise<void> {
  const supabase = await getSupabase()
  const [field, breakId] = target.split('#')

  if (field === 'clock_in_at' || field === 'clock_out_at') {
    const patch =
      field === 'clock_in_at' ? { clock_in_at: newValue } : { clock_out_at: newValue }
    const { error } = await supabase.from('attendance').update(patch).eq('id', attendanceId)
    if (error) throw error
    return
  }
  if ((field === 'break_start_at' || field === 'break_end_at') && breakId) {
    const patch =
      field === 'break_start_at' ? { break_start_at: newValue } : { break_end_at: newValue }
    const { error } = await supabase.from('attendance_breaks').update(patch).eq('id', breakId)
    if (error) throw error
    return
  }
  throw new Error(`不明な補正対象です: ${target}`)
}

/* --------------------------- 補正B: スタッフ申請 --------------------------- */

export async function requestCorrection(
  tenantId: string,
  attendanceId: string,
  target: string,
  oldValue: string | null,
  newValue: string,
  reason: string,
): Promise<void> {
  const supabase = await getSupabase()
  const uid = await currentUserId()
  const { error } = await supabase.from('attendance_corrections').insert({
    tenant_id: tenantId,
    attendance_id: attendanceId,
    requested_by: uid,
    target_field: target,
    old_value: oldValue,
    new_value: newValue,
    reason,
    status: 'pending',
  })
  if (error) throw error
}

/* ------------------------------ 承認待ち一覧 ------------------------------ */

export interface PendingCorrection {
  id: string
  attendance_id: string
  target_field: string
  old_value: string | null
  new_value: string | null
  reason: string | null
  created_at: string
  staff_name: string
  store_id: string
  store_name: string
  clock_in_at: string
}

export async function fetchPending(): Promise<PendingCorrection[]> {
  const supabase = await getSupabase()
  const { data, error } = await supabase
    .from('attendance_corrections')
    .select(
      'id, attendance_id, target_field, old_value, new_value, reason, created_at, attendance (clock_in_at, store_id, staff (full_name), stores (name))',
    )
    .eq('status', 'pending')
    .order('created_at')
  if (error) throw error

  return (data ?? []).map((c) => {
    const att = c.attendance as unknown as {
      clock_in_at: string
      store_id: string
      staff: { full_name: string } | null
      stores: { name: string } | null
    } | null
    return {
      id: c.id,
      attendance_id: c.attendance_id,
      target_field: c.target_field,
      old_value: c.old_value,
      new_value: c.new_value,
      reason: c.reason,
      created_at: c.created_at,
      staff_name: att?.staff?.full_name ?? '(不明)',
      store_id: att?.store_id ?? '',
      store_name: att?.stores?.name ?? '',
      clock_in_at: att?.clock_in_at ?? '',
    }
  })
}

/** 承認: attendance を実際に更新し、status='approved' にする。メモは reason に追記。 */
export async function approveCorrection(c: PendingCorrection, note?: string): Promise<void> {
  const supabase = await getSupabase()
  const uid = await currentUserId()
  if (!c.new_value) throw new Error('希望時刻が空のため承認できません。')

  await applyFieldUpdate(c.attendance_id, c.target_field, c.new_value)

  const reason = note?.trim() ? `${c.reason ?? ''}\n[承認メモ] ${note.trim()}` : c.reason
  const { error } = await supabase
    .from('attendance_corrections')
    .update({ status: 'approved', approved_by: uid, reason })
    .eq('id', c.id)
  if (error) throw error
}

/** 却下: attendance は変更しない。メモは reason に追記。 */
export async function rejectCorrection(c: PendingCorrection, note?: string): Promise<void> {
  const supabase = await getSupabase()
  const uid = await currentUserId()
  const reason = note?.trim() ? `${c.reason ?? ''}\n[却下メモ] ${note.trim()}` : c.reason
  const { error } = await supabase
    .from('attendance_corrections')
    .update({ status: 'rejected', approved_by: uid, reason })
    .eq('id', c.id)
  if (error) throw error
}

/* ------------------------- 補正履歴（1打刻ぶん） ------------------------- */

export interface CorrectionEntry {
  id: string
  target_field: string
  old_value: string | null
  new_value: string | null
  reason: string | null
  status: string
  created_at: string
  /** 操作した人の表示名（staff 紐付けが無い uid は「管理者」） */
  actor_name: string
  /** 申請型（pending 起点）か、管理者の直接修正か */
  is_direct: boolean
}

/**
 * その attendance の補正履歴を新しい順に返す。
 * 可視性は 0006 の corr_sel（RLS）が最終防壁：
 * スタッフは staff_see_corrections=false のとき 0 件になる（エラーではない）。
 * uid → 氏名の解決は staff.user_id 経由（staff_sel はメンバー全員が SELECT 可）。
 */
export async function fetchCorrectionsFor(attendanceId: string): Promise<CorrectionEntry[]> {
  const supabase = await getSupabase()
  const { data, error } = await supabase
    .from('attendance_corrections')
    .select('id, target_field, old_value, new_value, reason, status, created_at, requested_by, approved_by')
    .eq('attendance_id', attendanceId)
    .order('created_at', { ascending: false })
  if (error) throw error
  const rows = data ?? []
  if (rows.length === 0) return []

  // 関係者の uid をまとめて氏名解決（owner 等 staff 行が無い uid は「管理者」）
  const uids = [
    ...new Set(rows.flatMap((r) => [r.requested_by, r.approved_by]).filter((v): v is string => !!v)),
  ]
  const names = new Map<string, string>()
  if (uids.length > 0) {
    const { data: staffRows } = await supabase
      .from('staff')
      .select('user_id, full_name')
      .in('user_id', uids)
    for (const s of staffRows ?? []) {
      if (s.user_id) names.set(s.user_id, s.full_name)
    }
  }
  const nameOf = (uid: string | null) => (uid ? (names.get(uid) ?? '管理者') : '—')

  return rows.map((r) => {
    const direct = r.status === 'approved' && !!r.requested_by && r.requested_by === r.approved_by
    // 直接修正なら操作者=承認者。申請型なら起票者を主に表示する
    const actor = direct ? nameOf(r.approved_by) : nameOf(r.requested_by)
    return {
      id: r.id,
      target_field: r.target_field,
      old_value: r.old_value,
      new_value: r.new_value,
      reason: r.reason,
      status: r.status,
      created_at: r.created_at,
      actor_name: actor,
      is_direct: direct,
    }
  })
}

/** target_field 規約 → 画面表示ラベル */
export function targetLabel(target: string): string {
  const [field] = target.split('#')
  switch (field) {
    case 'clock_in_at':
      return '出勤'
    case 'clock_out_at':
      return '退勤'
    case 'break_start_at':
      return '休憩開始'
    case 'break_end_at':
      return '休憩終了'
    default:
      return target
  }
}
