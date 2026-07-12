import { getSupabase } from '@/lib/auth/supabase-client'
import type { Store } from '@/lib/queries/master'

/**
 * 賄い（0030）のデータ層。すべて呼び出し者JWT。
 * - 記録の書込は app_upsert_meal のみ（entered_by と price_snapshot はサーバが決める。
 *   クライアントから送らない＝なりすまし・単価の付け替えを構造的に不能にする）。
 * - 集計は app_meal_summary（本人=自分のみ / 店長=全員 を関数側が分岐）。
 * - 記録の読取は meal_records の直 select（RLS が 本人=自分 / 店長=自店全員 に絞る）。
 */

export type MealType = 'breakfast' | 'lunch' | 'dinner'

export const MEAL_TYPES: { key: MealType; label: string; short: string }[] = [
  { key: 'breakfast', label: '朝', short: '朝' },
  { key: 'lunch', label: '昼', short: '昼' },
  { key: 'dinner', label: '晩', short: '晩' },
]

/* ---------------- 賄いマスタ（stores.settings.meal_pricing） ---------------- */

export interface MealPricing {
  free: boolean
  breakfast: number
  lunch: number
  dinner: number
}

const EMPTY_PRICING: MealPricing = { free: false, breakfast: 0, lunch: 0, dinner: 0 }

/** settings から賄い単価を安全に読む（未設定は 0 / free=false） */
export function mealPricingOf(store: Store): MealPricing {
  const raw = (store.settings as { meal_pricing?: unknown } | null)?.meal_pricing
  if (!raw || typeof raw !== 'object') return { ...EMPTY_PRICING }
  const p = raw as Record<string, unknown>
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0)
  return {
    free: p.free === true,
    breakfast: num(p.breakfast),
    lunch: num(p.lunch),
    dinner: num(p.dinner),
  }
}

/** 賄い単価の保存。settings の他キー（closed_dows 等）を壊さないようマージ更新 */
export async function updateMealPricing(storeId: string, pricing: MealPricing): Promise<void> {
  const supabase = await getSupabase()
  const { data: cur, error: selErr } = await supabase
    .from('stores')
    .select('settings')
    .eq('id', storeId)
    .maybeSingle()
  if (selErr) throw selErr
  const merged = {
    ...((cur?.settings as Record<string, unknown> | null) ?? {}),
    meal_pricing: {
      free: pricing.free,
      breakfast: Math.max(0, Math.trunc(pricing.breakfast)),
      lunch: Math.max(0, Math.trunc(pricing.lunch)),
      dinner: Math.max(0, Math.trunc(pricing.dinner)),
    },
  }
  const { error } = await supabase.from('stores').update({ settings: merged }).eq('id', storeId)
  if (error) throw error
}

/* ---------------- 記録（meal_records） ---------------- */

export interface MealRecord {
  staff_id: string
  work_date: string
  meal_type: MealType
  price_snapshot: number
  /** 誰が入れたか（本人 / 店長）。サーバが決めた値 */
  entered_by: 'self' | 'manager'
}

/** その店・期間の賄い記録。RLS で 本人=自分のみ / 店長=自店全員 に絞られる */
export async function fetchMealRecords(a: {
  storeId: string
  from: string
  to: string
}): Promise<MealRecord[]> {
  const supabase = await getSupabase()
  const { data, error } = await supabase
    .from('meal_records')
    .select('staff_id, work_date, meal_type, price_snapshot, entered_by')
    .eq('store_id', a.storeId)
    .gte('work_date', a.from)
    .lte('work_date', a.to)
  if (error) throw error
  return (data ?? []) as MealRecord[]
}

/** 本人の賄い記録（複数店に勤務していてもまとめて。RLS で自分の行しか返らない） */
export async function fetchMyMealRecords(a: {
  staffId: string
  from: string
  to: string
}): Promise<MealRecord[]> {
  const supabase = await getSupabase()
  const { data, error } = await supabase
    .from('meal_records')
    .select('staff_id, work_date, meal_type, price_snapshot, entered_by')
    .eq('staff_id', a.staffId)
    .gte('work_date', a.from)
    .lte('work_date', a.to)
  if (error) throw error
  return (data ?? []) as MealRecord[]
}

/**
 * 記録/取消。present=true→upsert（サーバが settings から単価を焼く）、false→delete。
 * entered_by / price_snapshot はクライアントから送らない（サーバ決定）。
 */
export async function upsertMeal(a: {
  storeId: string
  staffId: string
  workDate: string
  mealType: MealType
  present: boolean
}): Promise<void> {
  const supabase = await getSupabase()
  const { error } = await supabase.rpc('app_upsert_meal', {
    p_store_id: a.storeId,
    p_staff_id: a.staffId,
    p_work_date: a.workDate,
    p_meal_type: a.mealType,
    p_present: a.present,
  })
  if (error) throw error
}

/* ---------------- 集計（app_meal_summary） ---------------- */

export interface MealSummaryRow {
  staff_id: string
  total_yen: number
  meal_count: number
}

/** 月次集計。本人=自分のみ / 店長=全員 の分岐は関数側（クライアントで他人分を取りに行かない） */
export async function fetchMealSummary(a: {
  storeId: string
  from: string
  to: string
}): Promise<MealSummaryRow[]> {
  const supabase = await getSupabase()
  const { data, error } = await supabase.rpc('app_meal_summary', {
    p_store_id: a.storeId,
    p_from: a.from,
    p_to: a.to,
  })
  if (error) throw error
  return (data ?? []) as MealSummaryRow[]
}
