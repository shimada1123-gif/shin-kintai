import { createServerFn } from '@tanstack/react-start'
import { getAdminClient } from '@/lib/supabase-admin.server'
import { requireCaller } from './caller'
import { assert } from './permissions'

/** テストモードの現在値 */
export const getTestMode = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{ test_mode: boolean }> => {
    const caller = await requireCaller()
    const admin = getAdminClient()
    const { data } = await admin
      .from('tenants')
      .select('settings')
      .eq('id', caller.tenantId)
      .maybeSingle()
    const settings = (data?.settings ?? {}) as { test_mode?: boolean }
    return { test_mode: settings.test_mode === true }
  },
)

/** テストモードの切替。owner のみ。settings.test_mode は必ず JSON boolean で書く。 */
export const setTestMode = createServerFn({ method: 'POST' })
  .inputValidator((d: { enabled: boolean }) => {
    assert(typeof d.enabled === 'boolean', '不正な値です。')
    return d
  })
  .handler(async ({ data }): Promise<{ test_mode: boolean }> => {
    const caller = await requireCaller()
    assert(caller.role === 'owner', 'テストモードを切り替えられるのはオーナーだけです。')

    const admin = getAdminClient()
    const { data: tenant } = await admin
      .from('tenants')
      .select('settings')
      .eq('id', caller.tenantId)
      .maybeSingle()
    assert(tenant, 'テナントが見つかりません。')

    const current = (tenant.settings ?? {}) as Record<string, unknown>
    // boolean 以外を入れると RLS の (settings->>'test_mode')::boolean が実行時エラーになる
    const next = { ...current, test_mode: data.enabled }

    const { error } = await admin.from('tenants').update({ settings: next }).eq('id', caller.tenantId)
    assert(!error, 'テストモードを更新できませんでした。')

    return { test_mode: data.enabled }
  })

/** 店舗の GPS ポリシー更新。owner、または staff_master_edit を持つ役割。 */
export const setGpsPolicy = createServerFn({ method: 'POST' })
  .inputValidator((d: { store_id: string; gps_policy: 'off' | 'flag' | 'block' }) => {
    assert(d.store_id, '店舗が指定されていません。')
    assert(['off', 'flag', 'block'].includes(d.gps_policy), '不正なGPSポリシーです。')
    return d
  })
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const caller = await requireCaller()
    const admin = getAdminClient()

    const { data: store } = await admin
      .from('stores')
      .select('id, tenant_id, area_id')
      .eq('id', data.store_id)
      .maybeSingle()
    assert(store && store.tenant_id === caller.tenantId, '店舗が見つかりません。')

    if (caller.role !== 'owner') {
      const { data: perm } = await admin
        .from('role_permissions')
        .select('allowed')
        .eq('tenant_id', caller.tenantId)
        .eq('role', caller.role)
        .eq('permission_key', 'staff_master_edit')
        .maybeSingle()
      assert(perm?.allowed === true, 'GPSポリシーを変更する権限がありません。')

      if (caller.role === 'area_manager') {
        assert(store.area_id === caller.scopeAreaId, '自分のエリア外の店舗です。')
      }
      if (caller.role === 'store_manager') {
        assert(store.id === caller.scopeStoreId, '自分の店舗以外は変更できません。')
      }
    }

    const { error } = await admin
      .from('stores')
      .update({ gps_policy: data.gps_policy })
      .eq('id', data.store_id)
    assert(!error, 'GPSポリシーを更新できませんでした。')

    return { ok: true }
  })
