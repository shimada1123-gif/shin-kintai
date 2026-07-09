import { getSupabase } from '@/lib/auth/supabase-client'
import type { Json } from '@/lib/database.types'

/**
 * tenants.settings の staff_see_corrections トグル。
 * 通常セッション + RLS（tenants_upd = owner のみ更新可）で操作する。
 *
 * 重要: RLS の app_staff_see_corr が (settings->>'staff_see_corrections')::boolean を
 * cast するため、JSON boolean 以外（"yes" 等の文字列や null）を書くと
 * 補正履歴の全クエリが実行時エラーになる。必ず boolean で書き込むこと。
 */

export async function fetchStaffSeeCorrections(tenantId: string): Promise<boolean> {
  const supabase = await getSupabase()
  const { data, error } = await supabase
    .from('tenants')
    .select('settings')
    .eq('id', tenantId)
    .maybeSingle()
  if (error) throw error
  const s = (data?.settings ?? {}) as { staff_see_corrections?: unknown }
  // 既定（キー未設定）は true = 見せる
  return s.staff_see_corrections !== false
}

export async function setStaffSeeCorrections(tenantId: string, enabled: boolean): Promise<void> {
  if (typeof enabled !== 'boolean') throw new Error('不正な値です。')

  const supabase = await getSupabase()
  // 他のキー（test_mode 等）を保存するため read-modify-write
  const { data, error } = await supabase
    .from('tenants')
    .select('settings')
    .eq('id', tenantId)
    .maybeSingle()
  if (error) throw error

  const current = (data?.settings ?? {}) as Record<string, Json>
  // enabled === true で二重に boolean を保証する（cast 脆弱性回避）
  const next: Record<string, Json> = { ...current, staff_see_corrections: enabled === true }

  const { error: upErr } = await supabase.from('tenants').update({ settings: next }).eq('id', tenantId)
  if (upErr) throw upErr
}
