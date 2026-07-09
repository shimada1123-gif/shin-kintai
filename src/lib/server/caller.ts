import { getRequestHeader } from '@tanstack/react-start/server'
import { getAdminClient } from '@/lib/supabase-admin.server'
import type { Role } from '@/lib/me-context'
import { assert, type Caller } from './permissions'

/**
 * 呼び出し元の同定。すべての Server Function の最初に必ず通す。
 *
 * クライアントが自己申告する user_id は一切信用せず、Authorization の Bearer を
 * Supabase 自身に検証させて user を確定してから membership を引く。
 */
export async function requireCaller(): Promise<Caller> {
  const authHeader = getRequestHeader('authorization')
  const token = authHeader?.replace(/^Bearer\s+/i, '')
  assert(token, 'ログインが必要です。')

  const admin = getAdminClient()

  const { data: userData, error: userErr } = await admin.auth.getUser(token)
  assert(!userErr && userData.user, 'セッションが無効です。再度ログインしてください。')

  const { data: membership, error: memErr } = await admin
    .from('memberships')
    .select('tenant_id, role, scope_area_id, scope_store_id')
    .eq('user_id', userData.user.id)
    .maybeSingle()

  assert(!memErr, 'membership の取得に失敗しました。')
  assert(membership, 'このアカウントは、どのテナントにも所属していません。')

  return {
    userId: userData.user.id,
    tenantId: membership.tenant_id,
    role: membership.role as Role,
    scopeAreaId: membership.scope_area_id,
    scopeStoreId: membership.scope_store_id,
  }
}
