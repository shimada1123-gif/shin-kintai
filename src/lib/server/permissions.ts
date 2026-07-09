import type { Role } from '@/lib/me-context'

/** 上位ほど大きい。権限昇格の判定に使う。 */
export const ROLE_RANK: Record<Role, number> = {
  owner: 3,
  area_manager: 2,
  store_manager: 1,
  staff: 0,
}

export interface Caller {
  userId: string
  tenantId: string
  role: Role
  scopeAreaId: string | null
  scopeStoreId: string | null
}

export const ALL_ROLES: Role[] = ['owner', 'area_manager', 'store_manager', 'staff']

/**
 * 呼び出し元が「作成・変更」できる role の一覧。
 * owner のみ owner を作れる。それ以外は必ず自分より下位に限る（権限昇格防止）。
 */
export function assignableRoles(caller: Role): Role[] {
  switch (caller) {
    case 'owner':
      return ALL_ROLES
    case 'area_manager':
      return ['store_manager', 'staff']
    case 'store_manager':
      return ['staff']
    case 'staff':
      return []
  }
}

export function canAssignRole(caller: Role, target: Role): boolean {
  return assignableRoles(caller).includes(target)
}

/** 呼び出し元が対象の membership（既存ユーザー）に手を出せるか */
export function canManageRole(caller: Role, targetCurrentRole: Role): boolean {
  if (caller === 'owner') return true
  return ROLE_RANK[targetCurrentRole] < ROLE_RANK[caller]
}

export class PermissionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PermissionError'
  }
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new PermissionError(message)
}
