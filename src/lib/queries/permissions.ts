import { getSupabase } from '@/lib/auth/supabase-client'

/**
 * 権限設定（role_permissions）のデータ層。通常セッション + RLS のみ。
 * - 読み取りは rp_sel（メンバー全員。自分の権限判定に必要なため）
 * - 書き込みは rp_write（owner のみ）。owner 以外が叩いても RLS が弾く
 * - owner は行を持たず app_has_perm が常時 true（この設計を壊さない：
 *   ここで扱う role は編集可能な3ロールのみで、owner 行は作らない）
 */

export type EditableRole = 'area_manager' | 'store_manager' | 'staff'

export const EDITABLE_ROLES: EditableRole[] = ['area_manager', 'store_manager', 'staff']

export interface PermRow {
  role: EditableRole
  permission_key: string
  allowed: boolean
}

export async function fetchRolePermissions(tenantId: string): Promise<PermRow[]> {
  const supabase = await getSupabase()
  const { data, error } = await supabase
    .from('role_permissions')
    .select('role, permission_key, allowed')
    .eq('tenant_id', tenantId)
  if (error) throw error
  return (data ?? []) as PermRow[]
}

/**
 * 1トグル分の保存。既存行は更新、無い組み合わせ（将来キー等）は作成される。
 * unique(tenant_id, role, permission_key) が 0001 にあるため upsert が成立する。
 */
export async function setRolePermission(
  tenantId: string,
  role: EditableRole,
  permissionKey: string,
  allowed: boolean,
): Promise<void> {
  if (typeof allowed !== 'boolean') throw new Error('不正な値です。')
  const supabase = await getSupabase()
  const { error } = await supabase
    .from('role_permissions')
    .upsert(
      { tenant_id: tenantId, role, permission_key: permissionKey, allowed },
      { onConflict: 'tenant_id,role,permission_key' },
    )
  if (error) throw error
}
