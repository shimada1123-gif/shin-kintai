import { useEffect, useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { errText } from '@/lib/errors'
import { useAuth } from '@/lib/auth'
import { useMe } from '@/lib/me-context'
import { usePermissions } from '@/lib/perm'
import { annErrText, createAnnouncement } from '@/lib/queries/announcements'
import { sendAnnouncementMail } from '@/lib/server/announce-mail'
import {
  cancelOffer,
  confirmOfferRecipient,
  createDraftOffers,
  fetchOfferRecipients,
  fetchOffers,
  previewDraftOffers,
  sendDraftOffers,
  type OfferRecipientRow,
  type OfferRow,
} from '@/lib/queries/offers'
import { fetchEmploymentKinds, fetchPositions, fetchStaffList } from '@/lib/queries/master'
import {
  asgErrText,
  availErrText,
  createAssignment,
  DAY_TYPES,
  deleteAssignment,
  deleteAvailability,
  fetchAssignments,
  fetchHolidays,
  fetchMyAvailability,
  fetchMyShifts,
  fetchMyStores,
  fetchRequirements,
  fetchStoreAvailability,
  fetchStoreRoster,
  hhmmToMin,
  minToHHMM,
  publishWeek,
  reqErrText,
  updateAssignment,
  upsertAvailability,
  upsertRequirement,
  type AvailKind,
  type AvailRow,
  type DayType,
  type RequirementRow,
  type RosterEntry,
  type ShiftAsg,
} from '@/lib/queries/shifts'
import { ymd } from '@/lib/worktime'

export const Route = createFileRoute('/_authed/shifts')({
  component: ShiftsPage,
})

/* ------------------------------ 月ヘルパー ------------------------------ */

interface MonthMeta {
  label: string
  from: string
  to: string
  /** 日曜始まりのカレンダー先頭の空きマス数 */
  leadBlanks: number
  days: { date: string; dayNum: number; dow: number }[]
}

function monthMeta(base: Date): MonthMeta {
  const y = base.getFullYear()
  const m = base.getMonth()
  const first = new Date(y, m, 1)
  const last = new Date(y, m + 1, 0)
  const days = []
  for (let d = 1; d <= last.getDate(); d++) {
    const dt = new Date(y, m, d)
    days.push({ date: ymd(dt), dayNum: d, dow: dt.getDay() })
  }
  return {
    label: `${y}年${m + 1}月`,
    from: ymd(first),
    to: ymd(last),
    leadBlanks: first.getDay(),
    days,
  }
}

const KIND_MARK: Record<AvailKind, string> = { avail: '○', partial: '△', off: '×' }

/* ------------------------------ ページ本体 ------------------------------ */

function ShiftsPage() {
  const { me } = useMe()
  const perms = usePermissions()

  const canEdit = perms.has('shift_edit')
  const hasSelf = !!me?.staffId
  const [tab, setTab] = useState<'matrix' | 'build' | 'req' | 'mine' | 'myshift'>('mine')

  // 権限が確定したら初期タブを決める（管理者はマトリクスが主）
  useEffect(() => {
    if (canEdit) setTab('matrix')
  }, [canEdit])

  if (!me) return null

  if (!canEdit && !hasSelf) {
    return (
      <section>
        <div className="eyebrow">シフト</div>
        <div className="page-h">
          <h1>シフト希望</h1>
        </div>
        <p className="note">
          シフト希望を提出するにはスタッフ情報の紐付けが、希望一覧を見るには
          シフト編集権限（shift_edit）が必要です。管理者に連絡してください。
        </p>
      </section>
    )
  }

  return (
    <section>
      <div className="eyebrow">シフト</div>
      <div className="page-h">
        <h1>シフト</h1>
        <span className="desc">
          {canEdit
            ? '希望の収集 → 必要人数 → 週ビューで配置 → 確定・公開。'
            : '○△×で希望を出し、公開されたシフトはマイシフトで確認できます。'}
        </span>
      </div>

      {canEdit ? (
        <div className="tab-row">
          <button className={`tab${tab === 'matrix' ? ' on' : ''}`} onClick={() => setTab('matrix')}>
            希望一覧（全員）
          </button>
          <button className={`tab${tab === 'build' ? ' on' : ''}`} onClick={() => setTab('build')}>
            シフト作成
          </button>
          <button className={`tab${tab === 'req' ? ' on' : ''}`} onClick={() => setTab('req')}>
            必要人数
          </button>
          {hasSelf && (
            <>
              <button className={`tab${tab === 'mine' ? ' on' : ''}`} onClick={() => setTab('mine')}>
                自分の希望
              </button>
              <button
                className={`tab${tab === 'myshift' ? ' on' : ''}`}
                onClick={() => setTab('myshift')}
              >
                マイシフト
              </button>
            </>
          )}
        </div>
      ) : (
        hasSelf && (
          <div className="tab-row">
            <button className={`tab${tab === 'mine' ? ' on' : ''}`} onClick={() => setTab('mine')}>
              希望を出す
            </button>
            <button
              className={`tab${tab === 'myshift' ? ' on' : ''}`}
              onClick={() => setTab('myshift')}
            >
              マイシフト
            </button>
          </div>
        )
      )}

      {tab === 'myshift' && hasSelf ? (
        <MyShiftView />
      ) : tab === 'build' && canEdit ? (
        <BuildView />
      ) : tab === 'req' && canEdit ? (
        <RequirementsView />
      ) : tab === 'matrix' && canEdit ? (
        <MatrixView />
      ) : hasSelf ? (
        <MyAvailabilityView />
      ) : (
        <MatrixView />
      )}
    </section>
  )
}

/* -------------------------- スタッフ: 希望カレンダー -------------------------- */

function MyAvailabilityView() {
  const { me } = useMe()
  const [month, setMonth] = useState(() => {
    const n = new Date()
    return new Date(n.getFullYear(), n.getMonth(), 1)
  })
  const [storeId, setStoreId] = useState('')
  const [editing, setEditing] = useState<{ date: string; existing: AvailRow | null } | null>(null)
  const meta = useMemo(() => monthMeta(month), [month])
  const staffId = me!.staffId!

  const storesQ = useQuery({
    queryKey: ['my_shift_stores', staffId],
    queryFn: () => fetchMyStores(staffId),
  })

  // 所属が1つなら自動選択
  useEffect(() => {
    if (!storeId && storesQ.data?.length) setStoreId(storesQ.data[0].id)
  }, [storesQ.data, storeId])

  const availQ = useQuery({
    queryKey: ['avail', 'mine', staffId, meta.from],
    queryFn: () => fetchMyAvailability(staffId, meta.from, meta.to),
  })

  const holidaysQ = useQuery({
    queryKey: ['holidays', meta.from],
    queryFn: () => fetchHolidays(meta.from, meta.to),
  })

  const byDate = useMemo(() => {
    const m = new Map<string, AvailRow>()
    for (const r of availQ.data ?? []) if (r.store_id === storeId) m.set(r.work_date, r)
    return m
  }, [availQ.data, storeId])

  const counts = useMemo(() => {
    let a = 0,
      p = 0,
      o = 0
    for (const r of byDate.values()) {
      if (r.kind === 'avail') a++
      else if (r.kind === 'partial') p++
      else o++
    }
    return { a, p, o, total: byDate.size, blank: meta.days.length - byDate.size }
  }, [byDate, meta.days.length])

  if (!me) return null

  // 所属店舗の表示名: stores の RLS で隠れていたら me.stores から解決、
  // それも不可なら「所属店舗」（IDは正しいので保存には影響しない）
  const storeLabel = (s: { id: string; name: string | null }): string =>
    s.name ?? me.stores.find((x) => x.id === s.id)?.name ?? '所属店舗'

  if (storesQ.error) {
    return (
      <p className="login-error" role="alert">
        {errText(storesQ.error, '所属店舗を取得できませんでした')}
      </p>
    )
  }
  if (storesQ.data && storesQ.data.length === 0) {
    return <p className="note">所属店舗がありません。管理者に所属の登録を依頼してください。</p>
  }

  return (
    <>
      <div className="filter-row">
        <MonthNav month={month} label={meta.label} onChange={setMonth} />
        {(storesQ.data?.length ?? 0) > 1 && (
          <label className="field">
            <span>店舗（所属ベース）</span>
            <select value={storeId} onChange={(e) => setStoreId(e.target.value)}>
              {storesQ.data!.map((s) => (
                <option key={s.id} value={s.id}>
                  {storeLabel(s)}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="card kpi avail-summary">
        <div className="k">{meta.label}の希望（提出済みが一目で分かります）</div>
        <div className="v v-text">
          提出 {counts.total} 日 <small>/ {meta.days.length} 日</small>
        </div>
        <div className="d">
          ○ {counts.a} · △ {counts.p} · × {counts.o} · 未入力 {counts.blank}
        </div>
      </div>

      {availQ.error && (
        <p className="login-error" role="alert">
          {errText(availQ.error, '希望の取得に失敗しました')}
        </p>
      )}

      <Calendar
        meta={meta}
        holidays={holidaysQ.data ?? new Map()}
        cellOf={(date) => {
          const r = byDate.get(date)
          return r ? <AvailChip row={r} /> : null
        }}
        onTap={(date) => storeId && setEditing({ date, existing: byDate.get(date) ?? null })}
      />
      <p className="note">日をタップして ○（終日OK）/ △（時間指定）/ ×（NG）を入力します。</p>

      {editing && storeId && (
        <AvailEditorModal
          date={editing.date}
          existing={editing.existing}
          staffId={staffId}
          staffName={null}
          storeId={storeId}
          storeName={(() => {
            const s = storesQ.data?.find((x) => x.id === storeId)
            return s ? storeLabel(s) : ''
          })()}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  )
}

/* ------------------------------ カレンダー ------------------------------ */

function MonthNav({
  month,
  label,
  onChange,
}: {
  month: Date
  label: string
  onChange: (d: Date) => void
}) {
  const move = (diff: number) =>
    onChange(new Date(month.getFullYear(), month.getMonth() + diff, 1))
  return (
    <div className="month-nav">
      <button className="btn sm" onClick={() => move(-1)} aria-label="前の月">
        ←
      </button>
      <span className="month-label mono">{label}</span>
      <button className="btn sm" onClick={() => move(1)} aria-label="次の月">
        →
      </button>
    </div>
  )
}

const DOW_LABELS = ['日', '月', '火', '水', '木', '金', '土']

function Calendar({
  meta,
  holidays,
  cellOf,
  onTap,
}: {
  meta: MonthMeta
  holidays: Map<string, string>
  cellOf: (date: string) => React.ReactNode
  onTap?: (date: string) => void
}) {
  return (
    <div className="card cal-card">
      <div className="cal-grid">
        {DOW_LABELS.map((d, i) => (
          <div key={d} className={`cal-dow${i === 0 ? ' sun' : i === 6 ? ' sat' : ''}`}>
            {d}
          </div>
        ))}
        {Array.from({ length: meta.leadBlanks }, (_, i) => (
          <div key={`blank-${i}`} className="cal-day blank" />
        ))}
        {meta.days.map((d) => {
          const holiday = holidays.get(d.date)
          const dayCls = holiday || d.dow === 0 ? ' sun' : d.dow === 6 ? ' sat' : ''
          return (
            <button
              key={d.date}
              type="button"
              className="cal-day"
              onClick={() => onTap?.(d.date)}
            >
              <span className={`cal-num mono${dayCls}`}>{d.dayNum}</span>
              {holiday && <span className="cal-holiday">{holiday}</span>}
              <span className="cal-mark">{cellOf(d.date)}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function AvailChip({ row }: { row: AvailRow }) {
  if (row.kind === 'avail') return <span className="av-chip av-ok">○</span>
  if (row.kind === 'off') return <span className="av-chip av-ng">×</span>
  return (
    <span className="av-chip av-part">
      △<span className="av-time mono">{minToHHMM(row.start_min)}-{minToHHMM(row.end_min)}</span>
    </span>
  )
}

/* -------------------------- 希望の入力モーダル -------------------------- */

function AvailEditorModal({
  date,
  existing,
  staffId,
  staffName,
  storeId,
  storeName,
  onClose,
}: {
  date: string
  existing: AvailRow | null
  staffId: string
  /** 代理入力時のみ表示（本人入力は null） */
  staffName: string | null
  storeId: string
  storeName: string
  onClose: () => void
}) {
  const { me } = useMe()
  const qc = useQueryClient()
  const [kind, setKind] = useState<AvailKind>(existing?.kind ?? 'avail')
  const [start, setStart] = useState(minToHHMM(existing?.start_min ?? null))
  const [end, setEnd] = useState(minToHHMM(existing?.end_min ?? null))
  const [note, setNote] = useState(existing?.note ?? '')
  const [error, setError] = useState<string | null>(null)

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['avail'] })
    onClose()
  }

  const save = useMutation({
    mutationFn: () =>
      upsertAvailability({
        tenantId: me!.tenantId,
        storeId,
        staffId,
        workDate: date,
        kind,
        startMin: hhmmToMin(start),
        endMin: hhmmToMin(end),
        note: note.trim() || null,
      }),
    onSuccess: invalidate,
    onError: (e) => setError(availErrText(e)),
  })

  const remove = useMutation({
    mutationFn: () => deleteAvailability(existing!.id),
    onSuccess: invalidate,
    onError: (e) => setError(availErrText(e)),
  })

  const dateLabel = new Date(`${date}T00:00:00`).toLocaleDateString('ja-JP', {
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  })

  return (
    <div className="modal show" onClick={onClose} role="dialog" aria-modal="true">
      <div className="mcard mcard-wide avail-modal" onClick={(e) => e.stopPropagation()}>
        <div className="mh">
          {dateLabel} の希望{staffName ? `（${staffName} · 代理入力）` : ''} · {storeName}
        </div>

        {error && (
          <p className="login-error" role="alert">
            {error}
          </p>
        )}

        <div className="kind-pick">
          {(
            [
              ['avail', '○ 終日OK'],
              ['partial', '△ 時間指定'],
              ['off', '× NG'],
            ] as [AvailKind, string][]
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              className={`kind-pick-btn kp-${k}${kind === k ? ' on' : ''}`}
              onClick={() => {
                setKind(k)
                // △の初期値は毎正時にする。空のまま time picker を開くと
                // ブラウザが現在時刻（分まで）を初期表示してしまうため。
                if (k === 'partial') {
                  if (!start) setStart('17:00')
                  if (!end) setEnd('22:00')
                }
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {kind === 'partial' && (
          <div className="asg-grid">
            <label className="field">
              <span>開始</span>
              {/* step=3600: ピッカーは1時間刻み。手入力なら任意の分も可 */}
              <input
                type="time"
                step={3600}
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </label>
            <label className="field">
              <span>終了</span>
              <input
                type="time"
                step={3600}
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </label>
          </div>
        )}

        <label className="field">
          <span>メモ（任意）</span>
          <input
            className="ri"
            value={note}
            placeholder="例）授業のため夕方から"
            onChange={(e) => setNote(e.target.value)}
          />
        </label>

        <div className="mbtns">
          {existing && (
            <button
              className="btn sm danger"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              希望を消す
            </button>
          )}
          <button className="btn sm" onClick={onClose}>
            閉じる
          </button>
          <button
            className="btn sm pri"
            disabled={save.isPending}
            onClick={() => {
              setError(null)
              save.mutate()
            }}
          >
            {save.isPending ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}

/* -------------------------- 管理者: 希望マトリクス -------------------------- */

function MatrixView() {
  const { me } = useMe()
  const [month, setMonth] = useState(() => {
    const n = new Date()
    return new Date(n.getFullYear(), n.getMonth(), 1)
  })
  const [storeId, setStoreId] = useState('')
  const [editing, setEditing] = useState<{
    date: string
    staffId: string
    staffName: string
    existing: AvailRow | null
  } | null>(null)
  const meta = useMemo(() => monthMeta(month), [month])

  useEffect(() => {
    if (!storeId && me?.stores.length) setStoreId(me.stores[0].id)
  }, [me?.stores, storeId])

  const availQ = useQuery({
    queryKey: ['avail', 'store', storeId, meta.from],
    enabled: !!storeId,
    queryFn: () => fetchStoreAvailability(storeId, meta.from, meta.to),
  })

  const holidaysQ = useQuery({
    queryKey: ['holidays', meta.from],
    queryFn: () => fetchHolidays(meta.from, meta.to),
  })

  const staffQ = useQuery({ queryKey: ['master', 'staff'], queryFn: fetchStaffList })

  // 行 = この店舗の所属スタッフ（assignments が RLS で見えない場合は提出者のみ）
  const rows = useMemo(() => {
    const byAssignment = (staffQ.data ?? []).filter((s) =>
      s.assignments.some((a) => a.store_id === storeId && a.is_active),
    )
    if (byAssignment.length > 0) {
      return byAssignment.map((s) => ({ id: s.id, name: s.full_name }))
    }
    const seen = new Map<string, string>()
    for (const r of availQ.data ?? []) seen.set(r.staff_id, r.staff_name)
    return [...seen.entries()].map(([id, name]) => ({ id, name }))
  }, [staffQ.data, availQ.data, storeId])

  const cell = useMemo(() => {
    const m = new Map<string, AvailRow>()
    for (const r of availQ.data ?? []) m.set(`${r.staff_id}|${r.work_date}`, r)
    return m
  }, [availQ.data])

  if (!me) return null

  const storeName = me.stores.find((s) => s.id === storeId)?.name ?? ''

  return (
    <>
      <div className="filter-row">
        <MonthNav month={month} label={meta.label} onChange={setMonth} />
        <label className="field">
          <span>店舗</span>
          <select value={storeId} onChange={(e) => setStoreId(e.target.value)}>
            {me.stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {availQ.error && (
        <p className="login-error" role="alert">
          {errText(availQ.error, '希望の取得に失敗しました')}
        </p>
      )}

      {rows.length === 0 && !availQ.isPending && (
        <p className="note">この店舗にはまだ希望の提出も所属スタッフの表示もありません。</p>
      )}

      {rows.length > 0 && (
        <div className="card table-wrap">
          <table className="matrix-table">
            <thead>
              <tr>
                <th className="mx-name">スタッフ</th>
                {meta.days.map((d) => {
                  const holiday = holidaysQ.data?.get(d.date)
                  const cls = holiday || d.dow === 0 ? ' sun' : d.dow === 6 ? ' sat' : ''
                  return (
                    <th key={d.date} className={`mx-day mono${cls}`} title={holiday ?? undefined}>
                      {d.dayNum}
                      <span className="mx-dow">{DOW_LABELS[d.dow]}</span>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id}>
                  <td className="mx-name">
                    <b>{s.name}</b>
                  </td>
                  {meta.days.map((d) => {
                    const r = cell.get(`${s.id}|${d.date}`) ?? null
                    return (
                      <td
                        key={d.date}
                        className={`mx-cell${r ? ` mx-${r.kind}` : ''}`}
                        title={
                          r?.kind === 'partial'
                            ? `${minToHHMM(r.start_min)}〜${minToHHMM(r.end_min)}${r.note ? ` ${r.note}` : ''}`
                            : (r?.note ?? undefined)
                        }
                      >
                        <button
                          type="button"
                          className="mx-btn"
                          aria-label={`${s.name} ${d.date} の希望を編集`}
                          onClick={() =>
                            setEditing({ date: d.date, staffId: s.id, staffName: s.name, existing: r })
                          }
                        >
                          {r ? KIND_MARK[r.kind] : '·'}
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

      <p className="note">
        ○=終日OK / △=時間指定（セルにカーソルで時間表示）/ ×=NG / ·=未提出。
        セルをタップすると代理入力・修正ができます（自店のみ・RLSで強制）。
      </p>

      {editing && storeId && (
        <AvailEditorModal
          date={editing.date}
          existing={editing.existing}
          staffId={editing.staffId}
          staffName={editing.staffName}
          storeId={storeId}
          storeName={storeName}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  )
}

/* -------------------------- 管理者: 必要人数の定義 -------------------------- */

function Stepper({
  value,
  min = 0,
  onChange,
  label,
}: {
  value: number
  min?: number
  onChange: (v: number) => void
  label?: string
}) {
  return (
    <span className="stp" aria-label={label}>
      <button type="button" onClick={() => onChange(Math.max(min, value - 1))}>
        −
      </button>
      <b className="mono">{value}</b>
      <button type="button" onClick={() => onChange(value + 1)}>
        ＋
      </button>
    </span>
  )
}

function RequirementsView() {
  const { me } = useMe()
  const [storeId, setStoreId] = useState('')

  useEffect(() => {
    if (!storeId && me?.stores.length) setStoreId(me.stores[0].id)
  }, [me?.stores, storeId])

  const reqQ = useQuery({
    queryKey: ['shift_req', storeId],
    enabled: !!storeId,
    queryFn: () => fetchRequirements(storeId),
  })

  const kindsQ = useQuery({ queryKey: ['master', 'kinds'], queryFn: fetchEmploymentKinds })
  const posQ = useQuery({ queryKey: ['master', 'positions'], queryFn: fetchPositions })

  if (!me) return null

  // 打刻対象の区分のみ（業務委託などはシフト最低人数の対象外にしない方が自然だが、
  // まずは requires_clock=true の主要区分を出す）
  const kindLabels = (kindsQ.data ?? []).filter((k) => k.requires_clock).map((k) => k.label)

  // B案の主軸: この店舗のポジション（全店共通 + 店舗専用）
  const positionNames = (posQ.data ?? [])
    .filter((p) => p.store_id === null || p.store_id === storeId)
    .map((p) => p.name)

  return (
    <>
      <div className="filter-row">
        <label className="field">
          <span>店舗</span>
          <select value={storeId} onChange={(e) => setStoreId(e.target.value)}>
            {me.stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {reqQ.error && (
        <p className="login-error" role="alert">
          {reqErrText(reqQ.error)}
        </p>
      )}
      {reqQ.isPending && !!storeId && <p className="note">読み込み中…</p>}

      {positionNames.length === 0 && !posQ.isPending && (
        <p className="perm-banner" role="status">
          ポジションが未登録です。スタッフ・店舗ページでポジション（キッチン/フロア等）を
          登録すると、ポジション別に必要人数を組めます。それまでは全体人数のみの入力になります。
        </p>
      )}

      {reqQ.data &&
        DAY_TYPES.map((dt) => (
          <RequirementRowEditor
            key={`${storeId}|${dt.key}`}
            storeId={storeId}
            dayType={dt.key}
            dayLabel={dt.label}
            badgeCls={dt.badgeCls}
            kindLabels={kindLabels}
            positionNames={positionNames}
            initial={reqQ.data.find((r) => r.day_type === dt.key) ?? null}
          />
        ))}

      <p className="note">
        <b>ポジション別</b>が主軸です（キッチン2・フロア2 → 合計は自動計算して保存）。
        <b>区分別最低</b>＝「社員≥1」のような補助の下限（合計が必要人数を超えると警告が
        出ますが保存はできます）。曜日区分ごとに保存してください。シフト表の作成
        （段階2-b）でこのテンプレートと希望を突き合わせます。
      </p>
    </>
  )
}

function RequirementRowEditor({
  storeId,
  dayType,
  dayLabel,
  badgeCls,
  kindLabels,
  positionNames,
  initial,
}: {
  storeId: string
  dayType: DayType
  dayLabel: string
  badgeCls: string
  kindLabels: string[]
  positionNames: string[]
  initial: RequirementRow | null
}) {
  const { me } = useMe()
  const qc = useQueryClient()
  const hasPositions = positionNames.length > 0
  // B案: ポジションがあれば need はポジション合計の自動計算。無い店では手動。
  const [manualNeed, setManualNeed] = useState(initial?.need_count ?? 0)
  const [needByPos, setNeedByPos] = useState<Record<string, number>>(
    initial?.need_by_position ?? {},
  )
  const [minByKind, setMinByKind] = useState<Record<string, number>>(initial?.min_by_kind ?? {})
  const [memo, setMemo] = useState(initial?.memo ?? '')
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const posSum = Object.values(needByPos).reduce((s, v) => s + (v > 0 ? v : 0), 0)
  const need = hasPositions ? posSum : manualNeed

  // 表示専用フォールバック: ポジション別未入力の行では保存済み need_count を見せる
  // （save が書く値は従来どおり need。ここは数値表示のみで他の計算に流用しない）
  const storedNeed = initial?.need_count ?? 0
  const needFallback = hasPositions && posSum === 0 && storedNeed > 0
  const displayNeed = needFallback ? storedNeed : need

  const save = useMutation({
    mutationFn: () =>
      upsertRequirement({
        tenantId: me!.tenantId,
        storeId,
        dayType,
        needCount: need,
        needByPosition: hasPositions ? needByPos : {},
        minByKind,
        memo: memo.trim() || null,
      }),
    onSuccess: () => {
      setMsg('保存しました ✓')
      void qc.invalidateQueries({ queryKey: ['shift_req', storeId] })
    },
    onError: (e) => setError(reqErrText(e)),
  })

  const minSum = Object.values(minByKind).reduce((s, v) => s + (v > 0 ? v : 0), 0)
  const over = minSum > need

  const posSummary = Object.entries(needByPos)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k}${v}`)
    .join('・')
  const kindSummary = Object.entries(minByKind)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k}≥${v}`)
    .join('・')
  const summary =
    [posSummary, kindSummary].filter(Boolean).join(' ／ ') || '条件なし'

  return (
    <div className="card req-row">
      <div className="req-head">
        <span className={`dtype-badge ${badgeCls}`}>{dayLabel}</span>
        <div className="req-need">
          <span className="req-lab">必要人数{hasPositions ? '（自動集計）' : ''}</span>
          {hasPositions ? (
            <b className="mono req-total">{displayNeed}</b>
          ) : (
            <Stepper value={manualNeed} onChange={setManualNeed} label={`${dayLabel}の必要人数`} />
          )}
        </div>
        <button
          className="btn sm pri req-save"
          disabled={save.isPending}
          onClick={() => {
            setMsg(null)
            setError(null)
            // 0上書きガード: ポジション登録済みの店でポジション別が未入力のまま保存すると
            // need=posSum=0 となり、保存済みの need_count を 0 で潰す（データ破壊）。必ず確認を挟む
            const storedNeedCount = initial?.need_count ?? 0
            if (hasPositions && posSum === 0 && storedNeedCount > 0) {
              if (
                !confirm(
                  `ポジション別が未入力のため必要人数0で保存されます。\n現在の必要人数(${storedNeedCount})と充足度表示が失われます。続行しますか？`,
                )
              ) {
                return
              }
            }
            save.mutate()
          }}
        >
          {save.isPending ? '保存中…' : '保存'}
        </button>
      </div>

      {needFallback && (
        <p className="note req-fallback-note">
          ポジション別未設定（保存済み必要人数を表示中）。ポジション別を入力して保存してください。
          未入力のまま保存すると0になります。
        </p>
      )}

      {hasPositions && (
        <div className="condrow pos-row">
          <span className="req-lab">ポジション別</span>
          {positionNames.map((name) => (
            <span key={name} className="mm pp">
              {name}
              <Stepper
                value={needByPos[name] ?? 0}
                onChange={(v) => setNeedByPos({ ...needByPos, [name]: v })}
                label={`${name}の必要人数`}
              />
            </span>
          ))}
        </div>
      )}

      <div className="condrow">
        <span className="req-lab">区分別最低</span>
        {kindLabels.map((label) => (
          <span key={label} className="mm">
            {label}
            <Stepper
              value={minByKind[label] ?? 0}
              onChange={(v) => setMinByKind({ ...minByKind, [label]: v })}
              label={`${label}の最低人数`}
            />
          </span>
        ))}
        <input
          className="ri req-memo"
          value={memo}
          placeholder="メモ（任意）例）宴会シーズンは+1"
          onChange={(e) => setMemo(e.target.value)}
        />
      </div>

      <div className="condsum note">
        → {summary}
        {over && (
          <span className="req-warn">
            ⚠ 区分別最低の合計（{minSum}人）が必要人数（{need}人）を超えています
          </span>
        )}
        {msg && <span className="req-ok">{msg}</span>}
      </div>

      {error && (
        <p className="login-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

/* -------------------------- 管理者: シフト作成（週） -------------------------- */

interface WeekMeta {
  label: string
  from: string
  to: string
  days: { date: string; dayNum: number; dow: number }[]
}

/** 日曜始まりの1週間 */
function weekMeta(base: Date): WeekMeta {
  const sun = new Date(base.getFullYear(), base.getMonth(), base.getDate() - base.getDay())
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(sun.getFullYear(), sun.getMonth(), sun.getDate() + i)
    return { date: ymd(d), dayNum: d.getDate(), dow: d.getDay() }
  })
  const fmt = (s: string) => {
    const d = new Date(`${s}T00:00:00`)
    return `${d.getMonth() + 1}/${d.getDate()}`
  }
  return {
    label: `${fmt(days[0].date)}〜${fmt(days[6].date)}`,
    from: days[0].date,
    to: days[6].date,
    days,
  }
}

function dayTypeOf(dow: number, isHoliday: boolean): DayType {
  if (isHoliday) return 'holiday'
  if (dow === 0) return 'sun'
  if (dow === 6) return 'sat'
  if (dow === 5) return 'fri'
  return 'weekday'
}

function BuildView() {
  const { me } = useMe()
  const { user } = useAuth()
  const { has } = usePermissions()
  const qc = useQueryClient()
  const [storeId, setStoreId] = useState('')
  const [weekBase, setWeekBase] = useState(() => new Date())
  const [pubMsg, setPubMsg] = useState<string | null>(null)
  const [pubErr, setPubErr] = useState<string | null>(null)
  const [notify, setNotify] = useState(false)
  const [editing, setEditing] = useState<
    | { mode: 'create'; date: string; staffId: string; staffName: string; avail: AvailRow | null }
    | { mode: 'edit'; asg: ShiftAsg }
    | null
  >(null)
  const [adding, setAdding] = useState<string | null>(null) // ＋スタッフを追加を開いた日付
  const [offerOpen, setOfferOpen] = useState<string | null>(null) // 開いているオファー枠の id
  const week = useMemo(() => weekMeta(weekBase), [weekBase])

  const canAnnounce = has('announce_post')

  const publish = useMutation({
    mutationFn: async (): Promise<string> => {
      const n = await publishWeek(storeId, week.from, week.to)
      let msg = `${n} 件のシフトを確定・公開しました ✓`

      // 通知は best-effort: 失敗しても確定・公開は成立したまま（ロールバックしない）
      if (notify && canAnnounce && user && me) {
        const storeName = me.stores.find((s) => s.id === storeId)?.name ?? '店舗'
        try {
          const annId = await createAnnouncement(me.tenantId, user.id, {
            title: `${week.label}のシフトが確定しました`,
            body: [
              `${week.label} の ${storeName} のシフトが確定しました。`,
              'マイシフトで自分の勤務予定をご確認ください。',
              'https://kintai.worldwave.workers.dev/shifts',
            ].join('\n'),
            importance: 'important',
            scopeType: 'stores',
            storeIds: [storeId],
            kindIds: [],
          })
          try {
            const r = await sendAnnouncementMail({ data: { announcement_id: annId } })
            const extras: string[] = []
            if (r.failed > 0) extras.push(`失敗 ${r.failed} 件`)
            if (r.skipped > 0) extras.push(`アドレス未登録 ${r.skipped} 件`)
            msg += ` 掲示板に投稿し、${r.sent}人にメールを送信しました${extras.length > 0 ? `（${extras.join('・')}）` : ''}`
          } catch (e) {
            msg += ` 掲示板に投稿しました（メール送信は失敗：${annErrText(e, '送信エラー')}）`
          }
        } catch (e) {
          msg += `（掲示板への通知に失敗：${annErrText(e, '投稿エラー')}）`
        }
      }
      return msg
    },
    onSuccess: (msg) => {
      setPubMsg(msg)
      void qc.invalidateQueries({ queryKey: ['shift_asg'] })
      void qc.invalidateQueries({ queryKey: ['announcements'] })
      void qc.invalidateQueries({ queryKey: ['ann_unread'] })
    },
    onError: (e) => setPubErr(asgErrText(e)),
  })

  useEffect(() => {
    if (!storeId && me?.stores.length) setStoreId(me.stores[0].id)
  }, [me?.stores, storeId])

  const asgQ = useQuery({
    queryKey: ['shift_asg', storeId, week.from],
    enabled: !!storeId,
    queryFn: () => fetchAssignments(storeId, week.from, week.to),
  })
  const availQ = useQuery({
    queryKey: ['avail', 'store', storeId, 'wk', week.from],
    enabled: !!storeId,
    queryFn: () => fetchStoreAvailability(storeId, week.from, week.to),
  })
  const reqQ = useQuery({
    queryKey: ['shift_req', storeId],
    enabled: !!storeId,
    queryFn: () => fetchRequirements(storeId),
  })
  const posQ = useQuery({ queryKey: ['master', 'positions'], queryFn: fetchPositions })
  const holidaysQ = useQuery({
    queryKey: ['holidays', week.from, 'wk'],
    queryFn: () => fetchHolidays(week.from, week.to),
  })
  // 所属スタッフ（希望に関わらず直接配置する候補）。0012 definer 関数経由＝賃金権限に依存しない
  const rosterQ = useQuery({
    queryKey: ['store_roster', storeId],
    enabled: !!storeId,
    queryFn: () => fetchStoreRoster(storeId),
  })
  // オファー枠（RLS so_sel/sor_sel = 管理者スコープ）。招待行は週内全枠ぶんを一括取得
  const offersQ = useQuery({
    queryKey: ['offers', storeId, week.from],
    enabled: !!storeId,
    queryFn: () => fetchOffers(storeId, week.from, week.to),
  })
  const offerIds = useMemo(() => (offersQ.data ?? []).map((o) => o.id), [offersQ.data])
  const offRecQ = useQuery({
    queryKey: ['offer_recipients', offerIds.join('|')],
    enabled: offerIds.length > 0,
    queryFn: () => fetchOfferRecipients(offerIds),
  })
  const recsByOffer = useMemo(() => {
    const m = new Map<string, OfferRecipientRow[]>()
    for (const r of offRecQ.data ?? []) {
      const list = m.get(r.offer_id) ?? []
      list.push(r)
      m.set(r.offer_id, list)
    }
    return m
  }, [offRecQ.data])

  // 下書きオファー（未送信）の集計と一斉送信（フェーズ②）
  const [draftPanelOpen, setDraftPanelOpen] = useState(false)
  const [draftMsg, setDraftMsg] = useState<string | null>(null)
  const [draftErr, setDraftErr] = useState<string | null>(null)
  const draftPrevQ = useQuery({
    queryKey: ['offer_draft_preview', storeId],
    enabled: !!storeId,
    queryFn: () => previewDraftOffers(storeId),
  })
  const sendDrafts = useMutation({
    mutationFn: () => sendDraftOffers(storeId),
    onSuccess: (r) => {
      setDraftMsg(
        `${r.sent_mails}通送信 / ${r.offers_opened}枠を公開` +
          (r.skipped_overdue > 0 ? ` / 締切切れ ${r.skipped_overdue}件スキップ` : '') +
          (r.skipped_no_email > 0 ? ` / メール未登録 ${r.skipped_no_email}件` : ''),
      )
      setDraftPanelOpen(false)
      void qc.invalidateQueries({ queryKey: ['offers'] })
      void qc.invalidateQueries({ queryKey: ['offer_recipients'] })
      void qc.invalidateQueries({ queryKey: ['offer_draft_preview'] })
    },
    onError: (e) => setDraftErr(errText(e, '一斉送信に失敗しました')),
  })

  if (!me) return null

  const positions = (posQ.data ?? []).filter((p) => p.store_id === null || p.store_id === storeId)
  const posName = (id: string | null) =>
    id ? (positions.find((p) => p.id === id)?.name ?? 'ポジション') : null
  const reqByType = new Map((reqQ.data ?? []).map((r) => [r.day_type, r]))
  const holidays = holidaysQ.data ?? new Map<string, string>()

  const draftCount = (asgQ.data ?? []).filter((a) => a.status === 'draft').length
  const pubCount = (asgQ.data ?? []).filter((a) => a.status === 'published').length

  return (
    <>
      <div className="filter-row">
        <div className="month-nav">
          <button
            className="btn sm"
            aria-label="前の週"
            onClick={() =>
              setWeekBase(new Date(weekBase.getFullYear(), weekBase.getMonth(), weekBase.getDate() - 7))
            }
          >
            ←
          </button>
          <span className="month-label mono">{week.label}</span>
          <button
            className="btn sm"
            aria-label="次の週"
            onClick={() =>
              setWeekBase(new Date(weekBase.getFullYear(), weekBase.getMonth(), weekBase.getDate() + 7))
            }
          >
            →
          </button>
        </div>
        <label className="field">
          <span>店舗</span>
          <select value={storeId} onChange={(e) => setStoreId(e.target.value)}>
            {me.stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="publish-row">
        {draftCount > 0 && (
          <button
            className="btn-dl publish-btn"
            disabled={publish.isPending}
            onClick={() => {
              setPubMsg(null)
              setPubErr(null)
              const notifyNote =
                notify && canAnnounce ? '\n掲示板への投稿と対象店舗スタッフへのメール送信も行います。' : ''
              if (
                confirm(
                  `${week.label} のシフトを確定して公開しますか？\n公開後はスタッフのマイシフトに表示されます（スタッフは直接編集できません）。${notifyNote}`,
                )
              ) {
                publish.mutate()
              }
            }}
          >
            {publish.isPending ? '公開中…' : `この週を確定・公開（下書き ${draftCount} 件）`}
          </button>
        )}
        {draftCount > 0 && (
          <label className="target-check publish-notify">
            <input
              type="checkbox"
              checked={notify && canAnnounce}
              disabled={!canAnnounce || publish.isPending}
              onChange={(e) => setNotify(e.target.checked)}
            />
            <span>
              掲示板で通知＋メール送信する
              {!canAnnounce && <span className="note">（掲示板投稿権限が必要です）</span>}
            </span>
          </label>
        )}
        {draftCount === 0 && pubCount > 0 && <span className="pub-badge">公開済み</span>}
        {draftCount > 0 && pubCount > 0 && (
          <span className="note">公開済み {pubCount} 件 / 下書き {draftCount} 件</span>
        )}
        {pubMsg && <span className="req-ok">{pubMsg}</span>}
        {pubErr && (
          <span className="login-error" role="alert">
            {pubErr}
          </span>
        )}
      </div>

      {(draftPrevQ.data?.total_offers ?? 0) > 0 && (
        <div className="draft-offers-panel">
          <div className="dop-head">
            <b>
              未送信の下書きオファー: {draftPrevQ.data!.total_offers}枠・
              {draftPrevQ.data!.recipients.length}名
            </b>
            <button className="btn sm" onClick={() => setDraftPanelOpen((v) => !v)}>
              {draftPanelOpen ? '閉じる' : 'まとめて送信'}
            </button>
          </div>
          {draftPanelOpen && (
            <>
              <div className="dop-list">
                {draftPrevQ.data!.recipients.map((r) => (
                  <span key={r.staff_id} className="dop-rec">
                    {r.staff_name}…{r.count}件
                    {!r.has_email && (
                      <em className="dop-warn">メール未登録のため送信されません</em>
                    )}
                  </span>
                ))}
              </div>
              <button
                className="btn-dl publish-btn"
                disabled={sendDrafts.isPending}
                onClick={() => {
                  setDraftMsg(null)
                  setDraftErr(null)
                  if (
                    confirm(
                      `下書き ${draftPrevQ.data!.total_offers}枠 を一斉送信します（スタッフ1人につき1通にまとめます）。よろしいですか？`,
                    )
                  ) {
                    sendDrafts.mutate()
                  }
                }}
              >
                {sendDrafts.isPending ? '送信中…' : 'この内容で一斉送信'}
              </button>
            </>
          )}
        </div>
      )}
      {draftMsg && (
        <p className="board-info" role="status">
          {draftMsg}
        </p>
      )}
      {draftErr && (
        <p className="login-error" role="alert">
          {draftErr}
        </p>
      )}

      {(asgQ.error || availQ.error) && (
        <p className="login-error" role="alert">
          {asgErrText(asgQ.error ?? availQ.error)}
        </p>
      )}

      <div className="week-grid">
        {week.days.map((d) => {
          const holiday = holidays.get(d.date)
          const dt = dayTypeOf(d.dow, !!holiday)
          const req = reqByType.get(dt) ?? null
          const dayAsgs = (asgQ.data ?? []).filter((a) => a.work_date === d.date)
          const assignedStaff = new Set(dayAsgs.map((a) => a.staff_id))
          const pool = (availQ.data ?? []).filter(
            (r) => r.work_date === d.date && r.kind !== 'off' && !assignedStaff.has(r.staff_id),
          )
          const weightOf = (a: ShiftAsg) => (a.weight_half ? 0.5 : 1)
          const total = dayAsgs.reduce((s, a) => s + weightOf(a), 0)
          const need = req?.need_count ?? 0
          const byPos = new Map<string, number>()
          for (const a of dayAsgs) {
            const n = posName(a.position_id)
            if (n) byPos.set(n, (byPos.get(n) ?? 0) + weightOf(a))
          }
          const dayCls = holiday || d.dow === 0 ? ' sun' : d.dow === 6 ? ' sat' : ''

          return (
            <div key={d.date} className="day-card card">
              <div className="day-head">
                <span className={`cal-num mono${dayCls}`}>
                  {d.dayNum}
                  <small className="day-dow">（{DOW_LABELS[d.dow]}）</small>
                </span>
                {holiday && <span className="cal-holiday">{holiday}</span>}
                {need > 0 && (
                  <span className={`cov-total mono${total >= need ? ' ok' : ' short'}`}>
                    {total}/{need}
                  </span>
                )}
              </div>

              {req && Object.keys(req.need_by_position).length > 0 && (
                <div className="cov-rows">
                  {Object.entries(req.need_by_position).map(([name, needN]) => {
                    const got = byPos.get(name) ?? 0
                    return (
                      <span key={name} className={`cov mono${got >= needN ? ' ok' : ' short'}`}>
                        {name} {got}/{needN}
                      </span>
                    )
                  })}
                </div>
              )}

              {(() => {
                const dayOffers = (offersQ.data ?? []).filter((o) => o.work_date === d.date)
                if (dayOffers.length === 0) return null
                return (
                  <div className="day-offers">
                    {dayOffers.map((o) => {
                      const recs = recsByOffer.get(o.id) ?? []
                      const appliedN = recs.filter((r) => r.response === 'applied').length
                      const winner =
                        recs.find((r) => r.response === 'confirmed')?.staff_name ?? null
                      const overdue = o.status === 'open' && new Date(o.deadline_at) < new Date()
                      const cls =
                        o.status === 'draft'
                          ? 'oc-draft'
                          : o.status === 'filled'
                            ? 'oc-filled'
                            : o.status === 'cancelled'
                              ? 'oc-cancelled'
                              : o.status === 'expired'
                                ? 'oc-expired'
                                : appliedN > 0
                                  ? 'oc-attn'
                                  : 'oc-open'
                      const badge =
                        o.status === 'draft'
                          ? '下書き（未送信）'
                          : o.status === 'filled'
                            ? `確定：${winner ?? '確定済み'}${winner ? 'さん' : ''}`
                            : o.status === 'cancelled'
                              ? '取消'
                              : o.status === 'expired'
                                ? '期限切れ'
                                : appliedN > 0
                                  ? `申請 ${appliedN}件・確認待ち`
                                  : '募集中（承諾待ち）'
                      return (
                        <button
                          key={o.id}
                          type="button"
                          className={`offer-chip ${cls}`}
                          onClick={() => setOfferOpen(o.id)}
                        >
                          <span className="mono">
                            {minToHHMM(o.start_min)}-{minToHHMM(o.end_min)}
                          </span>
                          <span className="oc-pos">{posName(o.position_id) ?? '不問'}</span>
                          <b className="oc-badge">{badge}</b>
                          {o.status === 'open' && (
                            <span className="oc-deadline mono">
                              〆
                              {new Date(o.deadline_at).toLocaleString('ja-JP', {
                                month: 'numeric',
                                day: 'numeric',
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                              {overdue && <em className="oc-overdue">締切超過</em>}
                            </span>
                          )}
                        </button>
                      )
                    })}
                  </div>
                )
              })()}

              <div className="day-asgs">
                {dayAsgs.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    className="asg-chip"
                    title={a.note ?? undefined}
                    onClick={() => setEditing({ mode: 'edit', asg: a })}
                  >
                    <b>{a.staff_name}</b>
                    {a.status === 'draft' && <span className="draft-mark">下書き</span>}
                    {a.weight_half && <span className="half-mark">0.5</span>}
                    <span className="mono asg-time">
                      {minToHHMM(a.start_min)}-{minToHHMM(a.end_min)}
                    </span>
                    {posName(a.position_id) && (
                      <span className="asg-pos">{posName(a.position_id)}</span>
                    )}
                  </button>
                ))}
                {dayAsgs.length === 0 && <span className="note day-empty">未配置</span>}
              </div>

              {pool.length > 0 && (
                <div className="day-pool">
                  <div className="pool-lab">希望者（タップで配置）</div>
                  {pool.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      className="pool-chip"
                      onClick={() =>
                        setEditing({
                          mode: 'create',
                          date: d.date,
                          staffId: r.staff_id,
                          staffName: r.staff_name,
                          avail: r,
                        })
                      }
                    >
                      {KIND_MARK[r.kind]} {r.staff_name}
                      {r.kind === 'partial' && (
                        <span className="mono pool-time">
                          {minToHHMM(r.start_min)}-{minToHHMM(r.end_min)}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}

              <button
                type="button"
                className="btn sm add-staff-btn"
                onClick={() => setAdding(d.date)}
              >
                ＋ スタッフを追加
              </button>
            </div>
          )
        })}
      </div>

      <p className="note">
        希望を出した人だけが各日の「希望者」に並びます。タップで下書き（draft）として配置し、
        配置済みチップのタップで時間・ポジション・0.5換算の編集や削除ができます。
        公開（スタッフへの通知）は次の段階です。
      </p>

      {editing && storeId && (
        <AsgEditorModal
          storeId={storeId}
          positions={positions}
          editing={editing}
          onClose={() => setEditing(null)}
        />
      )}

      {adding && storeId && (
        <AddStaffModal
          date={adding}
          storeId={storeId}
          positions={positions}
          weekDays={week.days}
          roster={rosterQ.data ?? []}
          rosterLoading={rosterQ.isPending}
          avails={(availQ.data ?? []).filter((r) => r.work_date === adding)}
          assignedIds={
            new Set(
              (asgQ.data ?? []).filter((a) => a.work_date === adding).map((a) => a.staff_id),
            )
          }
          onPick={(entry, avail) => {
            // ×（NG）希望でも管理者判断で配置できる。ただし必ず警告を挟む
            if (avail?.kind === 'off') {
              if (
                !confirm(
                  `${entry.name} さんはこの日「×（NG）」希望です。それでも配置しますか？`,
                )
              ) {
                return
              }
            }
            setEditing({
              mode: 'create',
              date: adding,
              staffId: entry.staffId,
              staffName: entry.name,
              avail,
            })
            setAdding(null)
          }}
          onClose={() => setAdding(null)}
        />
      )}

      {offerOpen &&
        (() => {
          const offer = (offersQ.data ?? []).find((o) => o.id === offerOpen)
          if (!offer) return null
          return (
            <OfferModal
              offer={offer}
              recipients={recsByOffer.get(offer.id) ?? []}
              positionName={posName(offer.position_id)}
              onClose={() => setOfferOpen(null)}
            />
          )
        })()}
    </>
  )
}

const OFFER_STATUS_LABEL: Record<OfferRow['status'], string> = {
  draft: '下書き（未送信）',
  open: '募集中',
  filled: '確定済み',
  cancelled: '取消',
  expired: '期限切れ',
}

const OFFER_RESPONSE_LABEL: Record<OfferRecipientRow['response'], string> = {
  pending: '未応答',
  applied: '申請済み',
  declined: '辞退',
  confirmed: '確定',
  superseded: '他の方で確定',
}

/** オファー枠の申請者一覧＋確定/取消（confirm はブラウザ直 rpc。排他・権限は definer が最終防壁） */
function OfferModal({
  offer,
  recipients,
  positionName,
  onClose,
}: {
  offer: OfferRow
  recipients: OfferRecipientRow[]
  positionName: string | null
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['offers'] })
    void qc.invalidateQueries({ queryKey: ['offer_recipients'] })
    // 確定で shift_assignments(draft) が増える＝シフト表示・充足度に反映
    void qc.invalidateQueries({ queryKey: ['shift_asg'] })
  }

  const confirmMut = useMutation({
    mutationFn: (a: { recipientId: string; staffName: string }) =>
      confirmOfferRecipient(a.recipientId),
    onSuccess: (r, a) => {
      invalidate()
      if (r.ok) {
        setMsg(
          `${a.staffName}さんで確定しました` +
            (r.overlapWarning
              ? '\n※同じ日に別の時間帯の予定と重なっています。ご確認ください'
              : ''),
        )
        return
      }
      switch (r.reason) {
        case 'already_filled':
          setErr('この枠は既に確定済みです')
          break
        case 'forbidden':
          setErr('確定する権限がありません')
          break
        case 'not_applicable':
          setErr('この申請は確定できません（辞退/取消済み）')
          break
        case 'expired':
          setErr('募集期限が過ぎています')
          break
        case 'cancelled':
          setErr('この募集は取り消されました')
          break
        default:
          setErr('確定できませんでした')
      }
    },
    onError: (e) => setErr(errText(e, '確定できませんでした')),
  })

  const cancelMut = useMutation({
    mutationFn: () => cancelOffer(offer.id),
    onSuccess: () => {
      invalidate()
      setMsg('募集を取り消しました')
    },
    onError: (e) => setErr(errText(e, '募集を取り消せませんでした')),
  })

  const winner = recipients.find((r) => r.response === 'confirmed')
  const dateLabel = new Date(`${offer.work_date}T00:00:00`).toLocaleDateString('ja-JP', {
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  })
  const deadlineLabel = new Date(offer.deadline_at).toLocaleString('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

  return (
    <div className="modal show" onClick={onClose} role="dialog" aria-modal="true">
      <div className="mcard mcard-wide" onClick={(e) => e.stopPropagation()}>
        <div className="mh">{dateLabel} · オファー枠</div>
        <div className="board-meta">
          <span className="mono">
            {minToHHMM(offer.start_min)}-{minToHHMM(offer.end_min)}
          </span>
          <span>{positionName ?? 'ポジション不問'}</span>
          <span className="mono">〆 {deadlineLabel}</span>
          <span>状態: {OFFER_STATUS_LABEL[offer.status]}</span>
        </div>

        {winner && (
          <p className="note oc-winner">
            確定：<b>{winner.staff_name}</b> さん
          </p>
        )}
        {err && (
          <p className="login-error" role="alert">
            {err}
          </p>
        )}
        {msg && (
          <p className="board-info offer-msg" role="status">
            {msg}
          </p>
        )}

        <div className="offer-apps">
          {recipients.length === 0 && <p className="note">招待がありません。</p>}
          {recipients.map((r) => (
            <div key={r.id} className={`offer-app resp-${r.response}`}>
              <div className="offer-app-top">
                <b>{r.staff_name}</b>
                <span className={`badge resp-badge-${r.response}`}>
                  {OFFER_RESPONSE_LABEL[r.response]}
                </span>
                {r.responded_at && (
                  <span className="mono oa-time">
                    {new Date(r.responded_at).toLocaleString('ja-JP', {
                      month: 'numeric',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                )}
                {r.response === 'applied' && (
                  <button
                    className="btn sm pri oa-confirm"
                    disabled={offer.status !== 'open' || confirmMut.isPending}
                    onClick={() => {
                      setErr(null)
                      setMsg(null)
                      confirmMut.mutate({ recipientId: r.id, staffName: r.staff_name })
                    }}
                  >
                    この人で確定
                  </button>
                )}
              </div>
              {r.comment && <div className="offer-app-comment">💬 {r.comment}</div>}
            </div>
          ))}
        </div>

        <div className="mbtns">
          {offer.status === 'open' && (
            <button
              className="btn sm danger"
              disabled={cancelMut.isPending}
              onClick={() => {
                if (confirm('この募集を取り消しますか？（招待済みの方は承諾できなくなります）')) {
                  setErr(null)
                  setMsg(null)
                  cancelMut.mutate()
                }
              }}
            >
              募集を取り消す
            </button>
          )}
          <button className="btn sm" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  )
}

/** datetime-local 用のローカル時刻文字列 */
function localDatetimeValue(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 希望の有無に関わらず所属スタッフから選んで配置 / オファー招待を送るモーダル */
function AddStaffModal({
  date,
  storeId,
  positions,
  weekDays,
  roster,
  rosterLoading,
  avails,
  assignedIds,
  onPick,
  onClose,
}: {
  date: string
  storeId: string
  positions: { id: string; name: string }[]
  weekDays: { date: string; dayNum: number; dow: number }[]
  roster: RosterEntry[]
  rosterLoading: boolean
  avails: AvailRow[]
  assignedIds: Set<string>
  onPick: (entry: RosterEntry, avail: AvailRow | null) => void
  onClose: () => void
}) {
  const [tab, setTab] = useState<'add' | 'offer'>('add')

  // ---- オファータブの状態（既定: そのカードの日・17-22・締切48h後） ----
  const [offDates, setOffDates] = useState<string[]>([date])
  const [offPos, setOffPos] = useState('')
  const [offStart, setOffStart] = useState('17:00')
  const [offEnd, setOffEnd] = useState('22:00')
  const [offDeadline, setOffDeadline] = useState(() =>
    localDatetimeValue(new Date(Date.now() + 48 * 3600 * 1000)),
  )
  const [offStaff, setOffStaff] = useState<string[]>([])
  const [offErr, setOffErr] = useState<string | null>(null)
  const [offMsg, setOffMsg] = useState<string | null>(null)

  const toggle = (list: string[], v: string): string[] =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v]

  const qcModal = useQueryClient()
  const send = useMutation({
    mutationFn: async () => {
      const s = hhmmToMin(offStart)
      const e = hhmmToMin(offEnd)
      if (s === null || e === null || s >= e) {
        throw new Error('開始と終了の時間を正しく入力してください。')
      }
      if (offDates.length === 0) throw new Error('対象日を選んでください。')
      if (offStaff.length === 0) throw new Error('招待する人を選んでください。')
      const dl = new Date(offDeadline)
      if (Number.isNaN(dl.getTime()) || dl.getTime() <= Date.now()) {
        throw new Error('締切は未来の日時にしてください。')
      }
      // フェーズ②: 下書き保存のみ（メール0通）。送信は週ビューの「まとめて送信」から
      return createDraftOffers({
        store_id: storeId,
        drafts: [...offDates].sort().map((d) => ({
          work_date: d,
          position_id: offPos || null,
          start_min: s,
          end_min: e,
          deadline_at: dl.toISOString(),
          staff_ids: offStaff,
        })),
      })
    },
    onSuccess: (r) => {
      setOffMsg(
        `下書きに保存しました：${r.created_offers}枠 / 招待予定 ${r.invited}名` +
          (r.skipped.length > 0 ? ` / スキップ ${r.skipped.length}件` : '') +
          '（メールはまだ送信されていません）',
      )
      void qcModal.invalidateQueries({ queryKey: ['offers'] })
      void qcModal.invalidateQueries({ queryKey: ['offer_recipients'] })
      void qcModal.invalidateQueries({ queryKey: ['offer_draft_preview'] })
    },
    onError: (e) => setOffErr(e instanceof Error ? e.message : '保存に失敗しました。'),
  })

  const availBy = new Map(avails.map((r) => [r.staff_id, r]))
  const dateLabel = new Date(`${date}T00:00:00`).toLocaleDateString('ja-JP', {
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  })

  const firstDate = [...offDates].sort()[0]
  const firstLabel = firstDate
    ? new Date(`${firstDate}T00:00:00`).toLocaleDateString('ja-JP', {
        month: 'numeric',
        day: 'numeric',
      })
    : ''

  return (
    <div className="modal show" onClick={onClose} role="dialog" aria-modal="true">
      <div className="mcard mcard-wide" onClick={(e) => e.stopPropagation()}>
        <div className="mh">{dateLabel} · スタッフ</div>

        <div className="pick-row modal-tabs">
          <button
            type="button"
            className={`pick-btn${tab === 'add' ? ' on' : ''}`}
            onClick={() => setTab('add')}
          >
            追加（直接配置）
          </button>
          <button
            type="button"
            className={`pick-btn${tab === 'offer' ? ' on' : ''}`}
            onClick={() => setTab('offer')}
          >
            オファー（メール招待）
          </button>
        </div>

        {rosterLoading && <p className="note">読み込み中…</p>}
        {!rosterLoading && roster.length === 0 && (
          <p className="note">追加できるスタッフがいません。</p>
        )}

        {tab === 'offer' && !rosterLoading && roster.length > 0 && (
          <div className="offer-compose">
            {offErr && (
              <p className="login-error" role="alert">
                {offErr}
              </p>
            )}
            {offMsg && (
              <p className="board-info" role="status">
                {offMsg}
              </p>
            )}

            <div className="field board-field">
              <span>対象日（複数可・同じ時間帯で1日=1枠）</span>
              <div className="target-checks">
                {weekDays.map((d) => (
                  <label key={d.date} className="target-check">
                    <input
                      type="checkbox"
                      checked={offDates.includes(d.date)}
                      onChange={() => setOffDates((prev) => toggle(prev, d.date))}
                    />
                    <span>
                      {d.dayNum}
                      <small>（{DOW_LABELS[d.dow]}）</small>
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <div className="asg-grid">
              <label className="field">
                <span>開始</span>
                <input
                  type="time"
                  step={3600}
                  value={offStart}
                  onChange={(e) => setOffStart(e.target.value)}
                />
              </label>
              <label className="field">
                <span>終了</span>
                <input
                  type="time"
                  step={3600}
                  value={offEnd}
                  onChange={(e) => setOffEnd(e.target.value)}
                />
              </label>
            </div>

            <div className="asg-grid">
              <label className="field">
                <span>ポジション</span>
                <select value={offPos} onChange={(e) => setOffPos(e.target.value)}>
                  <option value="">不問</option>
                  {positions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>回答締切</span>
                <input
                  type="datetime-local"
                  value={offDeadline}
                  onChange={(e) => setOffDeadline(e.target.value)}
                />
              </label>
            </div>

            <div className="field board-field">
              <span>招待する人（複数可）</span>
              <div className="target-checks">
                {roster.map((s) => (
                  <label key={s.staffId} className="target-check">
                    <input
                      type="checkbox"
                      checked={offStaff.includes(s.staffId)}
                      onChange={() => setOffStaff((prev) => toggle(prev, s.staffId))}
                    />
                    <span>
                      {s.name}
                      {s.kindLabel && <span className="muted-tag">{s.kindLabel}</span>}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <p className="note">
              ここでは<b>下書きに保存</b>され、あとで週ビューの「まとめて送信」から一斉送信します。
              承諾は<b>申請</b>として集まり、確定はあなたの承認（確定操作）後です。
            </p>

            <div className="mbtns">
              <button className="btn sm" onClick={onClose}>
                閉じる
              </button>
              <button
                className="btn sm pri"
                disabled={send.isPending}
                onClick={() => {
                  setOffErr(null)
                  setOffMsg(null)
                  if (
                    confirm(
                      `${firstLabel}〜 ${offDates.length}枠を下書き保存します（この時点ではメールは送られません）。よろしいですか？`,
                    )
                  ) {
                    send.mutate()
                  }
                }}
              >
                {send.isPending ? '保存中…' : '下書きに保存'}
              </button>
            </div>
          </div>
        )}

        {tab === 'add' && (
          <>
        <div className="roster-list">
          {roster.map((s) => {
            const av = availBy.get(s.staffId) ?? null
            const assigned = assignedIds.has(s.staffId)
            return (
              <button
                key={s.staffId}
                type="button"
                className="roster-row"
                disabled={assigned}
                onClick={() => onPick(s, av)}
              >
                <b>{s.name}</b>
                {s.kindLabel && <span className="muted-tag">{s.kindLabel}</span>}
                <span className={`roster-avail ra-${av?.kind ?? 'none'}`}>
                  {av === null && '未提出'}
                  {av?.kind === 'avail' && '○ 終日OK'}
                  {av?.kind === 'partial' && (
                    <>
                      △{' '}
                      <span className="mono">
                        {minToHHMM(av.start_min)}-{minToHHMM(av.end_min)}
                      </span>
                    </>
                  )}
                  {av?.kind === 'off' && '× NG'}
                </span>
                {assigned && <span className="pub-badge">配置済み</span>}
              </button>
            )
          })}
        </div>

        <div className="mbtns">
          <button className="btn sm" onClick={onClose}>
            閉じる
          </button>
        </div>
          </>
        )}
      </div>
    </div>
  )
}

function AsgEditorModal({
  storeId,
  positions,
  editing,
  onClose,
}: {
  storeId: string
  positions: { id: string; name: string }[]
  editing:
    | { mode: 'create'; date: string; staffId: string; staffName: string; avail: AvailRow | null }
    | { mode: 'edit'; asg: ShiftAsg }
  onClose: () => void
}) {
  const { me } = useMe()
  const qc = useQueryClient()
  const isEdit = editing.mode === 'edit'

  // 初期値: 編集=既存値 / 新規=△なら希望時間、○なら17-22（毎正時）
  const init = isEdit
    ? { start: minToHHMM(editing.asg.start_min), end: minToHHMM(editing.asg.end_min) }
    : editing.avail?.kind === 'partial'
      ? { start: minToHHMM(editing.avail.start_min), end: minToHHMM(editing.avail.end_min) }
      : { start: '17:00', end: '22:00' }

  const [start, setStart] = useState(init.start)
  const [end, setEnd] = useState(init.end)
  const [positionId, setPositionId] = useState(isEdit ? (editing.asg.position_id ?? '') : '')
  const [half, setHalf] = useState(isEdit ? editing.asg.weight_half : false)
  const [note, setNote] = useState(isEdit ? (editing.asg.note ?? '') : '')
  const [error, setError] = useState<string | null>(null)

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['shift_asg'] })
    onClose()
  }

  const save = useMutation({
    mutationFn: () =>
      isEdit
        ? updateAssignment(editing.asg.id, {
            startMin: hhmmToMin(start),
            endMin: hhmmToMin(end),
            positionId: positionId || null,
            weightHalf: half,
            note: note.trim() || null,
          })
        : createAssignment({
            tenantId: me!.tenantId,
            storeId,
            staffId: editing.staffId,
            workDate: editing.date,
            startMin: hhmmToMin(start),
            endMin: hhmmToMin(end),
            positionId: positionId || null,
            weightHalf: half,
            note: note.trim() || null,
          }),
    onSuccess: invalidate,
    onError: (e) => setError(asgErrText(e)),
  })

  const remove = useMutation({
    mutationFn: () => deleteAssignment((editing as { asg: ShiftAsg }).asg.id),
    onSuccess: invalidate,
    onError: (e) => setError(asgErrText(e)),
  })

  const staffName = isEdit ? editing.asg.staff_name : editing.staffName
  const date = isEdit ? editing.asg.work_date : editing.date
  const dateLabel = new Date(`${date}T00:00:00`).toLocaleDateString('ja-JP', {
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  })

  return (
    <div className="modal show" onClick={onClose} role="dialog" aria-modal="true">
      <div className="mcard mcard-wide" onClick={(e) => e.stopPropagation()}>
        <div className="mh">
          {dateLabel} · {staffName} のシフト{isEdit ? 'を編集' : 'を配置（下書き）'}
        </div>

        {error && (
          <p className="login-error" role="alert">
            {error}
          </p>
        )}

        <div className="asg-grid">
          <label className="field">
            <span>開始</span>
            <input type="time" step={3600} value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label className="field">
            <span>終了</span>
            <input type="time" step={3600} value={end} onChange={(e) => setEnd(e.target.value)} />
          </label>
        </div>

        {(() => {
          // △（時間指定）希望の範囲外に配置しようとしたら軽い注意（保存は妨げない）
          const av = editing.mode === 'create' ? editing.avail : null
          if (!av || av.kind !== 'partial') return null
          const availStart = av.start_min
          const availEnd = av.end_min
          if (availStart === null || availEnd === null) return null
          const startMin = hhmmToMin(start)
          const endMin = hhmmToMin(end)
          if (startMin === null || endMin === null) return null
          if (startMin >= availStart && endMin <= availEnd) return null
          return (
            <p className="note asg-avail-warn">
              希望時間（{minToHHMM(availStart)}-{minToHHMM(availEnd)}）の
              外に配置しようとしています。本人に確認してください。
            </p>
          )
        })()}

        <div className="asg-grid">
          <label className="field">
            <span>ポジション</span>
            <select value={positionId} onChange={(e) => setPositionId(e.target.value)}>
              <option value="">未設定</option>
              {positions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <div className="field">
            <span>換算</span>
            <label className="tgl asg-half">
              <span className={`cbx2${half ? ' on' : ''}`} onClick={() => setHalf((v) => !v)} />
              0.5換算（新人・補助）
            </label>
          </div>
        </div>

        <label className="field">
          <span>メモ（任意）</span>
          <input className="ri" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>

        <div className="mbtns">
          {isEdit && (
            <button className="btn sm danger" disabled={remove.isPending} onClick={() => remove.mutate()}>
              配置を削除
            </button>
          )}
          <button className="btn sm" onClick={onClose}>
            閉じる
          </button>
          <button
            className="btn sm pri"
            disabled={save.isPending}
            onClick={() => {
              setError(null)
              save.mutate()
            }}
          >
            {save.isPending ? '保存中…' : isEdit ? '保存' : '下書きに配置'}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------ マイシフト（本人） ------------------------------ */

function MyShiftView() {
  const { me } = useMe()
  const staffId = me?.staffId

  const today = ymd(new Date())
  const until = useMemo(() => {
    const d = new Date()
    return ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 30))
  }, [])

  const q = useQuery({
    queryKey: ['my_shifts', staffId, today],
    enabled: !!staffId,
    queryFn: () => fetchMyShifts(staffId!, today, until),
  })

  if (!staffId) {
    return <p className="note">スタッフ情報が紐付いていないため、マイシフトはありません。</p>
  }

  const todays = (q.data ?? []).filter((s) => s.work_date === today)
  const upcoming = (q.data ?? []).filter((s) => s.work_date !== today)

  const dateLabel = (d: string) =>
    new Date(`${d}T00:00:00`).toLocaleDateString('ja-JP', {
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
    })

  return (
    <>
      <div className="card myshift-today">
        <div className="k">今日のシフト（{dateLabel(today)}）</div>
        {q.isPending && <p className="note">読み込み中…</p>}
        {!q.isPending && todays.length === 0 && (
          <p className="note">今日の公開シフトはありません。</p>
        )}
        {todays.map((s) => (
          <div key={s.id} className="today-shift">
            <span className="mono today-shift-time">
              {minToHHMM(s.start_min)} 〜 {minToHHMM(s.end_min)}
            </span>
            <span className="today-shift-meta">
              {s.store_name}
              {s.position_name && <span className="asg-pos">{s.position_name}</span>}
            </span>
            {s.note && <span className="note">{s.note}</span>}
          </div>
        ))}
      </div>

      <div className="sec-h">
        <h3>今後のシフト（30日以内・公開分のみ）</h3>
        <span className="rule" />
        <span className="cnt mono">{upcoming.length}</span>
      </div>

      {q.error && (
        <p className="login-error" role="alert">
          {errText(q.error, 'シフトを取得できませんでした')}
        </p>
      )}

      {!q.isPending && upcoming.length === 0 && (
        <p className="note">
          公開されたシフトはまだありません。公開されるとここに表示されます。
        </p>
      )}

      {upcoming.length > 0 && (
        <ul className="myshift-list">
          {upcoming.map((s) => (
            <li key={s.id} className="myshift-item">
              <span className="mono small myshift-date">{dateLabel(s.work_date)}</span>
              <span className="mono myshift-time">
                {minToHHMM(s.start_min)}-{minToHHMM(s.end_min)}
              </span>
              <span className="note">{s.store_name}</span>
              {s.position_name && <span className="asg-pos">{s.position_name}</span>}
              {s.note && <span className="note">{s.note}</span>}
            </li>
          ))}
        </ul>
      )}

      <p className="note">
        シフトの変更が必要なときは店舗の管理者に相談してください（マイシフトからは変更できません）。
      </p>
    </>
  )
}
