import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { errText } from '@/lib/errors'
import { useMe } from '@/lib/me-context'
import {
  EDITABLE_ROLES,
  fetchRolePermissions,
  setRolePermission,
  type EditableRole,
} from '@/lib/queries/permissions'

export const Route = createFileRoute('/_authed/permissions')({
  component: PermissionsPage,
})

const ROLE_HEAD: Record<EditableRole, string> = {
  area_manager: 'エリアマネージャー',
  store_manager: '店長',
  staff: 'スタッフ',
}

/**
 * enforcement:
 *  'rls' = DB(RLS)で強制。UIを迂回しても効く
 *  'ui'  = 現状は画面の出し分け中心（該当機能の実装フェーズで RLS/サーバー検証に接続）
 */
const PERM_DEFS: {
  key: string
  label: string
  desc: string
  enforcement: 'rls' | 'ui'
}[] = [
  {
    key: 'roster_view_today',
    label: '今日のシフト表を見る',
    desc: 'その日の出勤メンバーの一覧（金額なし）を閲覧できます。',
    enforcement: 'ui',
  },
  {
    key: 'correction_approve',
    label: '勤怠の補正・承認ができる',
    desc: '打刻の直接修正と、スタッフからの修正申請の承認/却下ができます。',
    enforcement: 'rls',
  },
  {
    key: 'shift_edit',
    label: 'シフトを編集できる',
    desc: 'シフト希望の一覧閲覧・代理入力、シフトの作成・変更ができます。',
    enforcement: 'rls',
  },
  {
    key: 'labor_cost_view',
    label: '人件費集計を見る',
    desc: '店舗・期間ごとの人件費の合計を閲覧できます（Phase 2 で使用）。',
    enforcement: 'ui',
  },
  {
    key: 'wage_individual_view',
    label: '個人の賃金を見る',
    desc: 'スタッフ個人の時給・固定給・交通費を閲覧できます。',
    enforcement: 'rls',
  },
  {
    key: 'payslip_view',
    label: '給与明細を見る',
    desc: '他人の給与明細を閲覧できます（Phase 2 で使用）。',
    enforcement: 'ui',
  },
  {
    key: 'staff_master_edit',
    label: 'スタッフ・店舗マスタを編集できる',
    desc: 'スタッフ登録・時給設定・店舗/雇用区分/ポジションの編集ができます。',
    enforcement: 'rls',
  },
  {
    key: 'demo_manage',
    label: 'テストモードのデモ打刻を管理できる',
    desc: 'テストモード中にデモ打刻の作成・一括削除ができます。',
    enforcement: 'rls',
  },
]

function PermissionsPage() {
  const { me } = useMe()
  const qc = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [savingCell, setSavingCell] = useState<string | null>(null)

  const q = useQuery({
    queryKey: ['rp_grid', me?.tenantId],
    enabled: !!me,
    queryFn: () => fetchRolePermissions(me!.tenantId),
  })

  const save = useMutation({
    mutationFn: ({ role, key, allowed }: { role: EditableRole; key: string; allowed: boolean }) =>
      setRolePermission(me!.tenantId, role, key, allowed),
    onSuccess: () => {
      // 楽観更新はしない。保存後に再取得（自分の権限判定キャッシュも更新）
      void qc.invalidateQueries({ queryKey: ['rp_grid'] })
      void qc.invalidateQueries({ queryKey: ['role_permissions'] })
    },
    onError: (e) => setError(errText(e, '権限を保存できませんでした')),
    onSettled: () => setSavingCell(null),
  })

  if (!me) return null

  if (me.role !== 'owner') {
    return (
      <section>
        <div className="eyebrow">テナント設定 · オーナー専用</div>
        <div className="page-h">
          <h1>権限設定</h1>
        </div>
        <p className="note">権限を設定できるのはオーナーだけです。</p>
      </section>
    )
  }

  const allowedOf = (role: EditableRole, key: string): boolean =>
    q.data?.some((r) => r.role === role && r.permission_key === key && r.allowed) ?? false

  const toggle = (role: EditableRole, key: string) => {
    const cell = `${role}|${key}`
    setError(null)
    setSavingCell(cell)
    save.mutate({ role, key, allowed: !allowedOf(role, key) })
  }

  return (
    <section>
      <div className="eyebrow">テナント設定 · オーナー専用</div>
      <div className="page-h">
        <h1>権限設定</h1>
        <span className="desc">役割ごとに、できることを選びます。変更は即保存されます。</span>
      </div>

      <p className="note">
        オーナーは常にすべての権限を持ちます（この画面の編集対象外）。
        <span className="enf-chip enf-rls">DB強制</span>の権限はデータベース（RLS）でも
        強制され、画面を迂回しても効きます。
        <span className="enf-chip enf-ui">画面制御</span>は現状アプリ側の出し分けで、
        該当機能の実装時にサーバー検証へ接続します。
      </p>

      {error && (
        <p className="login-error" role="alert">
          {error}
        </p>
      )}

      {q.isPending && <p className="note">読み込み中…</p>}
      {q.error && (
        <p className="login-error" role="alert">
          {errText(q.error, '権限の取得に失敗しました')}
        </p>
      )}

      {q.data && (
        <div className="card table-wrap">
          <table className="perm-table">
            <thead>
              <tr>
                <th>権限</th>
                {EDITABLE_ROLES.map((r) => (
                  <th key={r} className="perm-role-head">
                    {ROLE_HEAD[r]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PERM_DEFS.map((def) => (
                <tr key={def.key}>
                  <td className="perm-info">
                    <div className="perm-label">
                      <b>{def.label}</b>
                      <span className={`enf-chip ${def.enforcement === 'rls' ? 'enf-rls' : 'enf-ui'}`}>
                        {def.enforcement === 'rls' ? 'DB強制' : '画面制御'}
                      </span>
                    </div>
                    <div className="note">{def.desc}</div>
                  </td>
                  {EDITABLE_ROLES.map((role) => {
                    const cell = `${role}|${def.key}`
                    const on = allowedOf(role, def.key)
                    const saving = savingCell === cell
                    return (
                      <td key={role} className="perm-cell">
                        <button
                          type="button"
                          className={`perm-toggle${on ? ' on' : ''}${saving ? ' saving' : ''}`}
                          aria-label={`${ROLE_HEAD[role]} の「${def.label}」を${on ? '無効' : '有効'}にする`}
                          aria-pressed={on}
                          disabled={save.isPending}
                          onClick={() => toggle(role, def.key)}
                        >
                          <span className={`cbx2${on ? ' on' : ''}`} />
                        </button>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
