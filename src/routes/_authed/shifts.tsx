import { useEffect, useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { errText } from '@/lib/errors'
import { useMe } from '@/lib/me-context'
import { usePermissions } from '@/lib/perm'
import { fetchStaffList } from '@/lib/queries/master'
import {
  availErrText,
  deleteAvailability,
  fetchHolidays,
  fetchMyAvailability,
  fetchMyStores,
  fetchStoreAvailability,
  hhmmToMin,
  minToHHMM,
  upsertAvailability,
  type AvailKind,
  type AvailRow,
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
  const [tab, setTab] = useState<'matrix' | 'mine'>('mine')

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
      <div className="eyebrow">シフト · 段階1（希望収集）</div>
      <div className="page-h">
        <h1>シフト希望</h1>
        <span className="desc">
          {canEdit ? '希望の収集と代理入力。シフト表の作成は次の段階です。' : '○△×で希望を出します。'}
        </span>
      </div>

      {canEdit && hasSelf && (
        <div className="tab-row">
          <button className={`tab${tab === 'matrix' ? ' on' : ''}`} onClick={() => setTab('matrix')}>
            希望一覧（全員）
          </button>
          <button className={`tab${tab === 'mine' ? ' on' : ''}`} onClick={() => setTab('mine')}>
            自分の希望
          </button>
        </div>
      )}

      {tab === 'matrix' && canEdit ? <MatrixView /> : hasSelf ? <MyAvailabilityView /> : <MatrixView />}
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
              onClick={() => setKind(k)}
            >
              {label}
            </button>
          ))}
        </div>

        {kind === 'partial' && (
          <div className="asg-grid">
            <label className="field">
              <span>開始</span>
              <input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
            </label>
            <label className="field">
              <span>終了</span>
              <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
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
