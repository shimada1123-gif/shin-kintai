// このモジュールはクライアントからも import されるが、createServerFn の handler 本体は
// クライアントバンドルから除去され、RPC スタブだけが残る。service_role を握る
// supabase-admin.server.ts は handler の中でしか参照しないため、クライアント側には届かない。
// （誤って client に混ざれば、build 時の import-protection が **/*.server.* を弾く）
import { createServerFn } from '@tanstack/react-start'
import { getAdminClient } from '@/lib/supabase-admin.server'
import type { Role } from '@/lib/me-context'
import { requireCaller } from './caller'
import {
  assert,
  canAssignRole,
  canManageRole,
  PermissionError,
  type Caller,
} from './permissions'

export interface UserRow {
  membershipId: string
  userId: string
  staffId: string | null
  fullName: string
  email: string
  role: Role
  scopeAreaId: string | null
  scopeStoreId: string | null
  status: 'active' | 'inactive'
}

/** ユーザー管理そのものを行える role か */
function requireUserAdmin(caller: Caller): void {
  assert(caller.role !== 'staff', 'ユーザー管理の権限がありません。')
}

/* ------------------------------------------------------------------ */
/* スコープ検証                                                         */
/* ------------------------------------------------------------------ */

/** 呼び出し元のスコープ内にある店舗 id の集合 */
async function visibleStoreIds(caller: Caller): Promise<string[]> {
  const admin = getAdminClient()
  const { data, error } = await admin
    .from('stores')
    .select('id, area_id')
    .eq('tenant_id', caller.tenantId)

  assert(!error, '店舗の取得に失敗しました。')
  const stores = data ?? []

  if (caller.role === 'owner') return stores.map((s) => s.id)
  if (caller.role === 'area_manager') {
    return stores.filter((s) => s.area_id && s.area_id === caller.scopeAreaId).map((s) => s.id)
  }
  return caller.scopeStoreId ? [caller.scopeStoreId] : []
}

interface ScopeInput {
  role: Role
  scopeAreaId: string | null
  scopeStoreId: string | null
}

/**
 * 割り当てようとしている role とスコープが、呼び出し元の権限内に収まるかを検証する。
 * ここを通らない限り、いかなる書き込みも行わない。
 */
async function assertScopeAllowed(caller: Caller, target: ScopeInput): Promise<void> {
  const admin = getAdminClient()

  // 1. role の昇格防止
  assert(
    canAssignRole(caller.role, target.role),
    `${caller.role} は ${target.role} を割り当てできません。`,
  )

  // 2. owner は tenant 内であれば自由。ただし所属テナントの実在を確認する
  if (target.scopeAreaId) {
    const { data: area } = await admin
      .from('areas')
      .select('id, tenant_id')
      .eq('id', target.scopeAreaId)
      .maybeSingle()
    assert(area && area.tenant_id === caller.tenantId, 'エリアがテナント内に存在しません。')
  }

  let targetStoreAreaId: string | null = null
  if (target.scopeStoreId) {
    const { data: store } = await admin
      .from('stores')
      .select('id, tenant_id, area_id')
      .eq('id', target.scopeStoreId)
      .maybeSingle()
    assert(store && store.tenant_id === caller.tenantId, '店舗がテナント内に存在しません。')
    targetStoreAreaId = store.area_id
  }

  if (caller.role === 'owner') return

  // 3. area_manager: 自エリア内の店舗のみ。エリアスコープの付与は不可
  if (caller.role === 'area_manager') {
    assert(caller.scopeAreaId, '自分のエリアが設定されていません。')
    assert(!target.scopeAreaId, 'エリア管理者は、エリアスコープを割り当てできません。')
    assert(target.scopeStoreId, '店舗を指定してください。')
    assert(targetStoreAreaId === caller.scopeAreaId, '自分のエリア外の店舗は指定できません。')
    return
  }

  // 4. store_manager: 自店の staff のみ
  if (caller.role === 'store_manager') {
    assert(caller.scopeStoreId, '自分の店舗が設定されていません。')
    assert(!target.scopeAreaId, '店長は、エリアスコープを割り当てできません。')
    assert(
      target.scopeStoreId === caller.scopeStoreId,
      '自分の店舗以外にユーザーを作成できません。',
    )
    return
  }

  throw new PermissionError('ユーザー管理の権限がありません。')
}

/** 既存 membership に対する操作可否 */
async function assertCanManageMembership(caller: Caller, membershipId: string) {
  const admin = getAdminClient()
  const { data: target, error } = await admin
    .from('memberships')
    .select('id, tenant_id, user_id, role, scope_area_id, scope_store_id, staff_id')
    .eq('id', membershipId)
    .maybeSingle()

  assert(!error && target, '対象ユーザーが見つかりません。')
  assert(target.tenant_id === caller.tenantId, '他テナントのユーザーは操作できません。')
  assert(target.user_id !== caller.userId, '自分自身の権限は変更できません。')
  assert(
    canManageRole(caller.role, target.role as Role),
    '自分と同等以上の役割のユーザーは操作できません。',
  )

  // スコープ外のユーザーには触れない
  if (caller.role !== 'owner') {
    const storeIds = await visibleStoreIds(caller)
    assert(
      target.scope_store_id && storeIds.includes(target.scope_store_id),
      '自分のスコープ外のユーザーは操作できません。',
    )
  }

  return target
}

/* ------------------------------------------------------------------ */
/* 1. 一覧                                                             */
/* ------------------------------------------------------------------ */

export const adminListUsers = createServerFn({ method: 'GET' }).handler(
  async (): Promise<UserRow[]> => {
    const caller = await requireCaller()
    requireUserAdmin(caller)

    const admin = getAdminClient()
    const { data, error } = await admin
      .from('memberships')
      .select(
        'id, user_id, role, scope_area_id, scope_store_id, staff_id, staff:staff_id (full_name, email, status)',
      )
      .eq('tenant_id', caller.tenantId)

    assert(!error, 'ユーザー一覧の取得に失敗しました。')

    const storeIds = caller.role === 'owner' ? null : await visibleStoreIds(caller)

    return (data ?? [])
      .filter((m) => {
        if (caller.role === 'owner') return true
        if (m.scope_area_id && m.scope_area_id === caller.scopeAreaId) return true
        return !!m.scope_store_id && !!storeIds && storeIds.includes(m.scope_store_id)
      })
      .map((m) => {
        const staff = m.staff as { full_name: string; email: string | null; status: string } | null
        return {
          membershipId: m.id,
          userId: m.user_id,
          staffId: m.staff_id,
          fullName: staff?.full_name ?? '(氏名未登録)',
          email: staff?.email ?? '',
          role: m.role as Role,
          scopeAreaId: m.scope_area_id,
          scopeStoreId: m.scope_store_id,
          status: (staff?.status as 'active' | 'inactive') ?? 'active',
        }
      })
      .sort((a, b) => a.fullName.localeCompare(b.fullName, 'ja'))
  },
)

/* ------------------------------------------------------------------ */
/* 2. ユーザー作成（失敗時は auth ユーザーをロールバック）                */
/* ------------------------------------------------------------------ */

export interface CreateUserInput {
  full_name: string
  email: string
  password: string
  role: Role
  scope_area_id?: string | null
  scope_store_id?: string | null
}

function validateCreateInput(d: CreateUserInput): CreateUserInput {
  const fullName = d.full_name?.trim()
  const email = d.email?.trim().toLowerCase()
  assert(fullName, '氏名を入力してください。')
  assert(email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 'メールアドレスの形式が不正です。')
  assert(d.password && d.password.length >= 8, '初期パスワードは8文字以上にしてください。')
  return {
    full_name: fullName,
    email,
    password: d.password,
    role: d.role,
    scope_area_id: d.scope_area_id ?? null,
    scope_store_id: d.scope_store_id ?? null,
  }
}

export const adminCreateUser = createServerFn({ method: 'POST' })
  .inputValidator(validateCreateInput)
  .handler(async ({ data }): Promise<{ membershipId: string; userId: string }> => {
    const caller = await requireCaller()
    requireUserAdmin(caller)
    await assertScopeAllowed(caller, {
      role: data.role,
      scopeAreaId: data.scope_area_id ?? null,
      scopeStoreId: data.scope_store_id ?? null,
    })

    const admin = getAdminClient()

    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: data.email,
      password: data.password,
      email_confirm: true,
    })
    if (createErr || !created.user) {
      throw new Error(`アカウントを作成できませんでした: ${createErr?.message ?? '不明なエラー'}`)
    }
    const newUserId = created.user.id

    // ここから先で失敗したら auth ユーザーを消して元に戻す
    const rollback = async () => {
      await admin.auth.admin.deleteUser(newUserId)
    }

    try {
      const { data: staff, error: staffErr } = await admin
        .from('staff')
        .insert({
          tenant_id: caller.tenantId,
          full_name: data.full_name,
          email: data.email,
          user_id: newUserId,
        })
        .select('id')
        .single()
      if (staffErr || !staff) throw new Error(`スタッフの作成に失敗しました: ${staffErr?.message}`)

      const { data: membership, error: memErr } = await admin
        .from('memberships')
        .insert({
          tenant_id: caller.tenantId,
          user_id: newUserId,
          role: data.role,
          scope_area_id: data.scope_area_id ?? null,
          scope_store_id: data.scope_store_id ?? null,
          staff_id: staff.id,
        })
        .select('id')
        .single()
      if (memErr || !membership) {
        throw new Error(`membership の作成に失敗しました: ${memErr?.message}`)
      }

      // staff かつ店舗指定があれば所属も作る（雇用形態・時給はマスタ側で後編集）
      if (data.role === 'staff' && data.scope_store_id) {
        const { error: saErr } = await admin.from('staff_assignments').insert({
          tenant_id: caller.tenantId,
          staff_id: staff.id,
          store_id: data.scope_store_id,
        })
        if (saErr) throw new Error(`店舗所属の作成に失敗しました: ${saErr.message}`)
      }

      return { membershipId: membership.id, userId: newUserId }
    } catch (e) {
      await rollback()
      throw e
    }
  })

/* ------------------------------------------------------------------ */
/* 3. 役割・スコープの変更                                              */
/* ------------------------------------------------------------------ */

export interface UpdateMembershipInput {
  membership_id: string
  role?: Role
  scope_area_id?: string | null
  scope_store_id?: string | null
}

export const adminUpdateMembership = createServerFn({ method: 'POST' })
  .inputValidator((d: UpdateMembershipInput) => {
    assert(d.membership_id, '対象が指定されていません。')
    return d
  })
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const caller = await requireCaller()
    requireUserAdmin(caller)
    const target = await assertCanManageMembership(caller, data.membership_id)

    const nextRole = data.role ?? (target.role as Role)
    const nextArea = data.scope_area_id !== undefined ? data.scope_area_id : target.scope_area_id
    const nextStore = data.scope_store_id !== undefined ? data.scope_store_id : target.scope_store_id

    // 変更後の姿でも権限内に収まるか検証する
    await assertScopeAllowed(caller, {
      role: nextRole,
      scopeAreaId: nextArea,
      scopeStoreId: nextStore,
    })

    const admin = getAdminClient()
    const { error } = await admin
      .from('memberships')
      .update({ role: nextRole, scope_area_id: nextArea, scope_store_id: nextStore })
      .eq('id', data.membership_id)

    if (error) throw new Error(`更新に失敗しました: ${error.message}`)
    return { ok: true }
  })

/* ------------------------------------------------------------------ */
/* 4. パスワードリセット                                                */
/* ------------------------------------------------------------------ */

export interface ResetPasswordInput {
  membership_id: string
  new_password: string
}

export const adminResetPassword = createServerFn({ method: 'POST' })
  .inputValidator((d: ResetPasswordInput) => {
    assert(d.membership_id, '対象が指定されていません。')
    assert(d.new_password && d.new_password.length >= 8, 'パスワードは8文字以上にしてください。')
    return d
  })
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const caller = await requireCaller()
    requireUserAdmin(caller)
    const target = await assertCanManageMembership(caller, data.membership_id)

    const admin = getAdminClient()
    const { error } = await admin.auth.admin.updateUserById(target.user_id, {
      password: data.new_password,
    })
    if (error) throw new Error(`パスワードを更新できませんでした: ${error.message}`)
    return { ok: true }
  })

/* ------------------------------------------------------------------ */
/* 5. 無効化（アカウント削除はしない）                                   */
/* ------------------------------------------------------------------ */

export const adminDeactivateUser = createServerFn({ method: 'POST' })
  .inputValidator((d: { membership_id: string }) => {
    assert(d.membership_id, '対象が指定されていません。')
    return d
  })
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const caller = await requireCaller()
    requireUserAdmin(caller)
    const target = await assertCanManageMembership(caller, data.membership_id)
    assert(target.staff_id, 'このユーザーにはスタッフ情報が紐付いていません。')

    const admin = getAdminClient()
    const { error } = await admin
      .from('staff')
      .update({ status: 'inactive' })
      .eq('id', target.staff_id)

    if (error) throw new Error(`無効化に失敗しました: ${error.message}`)
    return { ok: true }
  })
