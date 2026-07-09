import { useQuery } from '@tanstack/react-query'
import { getSupabase } from '@/lib/auth/supabase-client'
import { useMe } from '@/lib/me-context'

export type PermissionKey =
  | 'roster_view_today'
  | 'correction_approve'
  | 'shift_edit'
  | 'labor_cost_view'
  | 'wage_individual_view'
  | 'payslip_view'
  | 'staff_master_edit'

/**
 * role_permissions を読んで権限を判定する。
 * owner は行を持たず常時フル（0001/0003 の設計）。
 *
 * これは画面の出し分けのためだけの判定であり、実際の防壁は RLS。
 * ここが true でも RLS が拒否すれば書き込みは失敗する。
 */
export function usePermissions() {
  const { me } = useMe()

  const query = useQuery({
    queryKey: ['role_permissions', me?.tenantId, me?.role],
    enabled: !!me && me.role !== 'owner',
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const supabase = await getSupabase()
      const { data, error } = await supabase
        .from('role_permissions')
        .select('permission_key, allowed')
        .eq('tenant_id', me!.tenantId)
        .eq('role', me!.role)
      if (error) throw error
      return data ?? []
    },
  })

  const isOwner = me?.role === 'owner'

  const has = (key: PermissionKey): boolean => {
    if (!me) return false
    if (isOwner) return true
    return query.data?.some((r) => r.permission_key === key && r.allowed) ?? false
  }

  return { has, loading: !isOwner && query.isPending, error: query.error as Error | null }
}
