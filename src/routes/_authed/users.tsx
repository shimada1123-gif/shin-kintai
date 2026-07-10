import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useDebounced } from '@/lib/hooks'
import { ROLE_LABEL, useMe, type Role } from '@/lib/me-context'
import { assignableRoles } from '@/lib/server/permissions'
import {
  adminCreateUser,
  adminDeactivateUser,
  adminListUsers,
  adminResetPassword,
  adminUpdateMembership,
  type UserRow,
} from '@/lib/server/users'

export const Route = createFileRoute('/_authed/users')({
  component: UsersPage,
})

/** 覚えやすさより強度。紛らわしい文字（O/0, l/1）は除く。 */
function generatePassword(length = 14): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789@#%+=?'
  const bytes = new Uint32Array(length)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : '不明なエラーが発生しました。'
}

function UsersPage() {
  const { me } = useMe()
  const qc = useQueryClient()
  const [showForm, setShowForm] = useState(false)
  const [issued, setIssued] = useState<{ email: string; password: string } | null>(null)
  const [search, setSearch] = useState('')
  const [limit, setLimit] = useState(20)
  const debounced = useDebounced(search, 300)

  const usersQuery = useQuery({
    queryKey: ['admin_users', debounced, limit],
    queryFn: () => adminListUsers({ data: { search: debounced, limit } }),
  })

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['admin_users'] })

  if (!me) return null

  const allowedRoles = assignableRoles(me.role)
  const canManage = allowedRoles.length > 0

  return (
    <section>
      <div className="eyebrow">ACCOUNTS</div>
      <div className="page-h">
        <h1>ユーザー管理</h1>
        <span className="desc">アカウント発行と、役割・スコープの割り当て</span>
      </div>

      {!canManage && <p className="note">ユーザー管理の権限がありません。</p>}

      {canManage && (
        <>
          <div className="toolbar">
            <button className="btn pri" onClick={() => setShowForm((v) => !v)}>
              {showForm ? '閉じる' : '＋ ユーザーを追加'}
            </button>
          </div>

          {issued && (
            <div className="issued card">
              <div className="eyebrow">INITIAL PASSWORD</div>
              <p className="note">
                初期パスワードを本人に伝えてください。この画面を離れると再表示できません。
              </p>
              <dl className="issued-kv">
                <dt>メール</dt>
                <dd className="mono">{issued.email}</dd>
                <dt>初期パスワード</dt>
                <dd className="mono strong">{issued.password}</dd>
              </dl>
              <button className="btn sm" onClick={() => setIssued(null)}>
                控えを閉じる
              </button>
            </div>
          )}

          {showForm && (
            <CreateUserForm
              allowedRoles={allowedRoles}
              onCreated={(email, password) => {
                setIssued({ email, password })
                setShowForm(false)
                invalidate()
              }}
            />
          )}
        </>
      )}

      <div className="sec-h">
        <h3>登録済みユーザー</h3>
        <span className="rule" />
        <span className="cnt mono">
          {usersQuery.data ? `${usersQuery.data.rows.length} / ${usersQuery.data.total}` : ''}
        </span>
      </div>

      <div className="search-row">
        <input
          className="search-input"
          type="search"
          value={search}
          placeholder="🔍 氏名・メールで検索"
          onChange={(e) => {
            setSearch(e.target.value)
            setLimit(20)
          }}
        />
        {usersQuery.data && usersQuery.data.total > usersQuery.data.rows.length && (
          <span className="note">
            他 {usersQuery.data.total - usersQuery.data.rows.length} 件。検索で絞り込めます。
          </span>
        )}
      </div>

      {usersQuery.isPending && <p className="note">読み込み中…</p>}
      {usersQuery.error && (
        <p className="login-error" role="alert">
          {errText(usersQuery.error)}
        </p>
      )}

      {usersQuery.data && (
        <div className="card table-wrap">
          <table className="m-cards">
            <thead>
              <tr>
                <th>氏名</th>
                <th>メール</th>
                <th>役割</th>
                <th>スコープ</th>
                <th>状態</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {usersQuery.data.rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="note">
                    {debounced ? '該当するユーザーが見つかりません。' : '表示できるユーザーがいません。'}
                  </td>
                </tr>
              )}
              {usersQuery.data.rows.map((u) => (
                <UserRowView key={u.membershipId} row={u} canManage={canManage} onChanged={invalidate} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {usersQuery.data && usersQuery.data.total > usersQuery.data.rows.length && (
        <button className="btn sm more-btn" onClick={() => setLimit((v) => v + 20)}>
          もっと見る（あと {usersQuery.data.total - usersQuery.data.rows.length} 件）
        </button>
      )}
    </section>
  )
}

/* ------------------------------- 行 ------------------------------- */

function UserRowView({
  row,
  canManage,
  onChanged,
}: {
  row: UserRow
  canManage: boolean
  onChanged: () => void
}) {
  const { me } = useMe()
  const [editing, setEditing] = useState(false)
  const [resetPw, setResetPw] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const reset = useMutation({
    mutationFn: (pw: string) =>
      adminResetPassword({ data: { membership_id: row.membershipId, new_password: pw } }),
    onSuccess: () => setMessage('パスワードを更新しました。'),
    onError: (e) => setMessage(errText(e)),
  })

  const deactivate = useMutation({
    mutationFn: () => adminDeactivateUser({ data: { membership_id: row.membershipId } }),
    onSuccess: () => {
      setMessage('無効化しました。')
      onChanged()
    },
    onError: (e) => setMessage(errText(e)),
  })

  if (!me) return null

  const scope = scopeText(row, me.areas, me.stores)
  // 自分自身と、自分と同格以上は操作させない（サーバー側でも同じ判定を行う）
  const editable =
    canManage && row.role !== 'owner' && assignableRoles(me.role).includes(row.role)

  return (
    <>
      <tr>
        <td className="cell-main"><b>{row.fullName}</b></td>
        <td className="mono small cell-email" data-label="メール">{row.email}</td>
        <td>
          <span className={`role-badge role-${row.role}`}>{ROLE_LABEL[row.role]}</span>
        </td>
        <td className="cell-kv" data-label="スコープ">{scope}</td>
        <td>
          <span className={`st ${row.status === 'active' ? 'st-in' : 'st-out'}`}>
            <span className="dot" />
            {row.status === 'active' ? '有効' : '無効'}
          </span>
        </td>
        <td className="row-actions">
          {editable ? (
            <>
              <button className="btn sm" onClick={() => setEditing((v) => !v)}>
                役割/スコープ
              </button>
              <button
                className="btn sm"
                onClick={() => {
                  const pw = generatePassword()
                  setResetPw(pw)
                  reset.mutate(pw)
                }}
                disabled={reset.isPending}
              >
                パスワード再発行
              </button>
              <button
                className="btn sm"
                onClick={() => {
                  if (confirm(`${row.fullName} を無効化しますか？`)) deactivate.mutate()
                }}
                disabled={deactivate.isPending || row.status === 'inactive'}
              >
                無効化
              </button>
            </>
          ) : (
            <span className="note">—</span>
          )}
        </td>
      </tr>

      {message && (
        <tr>
          <td colSpan={6}>
            <p className="note">{message}</p>
          </td>
        </tr>
      )}

      {resetPw && reset.isSuccess && (
        <tr>
          <td colSpan={6}>
            <div className="issued-inline">
              新しいパスワード: <b className="mono">{resetPw}</b>
              <button className="btn sm" onClick={() => setResetPw(null)}>
                閉じる
              </button>
            </div>
          </td>
        </tr>
      )}

      {editing && (
        <tr>
          <td colSpan={6}>
            <EditMembership
              row={row}
              onDone={() => {
                setEditing(false)
                onChanged()
              }}
            />
          </td>
        </tr>
      )}
    </>
  )
}

function scopeText(
  row: Pick<UserRow, 'role' | 'scopeAreaId' | 'scopeStoreId'>,
  areas: { id: string; name: string }[],
  stores: { id: string; name: string }[],
): string {
  if (row.role === 'owner') return '全社'
  if (row.scopeAreaId) return areas.find((a) => a.id === row.scopeAreaId)?.name ?? 'エリア不明'
  if (row.scopeStoreId) return stores.find((s) => s.id === row.scopeStoreId)?.name ?? '店舗不明'
  return '未設定'
}

/* ---------------------------- 作成フォーム ---------------------------- */

function CreateUserForm({
  allowedRoles,
  onCreated,
}: {
  allowedRoles: Role[]
  onCreated: (email: string, password: string) => void
}) {
  const { me } = useMe()
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<Role>(allowedRoles[0])
  const [areaId, setAreaId] = useState('')
  const [storeId, setStoreId] = useState('')
  const [error, setError] = useState<string | null>(null)

  const create = useMutation({
    mutationFn: () =>
      adminCreateUser({
        data: {
          full_name: fullName,
          email,
          password,
          role,
          scope_area_id: role === 'area_manager' ? areaId || null : null,
          scope_store_id: role === 'store_manager' || role === 'staff' ? storeId || null : null,
        },
      }),
    onSuccess: () => onCreated(email, password),
    onError: (e) => setError(errText(e)),
  })

  if (!me) return null

  // area_manager / store_manager は自分のスコープ内しか選べない（サーバー側でも検証する）
  const selectableStores =
    me.role === 'owner'
      ? me.stores
      : me.role === 'area_manager'
        ? me.stores.filter((s) => s.area_id === me.scopeAreaId)
        : me.stores.filter((s) => s.id === me.scopeStoreId)

  const needsArea = role === 'area_manager'
  const needsStore = role === 'store_manager' || role === 'staff'

  return (
    <form
      className="card create-form"
      onSubmit={(e) => {
        e.preventDefault()
        setError(null)
        create.mutate()
      }}
    >
      <div className="eyebrow">NEW USER</div>

      {error && (
        <p className="login-error" role="alert">
          {error}
        </p>
      )}

      <div className="form-grid">
        <label className="field">
          <span>氏名</span>
          <input value={fullName} required onChange={(e) => setFullName(e.target.value)} />
        </label>

        <label className="field">
          <span>メールアドレス</span>
          <input type="email" value={email} required onChange={(e) => setEmail(e.target.value)} />
        </label>

        <label className="field">
          <span>初期パスワード</span>
          <div className="pw-row">
            <input
              value={password}
              required
              minLength={8}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button type="button" className="btn sm" onClick={() => setPassword(generatePassword())}>
              自動生成
            </button>
          </div>
        </label>

        <label className="field">
          <span>役割</span>
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {allowedRoles.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        </label>

        {needsArea && (
          <label className="field">
            <span>担当エリア</span>
            <select value={areaId} required onChange={(e) => setAreaId(e.target.value)}>
              <option value="">選択してください</option>
              {me.areas.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {needsStore && (
          <label className="field">
            <span>所属店舗</span>
            <select value={storeId} required onChange={(e) => setStoreId(e.target.value)}>
              <option value="">選択してください</option>
              {selectableStores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="form-actions">
        <button type="submit" className="btn pri" disabled={create.isPending}>
          {create.isPending ? '作成中…' : 'ユーザーを作成'}
        </button>
      </div>
    </form>
  )
}

/* ---------------------------- 役割変更 ---------------------------- */

function EditMembership({ row, onDone }: { row: UserRow; onDone: () => void }) {
  const { me } = useMe()
  const [role, setRole] = useState<Role>(row.role)
  const [areaId, setAreaId] = useState(row.scopeAreaId ?? '')
  const [storeId, setStoreId] = useState(row.scopeStoreId ?? '')
  const [error, setError] = useState<string | null>(null)

  const update = useMutation({
    mutationFn: () =>
      adminUpdateMembership({
        data: {
          membership_id: row.membershipId,
          role,
          scope_area_id: role === 'area_manager' ? areaId || null : null,
          scope_store_id: role === 'store_manager' || role === 'staff' ? storeId || null : null,
        },
      }),
    onSuccess: onDone,
    onError: (e) => setError(errText(e)),
  })

  if (!me) return null

  const allowedRoles = assignableRoles(me.role)
  const selectableStores =
    me.role === 'owner'
      ? me.stores
      : me.role === 'area_manager'
        ? me.stores.filter((s) => s.area_id === me.scopeAreaId)
        : me.stores.filter((s) => s.id === me.scopeStoreId)

  return (
    <div className="edit-row">
      {error && (
        <p className="login-error" role="alert">
          {error}
        </p>
      )}
      <div className="form-grid">
        <label className="field">
          <span>役割</span>
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {allowedRoles.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        </label>

        {role === 'area_manager' && (
          <label className="field">
            <span>担当エリア</span>
            <select value={areaId} onChange={(e) => setAreaId(e.target.value)}>
              <option value="">選択してください</option>
              {me.areas.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {(role === 'store_manager' || role === 'staff') && (
          <label className="field">
            <span>所属店舗</span>
            <select value={storeId} onChange={(e) => setStoreId(e.target.value)}>
              <option value="">選択してください</option>
              {selectableStores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="form-actions">
        <button className="btn pri sm" onClick={() => update.mutate()} disabled={update.isPending}>
          保存
        </button>
        <button className="btn sm" onClick={onDone}>
          キャンセル
        </button>
      </div>
    </div>
  )
}
