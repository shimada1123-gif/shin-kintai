import { useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { NumberInput } from '@/components/NumberInput'
import { StaffEditModal } from '@/components/StaffEditModal'
import { errText } from '@/lib/errors'
import { geocodeAddress } from '@/lib/geocode'
import { useDebounced } from '@/lib/hooks'
import { useMe } from '@/lib/me-context'
import { usePermissions } from '@/lib/perm'
import {
  createEmploymentKind,
  createPosition,
  createStaff,
  deleteEmploymentKind,
  deletePosition,
  fetchEmploymentKinds,
  fetchPositions,
  fetchStaffPage,
  fetchStores,
  fetchStoresPage,
  saveStore,
  type Assignment,
  type StaffWithDetails,
  type Store,
} from '@/lib/queries/master'

export const Route = createFileRoute('/_authed/staff')({
  component: MasterPage,
})

const yen = (n: number) => `¥${n.toLocaleString('ja-JP')}`

function wageLabel(a: Assignment): string {
  if (a.wage_type === 'invoice') return '請求（委託）'
  if (a.wage_type === 'fixed') return a.monthly_fixed ? `${yen(a.monthly_fixed)} / 月` : '固定給 未設定'
  return a.hourly_wage ? `${yen(a.hourly_wage)} / 時` : '時給 未設定'
}

function commuteLabel(a: Assignment): string {
  if (a.commute_type === 'none' || !a.commute_amount) return '—'
  return a.commute_type === 'daily'
    ? `${yen(a.commute_amount)} / 日`
    : `${yen(a.commute_amount)} / 月`
}

function MasterPage() {
  const { me } = useMe()
  const perms = usePermissions()
  const [editing, setEditing] = useState<StaffWithDetails | null>(null)

  // 一覧は検索 + 最新◯件（サーバー側 ilike / limit）。
  const [staffSearch, setStaffSearch] = useState('')
  const [staffLimit, setStaffLimit] = useState(20)
  const staffSearchD = useDebounced(staffSearch, 300)
  const staffQ = useQuery({
    queryKey: ['master', 'staff', 'page', staffSearchD, staffLimit],
    queryFn: () => fetchStaffPage({ search: staffSearchD, limit: staffLimit }),
  })

  const [storeSearch, setStoreSearch] = useState('')
  const [storeLimit, setStoreLimit] = useState(20)
  const storeSearchD = useDebounced(storeSearch, 300)
  const storesPageQ = useQuery({
    queryKey: ['master', 'stores', 'page', storeSearchD, storeLimit],
    queryFn: () => fetchStoresPage({ search: storeSearchD, limit: storeLimit }),
  })

  // フォーム・モーダル・店舗名解決には全件（従来どおり）
  const storesQ = useQuery({ queryKey: ['master', 'stores'], queryFn: fetchStores })
  const kindsQ = useQuery({ queryKey: ['master', 'kinds'], queryFn: fetchEmploymentKinds })
  const posQ = useQuery({ queryKey: ['master', 'positions'], queryFn: fetchPositions })

  if (!me) return null

  const canEdit = perms.has('staff_master_edit')
  const isOwner = me.role === 'owner'

  return (
    <section>
      <div className="eyebrow">組織 · マスタ</div>
      <div className="page-h">
        <h1>スタッフ・店舗</h1>
        <span className="desc">
          氏名・区分タグ・時給/固定給・交通費・所属店舗・新人フラグを登録します。
        </span>
      </div>

      {!perms.loading && !canEdit && (
        <p className="perm-banner" role="status">
          編集権限がありません。閲覧のみ可能です（スタッフ・店舗マスタの編集には
          staff_master_edit 権限が必要です）。
        </p>
      )}

      <p className="note kinship">
        ここは<b>働く人の台帳</b>です。打刻用のログインアカウントが必要な人には、
        <Link to="/users">ユーザー管理</Link>で役割 <b>staff</b> のアカウントを別途発行してください。
      </p>

      <div className="cols">
        {/* ---------------- スタッフ ---------------- */}
        <div className="card col-main">
          <div className="card-title">スタッフ登録</div>

          <div className="search-row">
            <input
              className="search-input"
              type="search"
              value={staffSearch}
              placeholder="🔍 氏名・区分タグで検索"
              onChange={(e) => {
                setStaffSearch(e.target.value)
                setStaffLimit(20)
              }}
            />
            {staffQ.data && (
              <span className="note mono small">
                {staffQ.data.rows.length} / {staffQ.data.total}
              </span>
            )}
          </div>

          {staffQ.isPending && <p className="note">読み込み中…</p>}
          {staffQ.error && (
            <p className="login-error" role="alert">
              {errText(staffQ.error, 'スタッフの取得に失敗しました')}
            </p>
          )}

          {staffQ.data && (
            <div className="table-wrap">
              <table className="m-cards">
                <thead>
                  <tr>
                    <th>氏名</th>
                    <th>区分タグ</th>
                    <th>所属店舗</th>
                    <th>給与 / 交通費</th>
                    <th>フラグ</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {staffQ.data.rows.length === 0 && (
                    <tr>
                      <td colSpan={6} className="note">
                        {staffSearchD ? '該当するスタッフが見つかりません。' : '登録されたスタッフがいません。'}
                      </td>
                    </tr>
                  )}
                  {staffQ.data.rows.map((s) => {
                    const storeNames = s.assignments
                      .map((a) => storesQ.data?.find((st) => st.id === a.store_id)?.name)
                      .filter(Boolean)
                    const primary = s.assignments[0]
                    return (
                      <tr key={s.id}>
                        <td className="cell-main">
                          <b>{s.full_name}</b>
                          {s.status === 'inactive' && <span className="muted-tag">無効</span>}
                        </td>
                        <td className="cell-chip">
                          {s.tags.length === 0 ? (
                            <span className="note">—</span>
                          ) : (
                            s.tags.map((t) => (
                              <span key={t} className="badge b-tag">
                                {t}
                              </span>
                            ))
                          )}
                        </td>
                        <td className="note cell-kv" data-label="所属店舗">
                          {storeNames.length > 0 ? storeNames.join(' / ') : '—'}
                        </td>
                        <td className="cell-kv wage-cell" data-label="給与 / 交通費">
                          {primary ? (
                            <>
                              <div className="mono">{wageLabel(primary)}</div>
                              <div className="note">交通費 {commuteLabel(primary)}</div>
                            </>
                          ) : (
                            <span className="note">
                              {s.assignments.length === 0 ? '—' : '閲覧権限なし'}
                            </span>
                          )}
                        </td>
                        <td className="cell-chip">
                          {primary?.is_newbie && <span className="newbie">新人</span>}
                          {primary?.is_trainer && <span className="badge b-trainer">指導可</span>}
                        </td>
                        <td className="row-actions">
                          <button
                            className="btn sm"
                            disabled={!canEdit}
                            title={canEdit ? undefined : '編集権限がありません'}
                            onClick={() => setEditing(s)}
                          >
                            編集
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          {staffQ.data && staffQ.data.total > staffQ.data.rows.length && (
            <button className="btn sm more-btn" onClick={() => setStaffLimit((v) => v + 20)}>
              もっと見る（あと {staffQ.data.total - staffQ.data.rows.length} 件）
            </button>
          )}

          {canEdit && storesQ.data && kindsQ.data && (
            <AddStaffForm tenantId={me.tenantId} stores={storesQ.data} kinds={kindsQ.data} />
          )}

          <p className="note foot-note">
            区分タグは自由（社員・業務委託・パート・アルバイト・新人…）。各行の<b>「編集」</b>で
            時給/固定給・交通費・タグの付け外し・新人フラグを登録します。
            <b>業務委託</b>は打刻・シフト指示・割増計算の対象外として扱います（偽装請負回避）。
          </p>
        </div>

        {/* ---------------- 店舗・区分・ポジション ---------------- */}
        <div className="col-side">
          <StoresCard
            tenantId={me.tenantId}
            areas={me.areas}
            stores={storesPageQ.data?.rows ?? []}
            total={storesPageQ.data?.total ?? 0}
            search={storeSearch}
            onSearch={(v) => {
              setStoreSearch(v)
              setStoreLimit(20)
            }}
            onMore={() => setStoreLimit((v) => v + 20)}
            loading={storesPageQ.isPending}
            error={storesPageQ.error}
            canEdit={isOwner}
          />

          <EmploymentKindsCard
            tenantId={me.tenantId}
            kinds={kindsQ.data ?? []}
            loading={kindsQ.isPending}
            canEdit={canEdit}
          />

          <PositionsCard
            tenantId={me.tenantId}
            positions={posQ.data ?? []}
            stores={storesQ.data ?? []}
            loading={posQ.isPending}
            canEdit={canEdit}
          />
        </div>
      </div>

      {editing && storesQ.data && kindsQ.data && posQ.data && (
        <StaffEditModal
          staff={editing}
          stores={storesQ.data}
          kinds={kindsQ.data}
          positions={posQ.data}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  )
}

/* ------------------------- スタッフ追加 ------------------------- */

function AddStaffForm({
  tenantId,
  stores,
  kinds,
}: {
  tenantId: string
  stores: Store[]
  kinds: { id: string; label: string }[]
}) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [fullName, setFullName] = useState('')
  const [storeId, setStoreId] = useState('')
  const [kindId, setKindId] = useState('')
  const [wageType, setWageType] = useState<'hourly' | 'fixed' | 'invoice'>('hourly')
  const [amount, setAmount] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const create = useMutation({
    mutationFn: () =>
      createStaff({
        tenantId,
        fullName,
        storeId,
        employmentKindId: kindId || null,
        wageType,
        amount,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['master', 'staff'] })
      setOpen(false)
      setFullName('')
      setAmount(null)
    },
    onError: (e) => setError(errText(e, 'スタッフの作成に失敗しました')),
  })

  if (!open) {
    return (
      <button className="btn pri sm add-staff" onClick={() => setOpen(true)}>
        ＋ スタッフを追加
      </button>
    )
  }

  return (
    <form
      className="add-form"
      onSubmit={(e) => {
        e.preventDefault()
        setError(null)
        create.mutate()
      }}
    >
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
          <span>所属店舗</span>
          <select value={storeId} required onChange={(e) => setStoreId(e.target.value)}>
            <option value="">選択してください</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>雇用区分</span>
          <select value={kindId} onChange={(e) => setKindId(e.target.value)}>
            <option value="">未設定</option>
            {kinds.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>給与</span>
          <div className="wtype">
            {(['hourly', 'fixed', 'invoice'] as const).map((w) => (
              <label key={w} className="rd">
                <input
                  type="radio"
                  name="new-wt"
                  checked={wageType === w}
                  onChange={() => setWageType(w)}
                />
                {w === 'hourly' ? '時給' : w === 'fixed' ? '固定給' : '請求'}
              </label>
            ))}
          </div>
        </label>
        {wageType !== 'invoice' && (
          <label className="field">
            <span>金額</span>
            <div className="amtrow">
              <NumberInput
                min={0}
                placeholder="未設定"
                aria-label="金額"
                value={amount}
                onChange={setAmount}
              />
              <span className="unit">{wageType === 'hourly' ? '円 / 時' : '円 / 月'}</span>
            </div>
          </label>
        )}
      </div>
      <div className="form-actions">
        <button type="submit" className="btn pri sm" disabled={create.isPending}>
          {create.isPending ? '作成中…' : '作成'}
        </button>
        <button type="button" className="btn sm" onClick={() => setOpen(false)}>
          キャンセル
        </button>
      </div>
    </form>
  )
}

/* --------------------------- 店舗マスタ --------------------------- */

function StoresCard({
  tenantId,
  areas,
  stores,
  total,
  search,
  onSearch,
  onMore,
  loading,
  error,
  canEdit,
}: {
  tenantId: string
  areas: { id: string; name: string }[]
  stores: Store[]
  total: number
  search: string
  onSearch: (v: string) => void
  onMore: () => void
  loading: boolean
  error: unknown
  canEdit: boolean
}) {
  const qc = useQueryClient()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['master', 'stores'] })

  return (
    <div className="card">
      <div className="card-title">店舗登録（GPS）</div>
      <p className="note">
        打刻ジオフェンス用に座標と半径を設定します。屋内やモール内は半径を広めに。
      </p>

      <div className="search-row">
        <input
          className="search-input"
          type="search"
          value={search}
          placeholder="🔍 店舗名で検索"
          onChange={(e) => onSearch(e.target.value)}
        />
        <span className="note mono small">
          {stores.length} / {total}
        </span>
      </div>

      {loading && <p className="note">読み込み中…</p>}
      {!!error && (
        <p className="login-error" role="alert">
          {errText(error, '店舗の取得に失敗しました')}
        </p>
      )}

      <div className="table-wrap">
        <table className="m-cards">
          <tbody>
            {stores.map((s) =>
              editingId === s.id ? (
                <tr key={s.id}>
                  <td colSpan={3}>
                    <StoreForm
                      tenantId={tenantId}
                      areas={areas}
                      store={s}
                      onDone={() => {
                        setEditingId(null)
                        invalidate()
                      }}
                    />
                  </td>
                </tr>
              ) : (
                <tr key={s.id}>
                  <td className="cell-main">
                    <b>{s.name}</b>
                    <div className="note">
                      {areas.find((a) => a.id === s.area_id)?.name ?? 'エリア未設定'}
                    </div>
                  </td>
                  <td className="mono note cell-wide">
                    {s.lat !== null && s.lng !== null ? `${s.lat}, ${s.lng}` : '座標未設定'}
                    <div className="mono">
                      半径 {s.geofence_radius_m}m ·{' '}
                      <span className={s.gps_policy === 'block' ? 'gps-block' : 'gps-flag'}>
                        {s.gps_policy === 'block' ? 'ブロック' : 'フラグ'}
                      </span>
                    </div>
                  </td>
                  <td className="row-actions">
                    {canEdit && (
                      <button className="btn sm" onClick={() => setEditingId(s.id)}>
                        編集
                      </button>
                    )}
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>

      {stores.length === 0 && !loading && (
        <p className="note">{search ? '該当する店舗が見つかりません。' : '店舗が未登録です。'}</p>
      )}

      {total > stores.length && (
        <button className="btn sm more-btn" onClick={onMore}>
          もっと見る（あと {total - stores.length} 件）
        </button>
      )}

      {canEdit &&
        (adding ? (
          <StoreForm
            tenantId={tenantId}
            areas={areas}
            store={null}
            onDone={() => {
              setAdding(false)
              invalidate()
            }}
          />
        ) : (
          <button className="btn sm" onClick={() => setAdding(true)}>
            ＋ 店舗を追加
          </button>
        ))}

      {!canEdit && <p className="note">店舗の編集はオーナーのみ可能です。</p>}
    </div>
  )
}

function StoreForm({
  tenantId,
  areas,
  store,
  onDone,
}: {
  tenantId: string
  areas: { id: string; name: string }[]
  store: Store | null
  onDone: () => void
}) {
  const [name, setName] = useState(store?.name ?? '')
  const [areaId, setAreaId] = useState(store?.area_id ?? '')
  const [lat, setLat] = useState<number | null>(store?.lat ?? null)
  const [lng, setLng] = useState<number | null>(store?.lng ?? null)
  const [radius, setRadius] = useState<number | null>(store?.geofence_radius_m ?? 80)
  const [policy, setPolicy] = useState<'flag' | 'block'>(
    (store?.gps_policy as 'flag' | 'block') ?? 'flag',
  )
  const [error, setError] = useState<string | null>(null)
  // 住所はDBに保存しない（座標取得の補助のみ。保存するなら別途マイグレーション）
  const [address, setAddress] = useState('')
  const [geoMsg, setGeoMsg] = useState<string | null>(null)
  const [geocoding, setGeocoding] = useState(false)

  const lookupAddress = async () => {
    setGeoMsg(null)
    setGeocoding(true)
    try {
      const r = await geocodeAddress(address)
      if (!r) {
        setGeoMsg(
          '住所から座標が見つかりませんでした。住所を確認するか、緯度経度を直接入力してください。',
        )
        return
      }
      setLat(r.lat)
      setLng(r.lng)
      setGeoMsg(`座標を取得しました（緯度 ${r.lat}, 経度 ${r.lng}）: ${r.label}`)
    } catch {
      setGeoMsg('座標の取得に失敗しました。通信環境を確認するか、緯度経度を直接入力してください。')
    } finally {
      setGeocoding(false)
    }
  }

  const save = useMutation({
    mutationFn: () =>
      saveStore({
        id: store?.id,
        tenant_id: tenantId,
        name,
        area_id: areaId || null,
        lat,
        lng,
        geofence_radius_m: radius ?? 80,
        gps_policy: policy,
      }),
    onSuccess: onDone,
    onError: (e) => setError(errText(e, '店舗の保存に失敗しました')),
  })

  return (
    <form
      className="add-form"
      onSubmit={(e) => {
        e.preventDefault()
        setError(null)
        save.mutate()
      }}
    >
      {error && (
        <p className="login-error" role="alert">
          {error}
        </p>
      )}
      <div className="form-grid tight">
        <label className="field">
          <span>店舗名</span>
          <input value={name} required onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>エリア</span>
          <select value={areaId} onChange={(e) => setAreaId(e.target.value)}>
            <option value="">未設定</option>
            {areas.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <div className="field addr-field">
          <span>住所（座標の自動取得用・保存はされません）</span>
          <div className="addr-row">
            <input
              value={address}
              placeholder="例）東京都渋谷区道玄坂2-1"
              onChange={(e) => setAddress(e.target.value)}
            />
            <button
              type="button"
              className="btn sm"
              disabled={!address.trim() || geocoding}
              onClick={() => void lookupAddress()}
            >
              {geocoding ? '取得中…' : '住所から座標を取得'}
            </button>
          </div>
          {geoMsg && <p className="note geo-msg">{geoMsg}</p>}
        </div>
        <label className="field">
          <span>緯度 (lat)</span>
          <NumberInput decimal value={lat} onChange={setLat} placeholder="35.657" aria-label="緯度" />
        </label>
        <label className="field">
          <span>経度 (lng)</span>
          <NumberInput decimal value={lng} onChange={setLng} placeholder="139.696" aria-label="経度" />
        </label>
        <label className="field">
          <span>ジオフェンス半径 (m)</span>
          <NumberInput min={10} value={radius} onChange={setRadius} aria-label="ジオフェンス半径" />
        </label>
        <label className="field">
          <span>GPSポリシー</span>
          <select value={policy} onChange={(e) => setPolicy(e.target.value as 'flag' | 'block')}>
            <option value="flag">フラグ（記録のみ）</option>
            <option value="block">ブロック（圏外は打刻不可）</option>
          </select>
        </label>
      </div>
      <p className="note">
        緯度・経度は店舗の位置（GPS打刻の中心）です。住所を入れて「住所から座標を取得」を
        押すと自動入力されます。ジオフェンス半径(m)の範囲内での打刻が「圏内」になります。
      </p>
      <div className="form-actions">
        <button type="submit" className="btn pri sm" disabled={save.isPending}>
          {save.isPending ? '保存中…' : '保存'}
        </button>
        <button type="button" className="btn sm" onClick={onDone}>
          キャンセル
        </button>
      </div>
    </form>
  )
}

/* ----------------------- 雇用区分 / ポジション ----------------------- */

function EmploymentKindsCard({
  tenantId,
  kinds,
  loading,
  canEdit,
}: {
  tenantId: string
  kinds: { id: string; label: string; requires_clock: boolean; applies_premium: boolean }[]
  loading: boolean
  canEdit: boolean
}) {
  const qc = useQueryClient()
  const [label, setLabel] = useState('')
  const [error, setError] = useState<string | null>(null)
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['master', 'kinds'] })

  const add = useMutation({
    mutationFn: (isContractor: boolean) =>
      createEmploymentKind(tenantId, label, {
        is_hourly: !isContractor,
        requires_clock: !isContractor,
        applies_premium: !isContractor,
      }),
    onSuccess: () => {
      setLabel('')
      invalidate()
    },
    onError: (e) => setError(errText(e, '区分の追加に失敗しました')),
  })

  const del = useMutation({
    mutationFn: deleteEmploymentKind,
    onSuccess: invalidate,
    onError: (e) => setError(errText(e, '区分の削除に失敗しました')),
  })

  return (
    <div className="card">
      <div className="card-title">雇用区分</div>
      {loading && <p className="note">読み込み中…</p>}
      {error && (
        <p className="login-error" role="alert">
          {error}
        </p>
      )}

      <div className="chip-list">
        {kinds.length === 0 && <span className="note">未登録です。</span>}
        {kinds.map((k) => (
          <span key={k.id} className="tagchip">
            {k.label}
            {!k.requires_clock && <span className="chip-note">打刻なし</span>}
            {canEdit && (
              <span className="x" role="button" onClick={() => del.mutate(k.id)}>
                ×
              </span>
            )}
          </span>
        ))}
      </div>

      {canEdit && (
        <div className="inline-add">
          <input
            value={label}
            placeholder="例）社員 / 業務委託"
            onChange={(e) => setLabel(e.target.value)}
          />
          <button className="btn sm" disabled={!label || add.isPending} onClick={() => add.mutate(false)}>
            ＋ 追加
          </button>
          <button
            className="btn sm"
            disabled={!label || add.isPending}
            title="打刻・割増の対象外として登録します"
            onClick={() => add.mutate(true)}
          >
            ＋ 委託として追加
          </button>
        </div>
      )}
    </div>
  )
}

function PositionsCard({
  tenantId,
  positions,
  stores,
  loading,
  canEdit,
}: {
  tenantId: string
  positions: { id: string; name: string; store_id: string | null }[]
  stores: Store[]
  loading: boolean
  canEdit: boolean
}) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [storeId, setStoreId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['master', 'positions'] })

  const add = useMutation({
    mutationFn: () => createPosition(tenantId, name, storeId || null),
    onSuccess: () => {
      setName('')
      invalidate()
    },
    onError: (e) => setError(errText(e, 'ポジションの追加に失敗しました')),
  })

  const del = useMutation({
    mutationFn: deletePosition,
    onSuccess: invalidate,
    onError: (e) => setError(errText(e, 'ポジションの削除に失敗しました')),
  })

  return (
    <div className="card">
      <div className="card-title">ポジション</div>
      {loading && <p className="note">読み込み中…</p>}
      {error && (
        <p className="login-error" role="alert">
          {error}
        </p>
      )}

      <div className="chip-list">
        {positions.length === 0 && <span className="note">未登録です。</span>}
        {positions.map((p) => (
          <span key={p.id} className="tagchip">
            {p.name}
            <span className="chip-note">
              {p.store_id ? (stores.find((s) => s.id === p.store_id)?.name ?? '店舗') : '全店共通'}
            </span>
            {canEdit && (
              <span className="x" role="button" onClick={() => del.mutate(p.id)}>
                ×
              </span>
            )}
          </span>
        ))}
      </div>

      {canEdit && (
        <div className="inline-add">
          <input
            value={name}
            placeholder="例）キッチン / フロア"
            onChange={(e) => setName(e.target.value)}
          />
          <select value={storeId} onChange={(e) => setStoreId(e.target.value)}>
            <option value="">全店共通</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button className="btn sm" disabled={!name || add.isPending} onClick={() => add.mutate()}>
            ＋ 追加
          </button>
        </div>
      )}
    </div>
  )
}
