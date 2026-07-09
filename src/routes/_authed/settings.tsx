import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { errText } from '@/lib/errors'
import { useMe } from '@/lib/me-context'
import { usePermissions } from '@/lib/perm'
import { fetchStaffList, fetchStores } from '@/lib/queries/master'
import {
  fetchStaffSeeCorrections,
  setStaffSeeCorrections,
} from '@/lib/queries/tenant-settings'
import { clearDemo, demoPunch, issueDisplayUrl, type PunchKind } from '@/lib/server/punch'
import { getTestMode, setGpsPolicy, setTestMode } from '@/lib/server/settings'

export const Route = createFileRoute('/_authed/settings')({
  component: SettingsPage,
})

const POLICY_LABEL: Record<string, string> = {
  off: 'OFF（位置を見ない）',
  flag: 'フラグ（記録するが打刻は通す）',
  block: 'ブロック（圏外は打刻不可）',
}

function SettingsPage() {
  const { me } = useMe()
  const perms = usePermissions()
  const qc = useQueryClient()

  const testModeQ = useQuery({ queryKey: ['test_mode'], queryFn: () => getTestMode() })
  const storesQ = useQuery({ queryKey: ['master', 'stores'], queryFn: fetchStores })

  if (!me) return null

  const isOwner = me.role === 'owner'
  const canEditStore = isOwner || perms.has('staff_master_edit')
  const testMode = testModeQ.data?.test_mode ?? false

  return (
    <section>
      <div className="eyebrow">テナント設定</div>
      <div className="page-h">
        <h1>設定</h1>
        <span className="desc">{me.tenantName}</span>
      </div>

      <TestModeCard
        isOwner={isOwner}
        enabled={testMode}
        loading={testModeQ.isPending}
        onChanged={() => void qc.invalidateQueries({ queryKey: ['test_mode'] })}
      />

      <CorrVisibilityCard isOwner={isOwner} tenantId={me.tenantId} />

      <div className="sec-h">
        <h3>店舗のGPSポリシー</h3>
        <span className="rule" />
      </div>

      {storesQ.isPending && <p className="note">読み込み中…</p>}
      {storesQ.data && (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th>店舗</th>
                <th>GPSポリシー</th>
                <th>据置QR</th>
              </tr>
            </thead>
            <tbody>
              {storesQ.data.map((s) => (
                <StoreRow key={s.id} store={s} canEdit={canEditStore} canIssue={me.role !== 'staff'} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {testMode && <DemoCard />}
    </section>
  )
}

/* --------------------------- テストモード --------------------------- */

function TestModeCard({
  isOwner,
  enabled,
  loading,
  onChanged,
}: {
  isOwner: boolean
  enabled: boolean
  loading: boolean
  onChanged: () => void
}) {
  const [error, setError] = useState<string | null>(null)

  const toggle = useMutation({
    mutationFn: (next: boolean) => setTestMode({ data: { enabled: next } }),
    onSuccess: onChanged,
    onError: (e) => setError(errText(e, 'テストモードを切り替えられませんでした')),
  })

  return (
    <div className="card settings-card">
      <div className="card-title">テストモード</div>
      <p className="note">
        有効にすると、実勤怠と分離されたデモ打刻を作成できます。デモ行はデータベース側（RLS）でも
        隔離されており、テストモードを切ると誰にも見えなくなります。
      </p>

      {error && (
        <p className="login-error" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <p className="note">読み込み中…</p>
      ) : (
        <label className="tgl">
          <span
            className={`cbx2${enabled ? ' on' : ''}${isOwner ? '' : ' cbx2-disabled'}`}
            onClick={() => isOwner && !toggle.isPending && toggle.mutate(!enabled)}
          />
          テストモードを有効にする
        </label>
      )}

      {!isOwner && <p className="note">切り替えられるのはオーナーだけです。</p>}
    </div>
  )
}

/* --------------------- スタッフ補正履歴の可視性トグル --------------------- */

function CorrVisibilityCard({ isOwner, tenantId }: { isOwner: boolean; tenantId: string }) {
  const qc = useQueryClient()
  const [error, setError] = useState<string | null>(null)

  const q = useQuery({
    queryKey: ['staff_see_corr', tenantId],
    queryFn: () => fetchStaffSeeCorrections(tenantId),
  })

  // 楽観更新はしない。保存後に再取得（invalidate）で反映する。
  const toggle = useMutation({
    mutationFn: (next: boolean) => setStaffSeeCorrections(tenantId, next),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['staff_see_corr', tenantId] }),
    onError: (e) => setError(errText(e, '設定を更新できませんでした')),
  })

  const enabled = q.data ?? true // 既定 ON

  return (
    <div className="card settings-card">
      <div className="card-title">スタッフの補正履歴</div>
      <p className="note">
        オフにすると、スタッフは自分の勤怠がいつ・誰に修正されたかを閲覧できなくなります
        （労務の透明性のため既定はオンを推奨）。この制限はデータベース側（RLS）でも
        強制され、画面を迂回しても閲覧できません。
      </p>

      {error && (
        <p className="login-error" role="alert">
          {error}
        </p>
      )}

      {q.isPending ? (
        <p className="note">読み込み中…</p>
      ) : (
        <label className="tgl">
          <span
            className={`cbx2${enabled ? ' on' : ''}${isOwner ? '' : ' cbx2-disabled'}`}
            onClick={() => {
              if (!isOwner || toggle.isPending) return
              setError(null)
              toggle.mutate(!enabled)
            }}
          />
          スタッフに自分の勤怠補正履歴を見せる
        </label>
      )}

      {!isOwner && <p className="note">切り替えられるのはオーナーだけです。</p>}
    </div>
  )
}

/* ---------------------------- 店舗の行 ---------------------------- */

function StoreRow({
  store,
  canEdit,
  canIssue,
}: {
  store: { id: string; name: string; gps_policy: string }
  canEdit: boolean
  canIssue: boolean
}) {
  const qc = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const save = useMutation({
    mutationFn: (policy: 'off' | 'flag' | 'block') =>
      setGpsPolicy({ data: { store_id: store.id, gps_policy: policy } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['master', 'stores'] }),
    onError: (e) => setError(errText(e, 'GPSポリシーを更新できませんでした')),
  })

  const issue = useMutation({
    mutationFn: () => issueDisplayUrl({ data: { store_id: store.id } }),
    onSuccess: (r) => setUrl(`${window.location.origin}${r.path}`),
    onError: (e) => setError(errText(e, 'URLを発行できませんでした')),
  })

  return (
    <>
      <tr>
        <td>
          <b>{store.name}</b>
        </td>
        <td>
          {canEdit ? (
            <select
              value={store.gps_policy}
              disabled={save.isPending}
              onChange={(e) => {
                setError(null)
                save.mutate(e.target.value as 'off' | 'flag' | 'block')
              }}
            >
              {(['off', 'flag', 'block'] as const).map((p) => (
                <option key={p} value={p}>
                  {POLICY_LABEL[p]}
                </option>
              ))}
            </select>
          ) : (
            <span className="note">{POLICY_LABEL[store.gps_policy]}</span>
          )}
        </td>
        <td>
          {canIssue && (
            <button className="btn sm" onClick={() => issue.mutate()} disabled={issue.isPending}>
              {issue.isPending ? '発行中…' : 'URLを発行'}
            </button>
          )}
        </td>
      </tr>
      {(url || error) && (
        <tr>
          <td colSpan={3}>
            {error && (
              <p className="login-error" role="alert">
                {error}
              </p>
            )}
            {url && (
              <div className="issued-inline">
                <code className="mono display-url">{url}</code>
                <button
                  className="btn sm"
                  onClick={() => {
                    void navigator.clipboard.writeText(url)
                    setCopied(true)
                  }}
                >
                  {copied ? 'コピーしました' : 'コピー'}
                </button>
                <button className="btn sm" onClick={() => setUrl(null)}>
                  閉じる
                </button>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  )
}

/* ------------------------- デモ打刻（テストモード時） ------------------------- */

function DemoCard() {
  const qc = useQueryClient()
  const [storeId, setStoreId] = useState('')
  const [staffId, setStaffId] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const storesQ = useQuery({ queryKey: ['master', 'stores'], queryFn: fetchStores })
  const staffQ = useQuery({ queryKey: ['master', 'staff'], queryFn: fetchStaffList })

  const doDemo = useMutation({
    mutationFn: (kind: PunchKind) => demoPunch({ data: { store_id: storeId, staff_id: staffId, kind } }),
    onSuccess: (r) => {
      setMessage(r.message)
      setError(null)
    },
    onError: (e) => setError(errText(e, 'デモ打刻に失敗しました')),
  })

  const doClear = useMutation({
    mutationFn: () => clearDemo({ data: { store_id: storeId || undefined } }),
    onSuccess: (r) => {
      setMessage(`デモ打刻を ${r.deleted} 件削除しました。`)
      setError(null)
      void qc.invalidateQueries({ queryKey: ['my_attendance_today'] })
    },
    onError: (e) => setError(errText(e, 'デモ打刻の削除に失敗しました')),
  })

  const ready = !!storeId && !!staffId

  return (
    <div className="card settings-card demo-card">
      <div className="eyebrow">TEST MODE</div>
      <div className="card-title">デモ打刻</div>
      <p className="note">
        ここで作った打刻は <code className="mono">is_demo=true</code> として記録され、実勤怠には混ざりません。
        GPS検証はスキップされます。
      </p>

      {error && (
        <p className="login-error" role="alert">
          {error}
        </p>
      )}
      {message && <p className="punch-ok">{message}</p>}

      <div className="form-grid">
        <label className="field">
          <span>店舗</span>
          <select value={storeId} onChange={(e) => setStoreId(e.target.value)}>
            <option value="">選択してください</option>
            {(storesQ.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>スタッフ</span>
          <select value={staffId} onChange={(e) => setStaffId(e.target.value)}>
            <option value="">選択してください</option>
            {(staffQ.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.full_name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="form-actions">
        {(['clock_in', 'break_start', 'break_end', 'clock_out'] as const).map((k) => (
          <button
            key={k}
            className="btn sm"
            disabled={!ready || doDemo.isPending}
            onClick={() => doDemo.mutate(k)}
          >
            {k === 'clock_in'
              ? 'デモ出勤'
              : k === 'break_start'
                ? 'デモ休憩開始'
                : k === 'break_end'
                  ? 'デモ休憩終了'
                  : 'デモ退勤'}
          </button>
        ))}
        <button
          className="btn sm danger"
          disabled={doClear.isPending}
          onClick={() => {
            if (confirm('デモ打刻を一括削除します。よろしいですか？')) doClear.mutate()
          }}
        >
          デモ打刻を全削除{storeId ? '（この店舗）' : '（全店）'}
        </button>
      </div>
    </div>
  )
}
