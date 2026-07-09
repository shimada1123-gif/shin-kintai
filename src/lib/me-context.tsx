import { createContext, useContext } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Tables } from '@/lib/supabase'
import { getSupabase } from '@/lib/auth/supabase-client'
import { useAuth } from '@/lib/auth'

export type Role = 'owner' | 'area_manager' | 'store_manager' | 'staff'

export interface MeContext {
  role: Role
  tenantId: string
  tenantName: string
  scopeAreaId: string | null
  scopeStoreId: string | null
  staffId: string | null
  staffName: string | null
  stores: Tables<'stores'>[]
  areas: Tables<'areas'>[]
}

/** ヘッダーに出す「SCOPE」表示: 全社 / エリア名 / 店舗名 */
export function scopeLabel(me: MeContext): string {
  if (me.role === 'owner') return '全社'
  if (me.role === 'area_manager') {
    const area = me.areas.find((a) => a.id === me.scopeAreaId)
    return area ? area.name : 'エリア未設定'
  }
  const store = me.stores.find((s) => s.id === me.scopeStoreId)
  return store ? store.name : '店舗未設定'
}

export const ROLE_LABEL: Record<Role, string> = {
  owner: 'オーナー',
  area_manager: 'エリアマネージャー',
  store_manager: '店長',
  staff: 'スタッフ',
}

async function fetchMe(userId: string): Promise<MeContext> {
  const supabase = await getSupabase()

  const { data: membership, error: memErr } = await supabase
    .from('memberships')
    .select('role, tenant_id, scope_area_id, scope_store_id, staff_id')
    .eq('user_id', userId)
    .maybeSingle()

  if (memErr) throw new Error(`membership の取得に失敗しました: ${memErr.message}`)
  if (!membership) {
    throw new Error(
      'このアカウントに membership がありません。管理者にテナントへの追加を依頼してください。',
    )
  }

  // stores / areas は RLS のスコープに任せて素直に select する
  const [tenantRes, storesRes, areasRes, staffRes] = await Promise.all([
    supabase.from('tenants').select('name').eq('id', membership.tenant_id).maybeSingle(),
    supabase.from('stores').select('*').order('name'),
    supabase.from('areas').select('*').order('name'),
    membership.staff_id
      ? supabase.from('staff').select('full_name').eq('id', membership.staff_id).maybeSingle()
      : Promise.resolve({ data: null, error: null } as const),
  ])

  if (tenantRes.error) throw new Error(`テナントの取得に失敗しました: ${tenantRes.error.message}`)
  if (storesRes.error) throw new Error(`店舗の取得に失敗しました: ${storesRes.error.message}`)
  if (areasRes.error) throw new Error(`エリアの取得に失敗しました: ${areasRes.error.message}`)

  return {
    role: membership.role as Role,
    tenantId: membership.tenant_id,
    tenantName: tenantRes.data?.name ?? '(テナント名不明)',
    scopeAreaId: membership.scope_area_id,
    scopeStoreId: membership.scope_store_id,
    staffId: membership.staff_id,
    staffName: staffRes.data?.full_name ?? null,
    stores: storesRes.data ?? [],
    areas: areasRes.data ?? [],
  }
}

interface MeState {
  me: MeContext | null
  loading: boolean
  error: Error | null
}

const Ctx = createContext<MeState>({ me: null, loading: true, error: null })

export function MeProvider({ children }: { children: React.ReactNode }) {
  const { user, loading: authLoading } = useAuth()

  // enabled で「initialResolved 後」に限定し、queryKey で重複発火をデデュープする。
  // これにより INITIAL_SESSION と復元 SIGNED_IN が二重に来ても fetch は 1 回。
  const { data, isPending, error } = useQuery({
    queryKey: ['me_context', user?.id],
    queryFn: () => fetchMe(user!.id),
    enabled: !authLoading && !!user,
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnReconnect: false,
    retry: false,
  })

  const value: MeState = {
    me: data ?? null,
    loading: authLoading || (!!user && isPending),
    error: (error as Error) ?? null,
  }

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useMe() {
  return useContext(Ctx)
}

/** me が確定している前提のコンポーネント用 */
export function useMeOrThrow(): MeContext {
  const { me } = useMe()
  if (!me) throw new Error('MeContext がまだ解決していません')
  return me
}
