import { getSupabase } from '@/lib/auth/supabase-client'
import { toInteger, toIntegerOrZero } from '@/lib/number'
import type { Tables } from '@/lib/supabase'

/**
 * スタッフ・店舗マスタのデータ層。
 * すべて通常のログインセッションで実行し、可視範囲と書き込み可否は RLS に委ねる。
 * service_role は使わない。
 */

export type Assignment = Tables<'staff_assignments'>
export type Store = Tables<'stores'>
export type EmploymentKind = Tables<'employment_kinds'>
export type Position = Tables<'positions'>

export interface StaffWithDetails {
  id: string
  full_name: string
  status: string
  tags: string[]
  assignments: Assignment[]
}

/* ------------------------------- 取得 ------------------------------- */

export async function fetchStaffList(): Promise<StaffWithDetails[]> {
  const supabase = await getSupabase()
  const { data, error } = await supabase
    .from('staff')
    .select('id, full_name, status, staff_tags (tag), staff_assignments (*)')
    .order('full_name')
  if (error) throw error

  return (data ?? []).map((s) => ({
    id: s.id,
    full_name: s.full_name,
    status: s.status,
    // staff_assignments は wage_individual_view を持たない役割には RLS で見えない
    tags: ((s.staff_tags ?? []) as { tag: string }[]).map((t) => t.tag),
    assignments: (s.staff_assignments ?? []) as Assignment[],
  }))
}

export async function fetchStores(): Promise<Store[]> {
  const supabase = await getSupabase()
  const { data, error } = await supabase.from('stores').select('*').order('name')
  if (error) throw error
  return data ?? []
}

export async function fetchEmploymentKinds(): Promise<EmploymentKind[]> {
  const supabase = await getSupabase()
  const { data, error } = await supabase.from('employment_kinds').select('*').order('label')
  if (error) throw error
  return data ?? []
}

export async function fetchPositions(): Promise<Position[]> {
  const supabase = await getSupabase()
  const { data, error } = await supabase.from('positions').select('*').order('name')
  if (error) throw error
  return data ?? []
}

/* ------------------------------ スタッフ ------------------------------ */

export interface CreateStaffArgs {
  tenantId: string
  fullName: string
  storeId: string
  employmentKindId: string | null
  wageType: 'hourly' | 'fixed' | 'invoice'
  /** 未入力は null */
  amount: number | null
}

export async function createStaff(a: CreateStaffArgs): Promise<string> {
  const supabase = await getSupabase()

  const { data: staff, error: staffErr } = await supabase
    .from('staff')
    .insert({ tenant_id: a.tenantId, full_name: a.fullName })
    .select('id')
    .single()
  if (staffErr) throw staffErr

  const { error: saErr } = await supabase.from('staff_assignments').insert({
    tenant_id: a.tenantId,
    staff_id: staff.id,
    store_id: a.storeId,
    employment_kind_id: a.employmentKindId,
    wage_type: a.wageType,
    hourly_wage: a.wageType === 'hourly' ? toInteger(a.amount) : null,
    monthly_fixed: a.wageType === 'fixed' ? toInteger(a.amount) : null,
  })
  if (saErr) {
    // 所属を作れなかったスタッフ行は残さない
    await supabase.from('staff').delete().eq('id', staff.id)
    throw saErr
  }

  return staff.id
}

/**
 * 編集中の所属。commute_amount は DB では NOT NULL だが、
 * UI 上は「未入力」を 0 と区別したいので null を許し、保存時に整数化する。
 */
export type AssignmentDraft = Omit<Assignment, 'id' | 'created_at' | 'commute_amount'> & {
  id?: string
  commute_amount: number | null
}

export interface SaveStaffArgs {
  tenantId: string
  staffId: string
  fullName: string
  tags: string[]
  originalTags: string[]
  assignments: AssignmentDraft[]
  removedAssignmentIds: string[]
}

/** staff / staff_tags / staff_assignments をまとめて更新する */
export async function saveStaff(a: SaveStaffArgs): Promise<void> {
  const supabase = await getSupabase()

  const { error: nameErr } = await supabase
    .from('staff')
    .update({ full_name: a.fullName })
    .eq('id', a.staffId)
  if (nameErr) throw nameErr

  const added = a.tags.filter((t) => !a.originalTags.includes(t))
  const removed = a.originalTags.filter((t) => !a.tags.includes(t))

  if (removed.length > 0) {
    const { error } = await supabase
      .from('staff_tags')
      .delete()
      .eq('staff_id', a.staffId)
      .in('tag', removed)
    if (error) throw error
  }
  if (added.length > 0) {
    const { error } = await supabase
      .from('staff_tags')
      .insert(added.map((tag) => ({ tenant_id: a.tenantId, staff_id: a.staffId, tag })))
    if (error) throw error
  }

  if (a.removedAssignmentIds.length > 0) {
    const { error } = await supabase
      .from('staff_assignments')
      .delete()
      .in('id', a.removedAssignmentIds)
    if (error) throw error
  }

  for (const asg of a.assignments) {
    // integer カラムへは必ず整数を送る。未入力は null（commute_amount は NOT NULL なので 0）
    const payload = {
      tenant_id: a.tenantId,
      staff_id: a.staffId,
      store_id: asg.store_id,
      employment_kind_id: asg.employment_kind_id,
      position_default_id: asg.position_default_id,
      wage_type: asg.wage_type,
      hourly_wage: asg.wage_type === 'hourly' ? toInteger(asg.hourly_wage) : null,
      monthly_fixed: asg.wage_type === 'fixed' ? toInteger(asg.monthly_fixed) : null,
      commute_type: asg.commute_type,
      commute_amount: asg.commute_type === 'none' ? 0 : toIntegerOrZero(asg.commute_amount),
      is_newbie: asg.is_newbie,
      is_trainer: asg.is_trainer,
      is_active: asg.is_active,
    }

    if (asg.id) {
      const { error } = await supabase.from('staff_assignments').update(payload).eq('id', asg.id)
      if (error) throw error
    } else {
      const { error } = await supabase.from('staff_assignments').insert(payload)
      if (error) throw error
    }
  }
}

/* ------------------------------- 店舗 ------------------------------- */

export interface StoreDraft {
  id?: string
  tenant_id: string
  name: string
  area_id: string | null
  lat: number | null
  lng: number | null
  geofence_radius_m: number
  gps_policy: 'flag' | 'block'
}

export async function saveStore(d: StoreDraft): Promise<void> {
  const supabase = await getSupabase()
  const payload = {
    tenant_id: d.tenant_id,
    name: d.name,
    area_id: d.area_id,
    lat: d.lat,
    lng: d.lng,
    geofence_radius_m: d.geofence_radius_m,
    gps_policy: d.gps_policy,
  }

  if (d.id) {
    const { error } = await supabase.from('stores').update(payload).eq('id', d.id)
    if (error) throw error
  } else {
    const { error } = await supabase.from('stores').insert(payload)
    if (error) throw error
  }
}

/* -------------------- 雇用区分 / ポジション の簡易マスタ -------------------- */

/** 作成した行の id を返す（追加直後にセレクトで選択するため） */
export async function createEmploymentKind(
  tenantId: string,
  label: string,
  opts: { is_hourly: boolean; requires_clock: boolean; applies_premium: boolean },
): Promise<string> {
  const supabase = await getSupabase()
  const { data, error } = await supabase
    .from('employment_kinds')
    .insert({ tenant_id: tenantId, label, ...opts })
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

export async function deleteEmploymentKind(id: string): Promise<void> {
  const supabase = await getSupabase()
  const { error } = await supabase.from('employment_kinds').delete().eq('id', id)
  if (error) throw error
}

/** 作成した行の id を返す（追加直後にセレクトで選択するため） */
export async function createPosition(
  tenantId: string,
  name: string,
  storeId: string | null,
): Promise<string> {
  const supabase = await getSupabase()
  const { data, error } = await supabase
    .from('positions')
    .insert({ tenant_id: tenantId, name, store_id: storeId })
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

export async function deletePosition(id: string): Promise<void> {
  const supabase = await getSupabase()
  const { error } = await supabase.from('positions').delete().eq('id', id)
  if (error) throw error
}
