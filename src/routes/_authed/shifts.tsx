import { useEffect, useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { errText } from '@/lib/errors'
import { useMe } from '@/lib/me-context'
import { usePermissions } from '@/lib/perm'
import {
  cancelOffer,
  confirmOfferRecipient,
  createDraftOffers,
  fetchMyOffers,
  fetchOfferRecipients,
  fetchOffers,
  fetchUnseenDeclines,
  markDeclinesSeen,
  previewDraftOffers,
  sendDraftOffers,
  type MyOfferRow,
  type OfferRecipientRow,
  type OfferRow,
} from '@/lib/queries/offers'
import {
  closedDowsOf,
  fetchEmploymentKinds,
  fetchPositions,
  fetchStaffList,
  fetchStoreSkills,
  fetchTimeBands,
  type Position,
  type TimeBand,
} from '@/lib/queries/master'
import {
  addStaffDayOff,
  asgErrText,
  availErrText,
  createAssignment,
  DAY_TYPES,
  deleteAssignment,
  deleteAvailability,
  deleteRequirementOverride,
  fetchRequirementOverrides,
  fetchStaffDayOffs,
  removeStaffDayOff,
  fetchAssignments,
  fetchHolidays,
  fetchMyAvailability,
  fetchMyShifts,
  fetchMyStores,
  fetchRequirements,
  fetchStoreAvailability,
  fetchStoreRoster,
  gateAutoShift,
  getShiftNotifyPreview,
  hhmmToMin,
  minToHHMM,
  normalizeNeedByPosition,
  publishWeek,
  reqErrText,
  sendShiftNotifications,
  updateAssignment,
  upsertAvailability,
  upsertRequirement,
  upsertRequirementOverride,
  type AvailKind,
  type AvailRow,
  type DayType,
  type RequirementOverrideRow,
  type RequirementRow,
  type RosterEntry,
  type ShiftAsg,
  type StaffDayOffRow,
} from '@/lib/queries/shifts'
import { ymd } from '@/lib/worktime'
import {
  buildAutoShift,
  createEligibility,
  type AutoAssignment,
  type AutoNeed,
  type BuildAutoShiftInput,
} from '@/lib/auto-shift'

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
  const [tab, setTab] = useState<
    'grid' | 'matrix' | 'build' | 'req' | 'dayoff' | 'mine' | 'myshift'
  >('mine')

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
          <button className={`tab${tab === 'grid' ? ' on' : ''}`} onClick={() => setTab('grid')}>
            一覧
          </button>
          <button className={`tab${tab === 'matrix' ? ' on' : ''}`} onClick={() => setTab('matrix')}>
            希望一覧（全員）
          </button>
          <button className={`tab${tab === 'build' ? ' on' : ''}`} onClick={() => setTab('build')}>
            シフト作成
          </button>
          <button className={`tab${tab === 'req' ? ' on' : ''}`} onClick={() => setTab('req')}>
            必要人数
          </button>
          <button
            className={`tab${tab === 'dayoff' ? ' on' : ''}`}
            onClick={() => setTab('dayoff')}
          >
            公休
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
            <button className={`tab${tab === 'grid' ? ' on' : ''}`} onClick={() => setTab('grid')}>
              一覧
            </button>
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

      {tab === 'grid' ? (
        <WeekGridView />
      ) : tab === 'myshift' && hasSelf ? (
        <MyShiftView />
      ) : tab === 'build' && canEdit ? (
        <BuildView onGoDayoff={() => setTab('dayoff')} />
      ) : tab === 'req' && canEdit ? (
        <RequirementsView />
      ) : tab === 'dayoff' && canEdit ? (
        <StaffDayOffView />
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

/* -------------------------- 統合シフトグリッド（一覧・閲覧専用） -------------------------- */

/** 分→コンパクト時刻（毎正時は「17」、それ以外は「17:30」） */
const compactTime = (m: number): string => (m % 60 === 0 ? String(m / 60) : minToHHMM(m))

function WeekGridView() {
  const { me } = useMe()
  const perms = usePermissions()
  const canEdit = perms.has('shift_edit')
  const [storeId, setStoreId] = useState('')
  const [weekBase, setWeekBase] = useState(() => new Date())
  const [editing, setEditing] = useState<{ mode: 'edit'; asg: ShiftAsg } | null>(null)
  const week = useMemo(() => weekMeta(weekBase), [weekBase])

  useEffect(() => {
    if (!storeId && me?.stores.length) setStoreId(me.stores[0].id)
  }, [me?.stores, storeId])

  // 4クエリ＋祝日（すべて週範囲・追加DBなし）
  const rosterQ = useQuery({
    queryKey: ['store_roster', storeId],
    enabled: !!storeId,
    queryFn: () => fetchStoreRoster(storeId),
  })
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
  const dayoffQ = useQuery({
    queryKey: ['staff_dayoff', storeId, week.from],
    enabled: !!storeId,
    queryFn: () => fetchStaffDayOffs(storeId, week.from, week.to),
  })
  const holidaysQ = useQuery({
    queryKey: ['holidays', week.from, 'wk'],
    queryFn: () => fetchHolidays(week.from, week.to),
  })
  const posQ = useQuery({ queryKey: ['master', 'positions'], queryFn: fetchPositions })

  // 辞書化（key = `${staff_id}|${date}`）
  const asgBy = useMemo(() => {
    const m = new Map<string, ShiftAsg[]>()
    for (const a of asgQ.data ?? []) {
      const k = `${a.staff_id}|${a.work_date}`
      const list = m.get(k) ?? []
      list.push(a)
      m.set(k, list)
    }
    return m
  }, [asgQ.data])
  const availBy = useMemo(() => {
    const m = new Map<string, AvailRow>()
    for (const r of availQ.data ?? []) m.set(`${r.staff_id}|${r.work_date}`, r)
    return m
  }, [availQ.data])
  const offBy = useMemo(() => {
    const m = new Map<string, StaffDayOffRow>()
    for (const o of dayoffQ.data ?? []) m.set(`${o.staff_id}|${o.work_date}`, o)
    return m
  }, [dayoffQ.data])

  if (!me) return null

  const store = me.stores.find((s) => s.id === storeId)
  const closedDows = store ? closedDowsOf(store) : []
  const roster = rosterQ.data ?? []
  const positions = posQ.data ?? []
  const posInitial = (id: string | null) =>
    id ? (positions.find((p) => p.id === id)?.name.slice(0, 1) ?? '') : ''

  // 区分色ドット: 社員=青 / パート=桃 / その他（アルバイト等）=グレー
  const dotCls = (r: RosterEntry) =>
    r.isRegular ? 'wg-dot-reg' : (r.kindLabel ?? '').includes('パート') ? 'wg-dot-part' : 'wg-dot-arb'

  // 週合計（配置の実働時間・h）
  const weekHours = (staffId: string): number => {
    let min = 0
    for (const d of week.days) {
      for (const a of asgBy.get(`${staffId}|${d.date}`) ?? []) min += a.end_min - a.start_min
    }
    return Math.round((min / 60) * 10) / 10
  }

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

      <div className="wg-legend">
        <span><i className="wg-lg wg-lg-asg" />勤務</span>
        <span><i className="wg-lg wg-lg-off" />公休</span>
        <span><i className="wg-lg wg-lg-hopeoff" />希望休(×)</span>
        <span><i className="wg-lg wg-lg-closed" />定休</span>
        <span><i className="wg-lg wg-lg-empty" />未入力</span>
      </div>

      {(rosterQ.error || asgQ.error) && (
        <p className="login-error" role="alert">
          {errText(rosterQ.error ?? asgQ.error, 'シフト一覧を取得できませんでした')}
        </p>
      )}
      {rosterQ.isPending && !!storeId && <p className="note">読み込み中…</p>}
      {!rosterQ.isPending && roster.length === 0 && (
        <p className="note">この店舗に表示できるスタッフがいません。</p>
      )}

      {roster.length > 0 && (
        <div className="card table-wrap wg-wrap">
          <table className="weekgrid-table">
            <thead>
              <tr>
                <th className="wg-name">スタッフ</th>
                {week.days.map((d) => {
                  const holiday = holidaysQ.data?.get(d.date)
                  const closed = closedDows.includes(d.dow)
                  const cls = holiday || d.dow === 0 ? ' sun' : d.dow === 6 || d.dow === 5 ? ' sat' : ''
                  return (
                    <th key={d.date} className={`wg-day mono${cls}`} title={holiday ?? undefined}>
                      {DOW_LABELS[d.dow]}
                      {d.dayNum}
                      {closed && <span className="wg-closed-badge">定休</span>}
                    </th>
                  )
                })}
                <th className="wg-total">週計</th>
              </tr>
            </thead>
            <tbody>
              {roster.map((r) => (
                <tr key={r.staffId}>
                  <td className="wg-name">
                    <i className={`wg-dot ${dotCls(r)}`} />
                    <b>{r.name}</b>
                  </td>
                  {week.days.map((d) => {
                    const k = `${r.staffId}|${d.date}`
                    // 優先度: 定休 > 公休 > 配置 > 希望 > 空
                    if (closedDows.includes(d.dow)) {
                      return (
                        <td key={d.date} className="wg-cell wg-cell-closed">
                          <span className="wg-closed">定休</span>
                        </td>
                      )
                    }
                    const off = offBy.get(k)
                    if (off) {
                      return (
                        <td key={d.date} className="wg-cell">
                          <span className="wg-off">休</span>
                        </td>
                      )
                    }
                    const asgs = asgBy.get(k)
                    if (asgs && asgs.length > 0) {
                      return (
                        <td key={d.date} className="wg-cell">
                          {asgs.map((a) => (
                            <button
                              key={a.id}
                              type="button"
                              className={`wg-asg${a.status === 'draft' ? ' is-draft' : ''}${canEdit ? '' : ' ro'}`}
                              title={`${minToHHMM(a.start_min)}〜${minToHHMM(a.end_min)}${a.note ? ` ${a.note}` : ''}`}
                              onClick={() => {
                                if (canEdit) setEditing({ mode: 'edit', asg: a })
                              }}
                            >
                              {compactTime(a.start_min)}-{compactTime(a.end_min)}
                              {posInitial(a.position_id) && (
                                <span className="wg-pos">{posInitial(a.position_id)}</span>
                              )}
                            </button>
                          ))}
                        </td>
                      )
                    }
                    const av = availBy.get(k)
                    if (av) {
                      return (
                        <td key={d.date} className="wg-cell">
                          {av.kind === 'off' ? (
                            <span className="wg-hopeoff">×</span>
                          ) : (
                            <span
                              className="wg-hope"
                              title={
                                av.kind === 'partial'
                                  ? `${minToHHMM(av.start_min)}〜${minToHHMM(av.end_min)}`
                                  : '終日OK'
                              }
                            >
                              {KIND_MARK[av.kind]}
                            </span>
                          )}
                        </td>
                      )
                    }
                    return (
                      <td key={d.date} className="wg-cell">
                        <span className="wg-empty">·</span>
                      </td>
                    )
                  })}
                  <td className="wg-total mono">{weekHours(r.staffId)}h</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="note">
        一覧は俯瞰用です。配置の作成は「シフト作成」、公休の設定は「公休」タブから行います。
      </p>

      {editing && storeId && (
        <AsgEditorModal
          storeId={storeId}
          positions={positions
            .filter((p) => (p.store_id === null || p.store_id === storeId) && p.is_active)
            .sort((a, b) => a.sort_order - b.sort_order)}
          editing={editing}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  )
}

/* -------------------------- 管理者: 社員の公休 -------------------------- */

function StaffDayOffView() {
  const { me } = useMe()
  const qc = useQueryClient()
  const [storeId, setStoreId] = useState('')
  const [month, setMonth] = useState(() => {
    const n = new Date()
    return new Date(n.getFullYear(), n.getMonth(), 1)
  })
  const [error, setError] = useState<string | null>(null)
  const meta = useMemo(() => monthMeta(month), [month])

  useEffect(() => {
    if (!storeId && me?.stores.length) setStoreId(me.stores[0].id)
  }, [me?.stores, storeId])

  // 0023: is_regular つきロースター（definer・賃金権限に依存しない）
  const rosterQ = useQuery({
    queryKey: ['store_roster', storeId],
    enabled: !!storeId,
    queryFn: () => fetchStoreRoster(storeId),
  })
  const dayoffQ = useQuery({
    queryKey: ['staff_dayoff', storeId, meta.from],
    enabled: !!storeId,
    queryFn: () => fetchStaffDayOffs(storeId, meta.from, meta.to),
  })
  const holidaysQ = useQuery({
    queryKey: ['holidays', meta.from],
    queryFn: () => fetchHolidays(meta.from, meta.to),
  })

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['staff_dayoff'] })
  const addMut = useMutation({
    mutationFn: addStaffDayOff,
    onSuccess: invalidate,
    onError: (e) =>
      setError(
        errText(e, '公休を保存できませんでした（シフト編集権限と自店であることが必要です）'),
      ),
  })
  const delMut = useMutation({
    mutationFn: removeStaffDayOff,
    onSuccess: invalidate,
    onError: (e) => setError(errText(e, '公休を取り消せませんでした')),
  })

  if (!me) return null

  const store = me.stores.find((s) => s.id === storeId)
  const closedDows = store ? closedDowsOf(store) : []
  const regulars = (rosterQ.data ?? []).filter((r) => r.isRegular)
  const holidays = holidaysQ.data ?? new Map<string, string>()

  const offsByStaff = new Map<string, Map<string, StaffDayOffRow>>()
  for (const o of dayoffQ.data ?? []) {
    const m = offsByStaff.get(o.staff_id) ?? new Map<string, StaffDayOffRow>()
    m.set(o.work_date, o)
    offsByStaff.set(o.staff_id, m)
  }
  const dowOf = (date: string) => new Date(`${date}T00:00:00`).getDay()

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

      <p className="note">
        社員（社員区分）の公休を日付タップで設定します。定休日は店全体の休みとして自動表示され、
        個別の公休には数えません。
      </p>

      {error && (
        <p className="login-error" role="alert">
          {error}
        </p>
      )}
      {rosterQ.isPending && !!storeId && <p className="note">読み込み中…</p>}
      {rosterQ.error && (
        <p className="login-error" role="alert">
          {errText(rosterQ.error, '社員の取得に失敗しました')}
        </p>
      )}

      {!rosterQ.isPending && regulars.length === 0 && (
        <p className="note">
          この店舗に社員がいません。設定は不要です（アルバイト・パートのみ）。
        </p>
      )}

      {regulars.map((r) => {
        const offs = offsByStaff.get(r.staffId) ?? new Map<string, StaffDayOffRow>()
        const count = [...offs.keys()].filter((d) => !closedDows.includes(dowOf(d))).length
        return (
          <div key={r.staffId} className="dayoff-block">
            <div className="dayoff-head">
              <b>{r.name}</b>
              {r.kindLabel && <span className="muted-tag">{r.kindLabel}</span>}
              {count === 0 ? (
                <span className="badge dayoff-unset">未設定</span>
              ) : (
                <span className="mono dayoff-count">公休 {count}日</span>
              )}
            </div>
            <Calendar
              meta={meta}
              holidays={holidays}
              cellOf={(date) => {
                if (closedDows.includes(dowOf(date))) {
                  return <span className="cal-closed">定休</span>
                }
                return offs.has(date) ? <span className="dayoff-mark">休</span> : null
              }}
              onTap={(date) => {
                if (closedDows.includes(dowOf(date))) return // 定休日は個別公休の対象外
                setError(null)
                const off = offs.get(date)
                if (off) {
                  delMut.mutate(off.id)
                } else {
                  addMut.mutate({
                    tenantId: me.tenantId,
                    staffId: r.staffId,
                    storeId,
                    workDate: date,
                  })
                }
              }}
            />
          </div>
        )
      })}
    </>
  )
}

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
  // 例外日カレンダー（0026）の表示月とエディタ対象日
  const [ovrMonth, setOvrMonth] = useState(() => new Date())
  const [ovrEditing, setOvrEditing] = useState<string | null>(null)
  const mm = useMemo(() => monthMeta(ovrMonth), [ovrMonth])

  useEffect(() => {
    if (!storeId && me?.stores.length) setStoreId(me.stores[0].id)
  }, [me?.stores, storeId])

  const reqQ = useQuery({
    queryKey: ['shift_req', storeId],
    enabled: !!storeId,
    queryFn: () => fetchRequirements(storeId),
  })
  // 日付上書き（0026・表示月ぶん）。キー接頭辞は BuildView と揃えて一括 invalidate
  const ovrQ = useQuery({
    queryKey: ['shift_req_ovr', storeId, 'm', mm.from],
    enabled: !!storeId,
    queryFn: () => fetchRequirementOverrides(storeId, mm.from, mm.to),
  })
  const holidaysQ = useQuery({
    queryKey: ['holidays', mm.from],
    queryFn: () => fetchHolidays(mm.from, mm.to),
  })

  const kindsQ = useQuery({ queryKey: ['master', 'kinds'], queryFn: fetchEmploymentKinds })
  const posQ = useQuery({ queryKey: ['master', 'positions'], queryFn: fetchPositions })
  // この店の営業時間帯（0019・is_active のみ・sort_order 順）。0件なら「通し」タブのみ＝現行同一
  const bandsQ = useQuery({
    queryKey: ['master', 'timebands', storeId],
    enabled: !!storeId,
    queryFn: () => fetchTimeBands(storeId),
  })

  if (!me) return null

  // 打刻対象の区分のみ（業務委託などはシフト最低人数の対象外にしない方が自然だが、
  // まずは requires_clock=true の主要区分を出す）
  const kindLabels = (kindsQ.data ?? []).filter((k) => k.requires_clock).map((k) => k.label)

  // B案の主軸: この店舗の有効ポジション（全店共通 + 店舗専用・sort_order昇順）。0024で id キー運用
  const allPositions = posQ.data ?? []
  const storePositions = allPositions
    .filter((p) => (p.store_id === null || p.store_id === storeId) && p.is_active)
    .sort((a, b) => a.sort_order - b.sort_order)
  const posNameOf = (id: string) => allPositions.find((p) => p.id === id)?.name ?? '(不明)'

  // 後方互換シム: 旧・名前キーの need_by_position を id キーに正規化してから使う
  const normalizedRows = (reqQ.data ?? []).map((r) => ({
    ...r,
    need_by_position: normalizeNeedByPosition(r.need_by_position, allPositions, storeId),
  }))
  const ovrRows = (ovrQ.data ?? []).map((r) => ({
    ...r,
    need_by_position: normalizeNeedByPosition(r.need_by_position, allPositions, storeId),
  }))
  const ovrDates = new Set(ovrRows.map((r) => r.work_date))
  const store = me.stores.find((s) => s.id === storeId)
  const closedDows = store ? closedDowsOf(store) : []
  const holidays = holidaysQ.data ?? new Map<string, string>()

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

      <p className="note">
        時間帯の定義は「スタッフ」ページの<b>営業時間帯</b>で設定できます。
      </p>

      {reqQ.error && (
        <p className="login-error" role="alert">
          {reqErrText(reqQ.error)}
        </p>
      )}
      {reqQ.isPending && !!storeId && <p className="note">読み込み中…</p>}

      {storePositions.length === 0 && !posQ.isPending && (
        <p className="perm-banner" role="status">
          ポジションが未登録です。スタッフ・店舗ページでポジション（キッチン/フロア等）を
          登録すると、ポジション別に必要人数を組めます。それまでは全体人数のみの入力になります。
        </p>
      )}

      {reqQ.data &&
        DAY_TYPES.map((dt) => (
          <RequirementDayCard
            key={`${storeId}|${dt.key}`}
            storeId={storeId}
            dayType={dt.key}
            dayLabel={dt.label}
            badgeCls={dt.badgeCls}
            kindLabels={kindLabels}
            positions={storePositions}
            posNameOf={posNameOf}
            bands={bandsQ.data ?? []}
            rows={normalizedRows}
          />
        ))}

      <p className="note">
        <b>ポジション別</b>が主軸です（キッチン2・フロア2 → 合計は自動計算して保存）。
        <b>区分別最低</b>＝「社員≥1」のような補助の下限（合計が必要人数を超えると警告が
        出ますが保存はできます）。曜日区分ごとに保存してください。シフト表の作成
        （段階2-b）でこのテンプレートと希望を突き合わせます。
      </p>

      {/* ---------------- 例外日（0026 日付上書き）カレンダー ---------------- */}
      <div className="page-h ovr-head">
        <h2 className="ovr-title">例外日（この日だけ変更）</h2>
        <MonthNav month={ovrMonth} label={mm.label} onChange={setOvrMonth} />
      </div>
      <Calendar
        meta={mm}
        holidays={holidays}
        cellOf={(date) => {
          const dow = new Date(`${date}T00:00:00`).getDay()
          if (closedDows.includes(dow)) return <span className="cal-closed">定休</span>
          if (ovrDates.has(date)) return <span className="ovr-mark">✎</span>
          return null
        }}
        onTap={(date) => {
          const dow = new Date(`${date}T00:00:00`).getDay()
          if (closedDows.includes(dow)) return // 定休日は上書き対象外（従来どおりグレー扱い）
          setOvrEditing(date)
        }}
      />
      <p className="note">
        日付をタップすると、その日だけの必要人数を上書きできます（✎＝上書きあり）。
        上書きが無い日は曜日区分テンプレの値が使われます。定休日はグレーのまま対象外です。
      </p>

      {ovrEditing && storeId && (
        <OverrideEditorModal
          tenantId={me.tenantId}
          storeId={storeId}
          date={ovrEditing}
          holidayName={holidays.get(ovrEditing) ?? null}
          bands={bandsQ.data ?? []}
          positions={storePositions}
          posNameOf={posNameOf}
          tplRows={normalizedRows}
          ovrRows={ovrRows}
          onClose={() => setOvrEditing(null)}
        />
      )}
    </>
  )
}

/* ---------------- 例外日エディタ（0026・カレンダー日タップで開く） ---------------- */

/** 2層解決（確定順）で初期値を出し、保存＝override upsert / テンプレに戻す＝override delete */
function OverrideEditorModal({
  tenantId,
  storeId,
  date,
  holidayName,
  bands,
  positions,
  posNameOf,
  tplRows,
  ovrRows,
  onClose,
}: {
  tenantId: string
  storeId: string
  date: string
  holidayName: string | null
  bands: TimeBand[]
  positions: Position[]
  posNameOf: (id: string) => string
  tplRows: RequirementRow[]
  ovrRows: RequirementOverrideRow[]
  onClose: () => void
}) {
  const [bandId, setBandId] = useState<string | null>(null)

  const dow = new Date(`${date}T00:00:00`).getDay()
  const dt = dayTypeOf(dow, !!holidayName)
  const dateLabel = new Date(`${date}T00:00:00`).toLocaleDateString('ja-JP', {
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  })

  // 確定解決順: ovr[date,band] → ovr[date,通し] → tpl[day_type,band] → tpl[day_type,通し]
  const ovrAt = (bid: string | null) =>
    ovrRows.find((r) => r.work_date === date && r.time_band_id === bid) ?? null
  const tplAt = (bid: string | null) =>
    tplRows.find((r) => r.day_type === dt && r.time_band_id === bid) ?? null
  const resolveInit = (bid: string | null) =>
    (bid ? ovrAt(bid) : null) ?? ovrAt(null) ?? (bid ? tplAt(bid) : null) ?? tplAt(null)

  const tabs: { id: string | null; name: string }[] = [
    { id: null, name: '通し' },
    ...bands.map((b) => ({ id: b.id, name: b.name })),
  ]

  return (
    <div className="modal show" onClick={onClose} role="dialog" aria-modal="true">
      <div className="mcard mcard-wide" onClick={(e) => e.stopPropagation()}>
        <div className="mh">
          {dateLabel} · この日だけ変更
          {holidayName && <span className="cal-holiday"> {holidayName}</span>}
        </div>

        {tabs.length > 1 && (
          <div className="req-band-tabs">
            {tabs.map((t) => (
              <button
                key={t.id ?? 'all'}
                type="button"
                className={`req-band-tab${bandId === t.id ? ' on' : ''}`}
                onClick={() => setBandId(t.id)}
              >
                {t.name}
                {ovrAt(t.id) && <span className="ovr-mark">✎</span>}
              </button>
            ))}
          </div>
        )}

        <OverrideRowEditor
          key={`${date}|${bandId ?? 'all'}`}
          tenantId={tenantId}
          storeId={storeId}
          date={date}
          bandId={bandId}
          positions={positions}
          posNameOf={posNameOf}
          existing={ovrAt(bandId)}
          init={resolveInit(bandId)}
          onClose={onClose}
        />
      </div>
    </div>
  )
}

function OverrideRowEditor({
  tenantId,
  storeId,
  date,
  bandId,
  positions,
  posNameOf,
  existing,
  init,
  onClose,
}: {
  tenantId: string
  storeId: string
  date: string
  bandId: string | null
  positions: Position[]
  posNameOf: (id: string) => string
  /** この (date, band) にピンポイントで存在する上書き行（テンプレに戻す判定） */
  existing: RequirementOverrideRow | null
  /** 2層解決の初期値（テンプレ値のコピー・行単位置換の前提） */
  init: { need_count: number; need_by_position: Record<string, number>; min_by_kind: Record<string, number>; memo: string | null } | null
  onClose: () => void
}) {
  const qc = useQueryClient()
  const hasPositions = positions.length > 0
  const [needByPos, setNeedByPos] = useState<Record<string, number>>(init?.need_by_position ?? {})
  const [manualNeed, setManualNeed] = useState(init?.need_count ?? 0)
  const [memo, setMemo] = useState(existing?.memo ?? '')
  const [error, setError] = useState<string | null>(null)

  const posSum = Object.values(needByPos).reduce((s, v) => s + (v > 0 ? v : 0), 0)
  const need = hasPositions ? posSum : manualNeed

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['shift_req_ovr'] })
  }

  const save = useMutation({
    mutationFn: () =>
      upsertRequirementOverride({
        tenantId,
        storeId,
        workDate: date,
        timeBandId: bandId,
        needCount: need,
        needByPosition: hasPositions ? needByPos : {},
        // 区分別最低は今回エディタを出さず、解決値をそのまま引き継ぐ（行単位置換で消さない）
        minByKind: init?.min_by_kind ?? {},
        memo: memo.trim() || null,
      }),
    onSuccess: () => {
      invalidate()
      onClose()
    },
    onError: (e) => setError(reqErrText(e)),
  })

  const reset = useMutation({
    mutationFn: () => deleteRequirementOverride({ storeId, workDate: date, timeBandId: bandId }),
    onSuccess: () => {
      invalidate()
      onClose()
    },
    onError: (e) => setError(reqErrText(e)),
  })

  const posSummary = Object.entries(needByPos)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${posNameOf(k)}${v}`)
    .join('・')

  return (
    <>
      <p className="note ovr-src">
        {existing
          ? 'この枠は上書き済みです（保存で更新・「テンプレに戻す」で削除）。'
          : 'テンプレの値を初期値にしています。保存するとこの日だけ上書きされます。'}
      </p>

      <div className="req-need ovr-need">
        <span className="req-lab">必要人数{hasPositions ? '（自動集計）' : ''}</span>
        {hasPositions ? (
          <b className="mono req-total">{need}</b>
        ) : (
          <Stepper value={manualNeed} onChange={setManualNeed} label="この日の必要人数" />
        )}
      </div>

      {hasPositions && (
        <div className="condrow pos-row">
          <span className="req-lab">ポジション別</span>
          {positions.map((p) => (
            <span key={p.id} className="mm pp">
              {p.color && <span className="pos-dot" style={{ background: p.color }} />}
              {p.name}
              <Stepper
                value={needByPos[p.id] ?? 0}
                onChange={(v) => setNeedByPos({ ...needByPos, [p.id]: v })}
                label={`${p.name}の必要人数`}
              />
            </span>
          ))}
        </div>
      )}

      <input
        className="ri req-memo"
        value={memo}
        placeholder="メモ（任意）例）貸切宴会・イベント"
        onChange={(e) => setMemo(e.target.value)}
      />

      <div className="condsum note">→ {posSummary || '条件なし'}</div>

      {error && (
        <p className="login-error" role="alert">
          {error}
        </p>
      )}

      <div className="mbtns">
        {existing && (
          <button
            className="btn sm danger"
            disabled={reset.isPending || save.isPending}
            onClick={() => {
              setError(null)
              if (confirm('この枠の上書きを削除してテンプレの値に戻します。よろしいですか？')) {
                reset.mutate()
              }
            }}
          >
            テンプレに戻す
          </button>
        )}
        <button className="btn sm" onClick={onClose}>
          閉じる
        </button>
        <button
          className="btn sm pri"
          disabled={save.isPending || reset.isPending}
          onClick={() => {
            setError(null)
            save.mutate()
          }}
        >
          {save.isPending ? '保存中…' : 'この日だけ保存'}
        </button>
      </div>
    </>
  )
}

/** day_type 1枚のカード。カード内に時間帯タブ（「通し」＋帯）を持ち、選択に応じて RowEditor を切替 */
function RequirementDayCard({
  storeId,
  dayType,
  dayLabel,
  badgeCls,
  kindLabels,
  positions,
  posNameOf,
  bands,
  rows,
}: {
  storeId: string
  dayType: DayType
  dayLabel: string
  badgeCls: string
  kindLabels: string[]
  positions: Position[]
  posNameOf: (id: string) => string
  bands: TimeBand[]
  rows: RequirementRow[]
}) {
  const [bandId, setBandId] = useState<string | null>(null)

  const tabs: { id: string | null; name: string }[] = [
    { id: null, name: '通し' },
    ...bands.map((b) => ({ id: b.id, name: b.name })),
  ]
  const hasRow = (bid: string | null) =>
    rows.some((r) => r.day_type === dayType && r.time_band_id === bid)
  const initial = rows.find((r) => r.day_type === dayType && r.time_band_id === bandId) ?? null

  // 帯未定義の店は「通し」のみ＝タブUIを出さず現行と同一の見た目（後方互換）
  const bandTabs =
    tabs.length > 1 ? (
      <div className="req-band-tabs">
        {tabs.map((t) => (
          <button
            key={t.id ?? 'all'}
            type="button"
            className={`req-band-tab${bandId === t.id ? ' on' : ''}`}
            onClick={() => setBandId(t.id)}
          >
            {t.name}
            {!hasRow(t.id) && <span className="req-band-unset">未設定</span>}
          </button>
        ))}
      </div>
    ) : null

  return (
    <RequirementRowEditor
      key={`${storeId}|${dayType}|${bandId ?? 'all'}`}
      storeId={storeId}
      dayType={dayType}
      timeBandId={bandId}
      dayLabel={dayLabel}
      badgeCls={badgeCls}
      kindLabels={kindLabels}
      positions={positions}
      posNameOf={posNameOf}
      initial={initial}
      bandTabs={bandTabs}
    />
  )
}

function RequirementRowEditor({
  storeId,
  dayType,
  timeBandId,
  dayLabel,
  badgeCls,
  kindLabels,
  positions,
  posNameOf,
  initial,
  bandTabs,
}: {
  storeId: string
  dayType: DayType
  timeBandId: string | null
  dayLabel: string
  badgeCls: string
  kindLabels: string[]
  positions: Position[]
  posNameOf: (id: string) => string
  initial: RequirementRow | null
  bandTabs?: React.ReactNode
}) {
  const { me } = useMe()
  const qc = useQueryClient()
  const hasPositions = positions.length > 0
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
        timeBandId,
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
    .map(([k, v]) => `${posNameOf(k)}${v}`)
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
        {bandTabs}
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
          {positions.map((p) => (
            <span key={p.id} className="mm pp">
              {p.color && <span className="pos-dot" style={{ background: p.color }} />}
              {p.name}
              <Stepper
                value={needByPos[p.id] ?? 0}
                onChange={(v) => setNeedByPos({ ...needByPos, [p.id]: v })}
                label={`${p.name}の必要人数`}
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

function BuildView({ onGoDayoff }: { onGoDayoff?: () => void }) {
  const { me } = useMe()
  const qc = useQueryClient()
  const [storeId, setStoreId] = useState('')
  const [weekBase, setWeekBase] = useState(() => new Date())
  const [pubMsg, setPubMsg] = useState<string | null>(null)
  const [pubErr, setPubErr] = useState<string | null>(null)
  const [autoMsg, setAutoMsg] = useState<string | null>(null)
  // C-1b: 自動シフト草案（未保存プレビュー）。入力スナップショット＋草案配列。DBには一切書かない
  const [plan, setPlan] = useState<{
    input: BuildAutoShiftInput
    assignments: AutoAssignment[]
  } | null>(null)
  const [editing, setEditing] = useState<
    | { mode: 'create'; date: string; staffId: string; staffName: string; avail: AvailRow | null }
    | { mode: 'edit'; asg: ShiftAsg }
    | null
  >(null)
  const [adding, setAdding] = useState<string | null>(null) // ＋スタッフを追加を開いた日付
  const [offerOpen, setOfferOpen] = useState<string | null>(null) // 開いているオファー枠の id
  const week = useMemo(() => weekMeta(weekBase), [weekBase])

  // フェーズ①: 確定はここまで（メールは送らない）。通知は「確定シフトを通知」パネルから別操作
  const publish = useMutation({
    mutationFn: () => publishWeek(storeId, week.from, week.to),
    onSuccess: (n) => {
      setPubMsg(`${n} 件のシフトを確定しました ✓`)
      void qc.invalidateQueries({ queryKey: ['shift_asg'] })
      void qc.invalidateQueries({ queryKey: ['shift_notify_preview'] })
    },
    onError: (e) => setPubErr(asgErrText(e)),
  })

  useEffect(() => {
    if (!storeId && me?.stores.length) setStoreId(me.stores[0].id)
  }, [me?.stores, storeId])

  // 店・週が変わったら草案は破棄（別入力のプレビューを持ち越さない）
  useEffect(() => {
    setPlan(null)
    setAutoMsg(null)
  }, [storeId, week.from])

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
  // 日付上書き（0026）。週内のみ取得して2層解決に使う
  const ovrQ = useQuery({
    queryKey: ['shift_req_ovr', storeId, week.from],
    enabled: !!storeId,
    queryFn: () => fetchRequirementOverrides(storeId, week.from, week.to),
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
  // C-0: 自動シフトゲート用の週内公休（公休タブと同じ ['staff_dayoff'] 接頭辞＝設定時に自動再取得）
  const dayoffQ = useQuery({
    queryKey: ['staff_dayoff', storeId, week.from, 'wk'],
    enabled: !!storeId,
    queryFn: () => fetchStaffDayOffs(storeId, week.from, week.to),
  })
  // C-1b: 割付候補のスキル判定（0025 can）
  const skillsQ = useQuery({
    queryKey: ['store_skills', storeId],
    enabled: !!storeId,
    queryFn: () => fetchStoreSkills(storeId),
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

  // 営業時間帯（0019）。0件=帯未定義の店＝現行の通し充足度表示のまま（後方互換）
  const bandsQ = useQuery({
    queryKey: ['master', 'timebands', storeId],
    enabled: !!storeId,
    queryFn: () => fetchTimeBands(storeId),
  })
  const bands = bandsQ.data ?? []

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

  // 新しい辞退（全期間・未確認のみ。0016 mgr_seen_at）
  const [declPanelOpen, setDeclPanelOpen] = useState(false)
  const [declErr, setDeclErr] = useState<string | null>(null)
  const unseenQ = useQuery({
    queryKey: ['unseen_declines', storeId],
    enabled: !!storeId,
    queryFn: () => fetchUnseenDeclines(storeId),
  })
  const markSeen = useMutation({
    mutationFn: () => markDeclinesSeen(storeId),
    onSuccess: () => {
      setDeclPanelOpen(false)
      void qc.invalidateQueries({ queryKey: ['unseen_declines'] })
      void qc.invalidateQueries({ queryKey: ['offer_recipients'] })
      void qc.invalidateQueries({ queryKey: ['offers'] })
    },
    onError: (e) => setDeclErr(errText(e, '確認済みにできませんでした')),
  })

  // 確定シフトの通知（フェーズ①: published ∧ 未通知を全期間集計 → 1人1通で通知）
  const [notifyPanelOpen, setNotifyPanelOpen] = useState(false)
  const [notifyMsg, setNotifyMsg] = useState<string | null>(null)
  const [notifyErr, setNotifyErr] = useState<string | null>(null)
  const notifyPrevQ = useQuery({
    queryKey: ['shift_notify_preview', storeId],
    enabled: !!storeId,
    queryFn: () => getShiftNotifyPreview(storeId),
  })
  const sendNotify = useMutation({
    mutationFn: () => sendShiftNotifications(storeId),
    onSuccess: (r) => {
      setNotifyMsg(
        `${r.notified_staff}名に通知 / ${r.notified_rows}件を通知済み` +
          (r.skipped_no_email > 0 ? ` / メール未登録 ${r.skipped_no_email}名スキップ` : ''),
      )
      setNotifyPanelOpen(false)
      void qc.invalidateQueries({ queryKey: ['shift_notify_preview'] })
      void qc.invalidateQueries({ queryKey: ['shift_asg'] })
    },
    onError: (e) => setNotifyErr(errText(e, '通知の送信に失敗しました')),
  })

  if (!me) return null

  // 0024: 配置セレクト等は「有効」のみ（sort_order昇順）。名前解決は無効化済みも含む全件から
  const allPositions = posQ.data ?? []
  const positions = allPositions
    .filter((p) => (p.store_id === null || p.store_id === storeId) && p.is_active)
    .sort((a, b) => a.sort_order - b.sort_order)
  const posName = (id: string | null) =>
    id ? (allPositions.find((p) => p.id === id)?.name ?? 'ポジション') : null
  // 0024: need_by_position は id キー。旧・名前キー行もシムで id に正規化してから集計する
  const reqRows = (reqQ.data ?? []).map((r) => ({
    ...r,
    need_by_position: normalizeNeedByPosition(r.need_by_position, allPositions, storeId),
  }))
  const ovrRows = (ovrQ.data ?? []).map((r) => ({
    ...r,
    need_by_position: normalizeNeedByPosition(r.need_by_position, allPositions, storeId),
  }))
  // 2層解決（0026・確定順）: ovr[date,band] → ovr[date,通し] → tpl[day_type,band] → tpl[day_type,通し]
  // → 定休0は既存UI層のまま。上書き行が見つかった枠は行単位で丸ごと採用（キーのマージはしない）
  const tplBy = new Map(reqRows.map((r) => [`${r.day_type}|${r.time_band_id ?? 'all'}`, r]))
  const ovrBy = new Map(ovrRows.map((r) => [`${r.work_date}|${r.time_band_id ?? 'all'}`, r]))
  const resolveNeed = (
    date: string,
    dt: DayType,
    bandId: string | null,
  ): { need_count: number; need_by_position: Record<string, number> } | null =>
    (bandId ? ovrBy.get(`${date}|${bandId}`) : undefined) ??
    ovrBy.get(`${date}|all`) ??
    (bandId ? tplBy.get(`${dt}|${bandId}`) : undefined) ??
    tplBy.get(`${dt}|all`) ??
    null
  const hasOvrOn = (date: string) => ovrRows.some((r) => r.work_date === date)
  const holidays = holidaysQ.data ?? new Map<string, string>()

  // C-0: 自動シフトのハードゲート（社員の公休先行固定）。判定は純関数 gateAutoShift
  const store = me.stores.find((s) => s.id === storeId)
  const closedDows = store ? closedDowsOf(store) : []
  const regulars = (rosterQ.data ?? []).filter((r) => r.isRegular)
  const gate = gateAutoShift(
    regulars,
    dayoffQ.data ?? [],
    week.days.map((d) => d.date),
    closedDows,
  )
  // 読込中の誤表示（全員未設定に見える等）を避ける: 判定材料が揃うまで非活性・パネル非表示
  const gateReady = !rosterQ.isPending && !dayoffQ.isPending && !!storeId

  /* ---------------- C-1b: 草案生成（⚙結線）・派生計算・手修正 ---------------- */
  const nameOf = new Map((rosterQ.data ?? []).map((r) => [r.staffId, r.name]))
  const bandName = (id: string | null) => (id ? (bands.find((b) => b.id === id)?.name ?? null) : null)

  // ⚙押下: 入力を組み立てて buildAutoShift（純関数・DB非書込）。再押下=同入力なら同結果（決定的）
  const runAutoShift = () => {
    const needs: AutoNeed[] = []
    for (const d of week.days) {
      if (closedDows.includes(d.dow)) continue // 定休日はスロットなし
      const dt = dayTypeOf(d.dow, !!holidays.get(d.date))
      const bandIds: (string | null)[] = bands.length > 0 ? bands.map((b) => b.id) : [null]
      for (const bid of bandIds) {
        const eff = resolveNeed(d.date, dt, bid) // 0026 の2層解決をそのまま展開元に
        if (!eff || Object.keys(eff.need_by_position).length === 0) continue
        needs.push({ date: d.date, bandId: bid, needByPosition: eff.need_by_position })
      }
    }
    const input: BuildAutoShiftInput = {
      weekDays: week.days.map((d) => d.date),
      needs,
      bands: bands.map((b) => ({ id: b.id, startMin: b.start_min, endMin: b.end_min })),
      positions: positions.map((p) => ({ id: p.id, sortOrder: p.sort_order })),
      availRows: availQ.data ?? [],
      skillMap: new Map((skillsQ.data ?? []).map((s) => [`${s.staff_id}|${s.position_id}`, s.can])),
      roster: (rosterQ.data ?? []).map((r) => ({
        staffId: r.staffId,
        positionDefaultId: r.positionDefaultId,
      })),
      dayoffRows: dayoffQ.data ?? [],
      closedDows,
      // openMin/closeMin: 店営業時間のマスタが無いため未指定＝エンジン側フォールバック(17:00-22:00)
    }
    setAutoMsg(null)
    setPlan({ input, assignments: buildAutoShift(input).assignments })
  }

  // 草案の派生値（不足・手動追加候補）。手修正のたびにここで再計算される
  const planDerived = (() => {
    if (!plan) return null
    const elig = createEligibility(plan.input)
    const assignedCount = new Map<string, number>()
    for (const a of plan.assignments) {
      const k = `${a.date}|${a.bandId ?? 'all'}|${a.positionId}`
      assignedCount.set(k, (assignedCount.get(k) ?? 0) + 1)
    }
    const shorts: {
      date: string
      bandId: string | null
      positionId: string
      lack: number
      reason: string
      addable: { staffId: string; name: string }[]
    }[] = []
    for (const n of plan.input.needs) {
      for (const [pid, cnt] of Object.entries(n.needByPosition)) {
        const lack =
          Math.trunc(cnt) - (assignedCount.get(`${n.date}|${n.bandId ?? 'all'}|${pid}`) ?? 0)
        if (lack <= 0) continue
        const eligibleAll = plan.input.roster.filter((r) =>
          elig.isEligible(r, n.date, n.bandId, pid),
        )
        const usedInBand = new Set(
          plan.assignments
            .filter((a) => a.date === n.date && (a.bandId ?? 'all') === (n.bandId ?? 'all'))
            .map((a) => a.staffId),
        )
        const addable = eligibleAll
          .filter((r) => !usedInBand.has(r.staffId))
          .map((r) => ({ staffId: r.staffId, name: nameOf.get(r.staffId) ?? r.staffId }))
        const reason =
          eligibleAll.length === 0
            ? '候補なし（希望○/△・スキル・公休の条件を満たす人がいません）'
            : addable.length === 0
              ? '候補は他の枠で充足済み'
              : '手動で追加できます'
        shorts.push({ date: n.date, bandId: n.bandId, positionId: pid, lack, reason, addable })
      }
    }
    return {
      elig,
      shorts,
      lack: shorts.reduce((s, x) => s + x.lack, 0),
    }
  })()

  // 手修正（ローカルstateの草案配列のみ編集。DB非書込）
  const removePlanAsg = (idx: number) => {
    if (!plan) return
    setPlan({ ...plan, assignments: plan.assignments.filter((_, i) => i !== idx) })
  }
  const addPlanAsg = (date: string, bandId: string | null, positionId: string, staffId: string) => {
    if (!plan || !planDerived) return
    const t = planDerived.elig.timesOf(bandId)
    setPlan({
      ...plan,
      assignments: [
        ...plan.assignments,
        { staffId, date, bandId, positionId, startMin: t.startMin, endMin: t.endMin, source: 'auto' },
      ],
    })
  }

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
              if (
                confirm(
                  `この週のシフトを確定します。スタッフへの通知は別の「確定シフトを通知」から行います（この操作ではメールは送られません）。`,
                )
              ) {
                publish.mutate()
              }
            }}
          >
            {publish.isPending ? '確定中…' : `この週を確定する（下書き ${draftCount} 件）`}
          </button>
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
        <button
          className="btn sm autoshift-btn"
          disabled={!gateReady || !gate.ok || availQ.isPending || skillsQ.isPending}
          title={gateReady && !gate.ok ? '社員の公休設定が必要です' : undefined}
          onClick={runAutoShift} // C-1b: 草案生成（純関数・DB非書込）。再押下=再生成
        >
          ⚙ 自動シフト
        </button>
      </div>

      {/* C-0: ゲート未解除の案内パネル（社員の公休が先・未設定者リスト＋公休タブ導線） */}
      {gateReady && !gate.ok && (
        <div className="gate-panel">
          <div className="dop-head">
            <b>自動シフトの前に、社員の公休を設定してください</b>
          </div>
          <div className="dop-list">
            {gate.missing.map((m) => (
              <span key={m.staffId} className="dop-rec">
                {m.name}さん…この週の公休が未設定
              </span>
            ))}
          </div>
          <p className="note">
            社員の休みを先に固定してから、アルバイト・パートを割り付けます。
            定休日は個別の公休には数えません。
          </p>
          {onGoDayoff && (
            <button className="btn sm" onClick={onGoDayoff}>
              公休タブで設定する
            </button>
          )}
        </div>
      )}

      {/* C-1b: 草案サマリ（未保存のプレビュー）。保存は C-1c＝今回はプレースホルダ */}
      {plan && planDerived && (
        <div className="plan-summary">
          <b>
            自動シフト草案<span className="auto-badge">auto</span>
          </b>
          <span className="note">未保存のプレビューです（下の各日に破線で表示）</span>
          <span className="mono plan-count">
            充足 {plan.assignments.length} / <span className={planDerived.lack > 0 ? 'plan-lack' : ''}>不足 {planDerived.lack}</span>
          </span>
          <button
            className="btn sm"
            onClick={() => {
              setPlan(null)
              setAutoMsg(null)
            }}
          >
            クリア
          </button>
          <button
            className="btn sm pri"
            onClick={() =>
              // C-1c で shift_assignments(draft) への一括保存を実装。今回は保存経路なし
              setAutoMsg('草案の保存は次の更新で有効化されます（C-1c）。')
            }
          >
            この草案を保存
          </button>
          {autoMsg && <span className="note">{autoMsg}</span>}
        </div>
      )}

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

      {(unseenQ.data?.length ?? 0) > 0 && (
        <div className="decline-panel">
          <div className="dop-head">
            <button
              type="button"
              className="decline-badge"
              onClick={() => setDeclPanelOpen((v) => !v)}
            >
              新しい辞退: {unseenQ.data!.length}件
            </button>
            <span className="note">全期間・未確認のみ（タップで一覧）</span>
          </div>
          {declPanelOpen && (
            <>
              <div className="decline-list">
                {unseenQ.data!.map((d) => (
                  <div key={d.recipient_id} className="decline-row">
                    <b>{d.staff_name}</b> さん —{' '}
                    {new Date(`${d.work_date}T00:00:00`).toLocaleDateString('ja-JP', {
                      month: 'numeric',
                      day: 'numeric',
                      weekday: 'short',
                    })}{' '}
                    <span className="mono">
                      {minToHHMM(d.start_min)}〜{minToHHMM(d.end_min)}
                    </span>{' '}
                    — 辞退{' '}
                    {d.responded_at
                      ? new Date(d.responded_at).toLocaleString('ja-JP', {
                          month: 'numeric',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })
                      : ''}
                  </div>
                ))}
              </div>
              <p className="note">
                確認済みにすると、この店舗の未確認の辞退がすべて既読になります。
              </p>
              <button
                className="btn sm pri"
                disabled={markSeen.isPending}
                onClick={() => markSeen.mutate()}
              >
                {markSeen.isPending ? '処理中…' : 'すべて確認済みにする'}
              </button>
            </>
          )}
        </div>
      )}
      {declErr && (
        <p className="login-error" role="alert">
          {declErr}
        </p>
      )}

      {(notifyPrevQ.data?.total ?? 0) > 0 && (
        <div className="notify-panel">
          <div className="dop-head">
            <b>
              未通知の確定シフト: {notifyPrevQ.data!.total}件・
              {notifyPrevQ.data!.recipients.length}名
            </b>
            <button className="btn sm" onClick={() => setNotifyPanelOpen((v) => !v)}>
              {notifyPanelOpen ? '閉じる' : 'まとめて通知'}
            </button>
          </div>
          {notifyPanelOpen && (
            <>
              <div className="dop-list">
                {notifyPrevQ.data!.recipients.map((r) => (
                  <span key={r.staff_id} className="dop-rec">
                    {r.staff_name}…{r.count}件
                    {!r.has_email && (
                      <em className="dop-warn">メール未登録のため通知されません</em>
                    )}
                  </span>
                ))}
              </div>
              <button
                className="btn-dl publish-btn"
                disabled={sendNotify.isPending}
                onClick={() => {
                  setNotifyMsg(null)
                  setNotifyErr(null)
                  if (
                    confirm(
                      `${notifyPrevQ.data!.recipients.filter((r) => r.has_email).length}名に確定シフトの通知メールを送ります。よろしいですか？`,
                    )
                  ) {
                    sendNotify.mutate()
                  }
                }}
              >
                {sendNotify.isPending ? '送信中…' : 'この内容で通知メールを送信'}
              </button>
            </>
          )}
        </div>
      )}
      {notifyMsg && (
        <p className="board-info" role="status">
          {notifyMsg}
        </p>
      )}
      {notifyErr && (
        <p className="login-error" role="alert">
          {notifyErr}
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
          // 0026: 2層解決（通し粒度）。上書きが無い店/日はテンプレそのまま＝従来と同一
          const req = resolveNeed(d.date, dt, null)
          const dayAsgs = (asgQ.data ?? []).filter((a) => a.work_date === d.date)
          const assignedStaff = new Set(dayAsgs.map((a) => a.staff_id))
          const pool = (availQ.data ?? []).filter(
            (r) => r.work_date === d.date && r.kind !== 'off' && !assignedStaff.has(r.staff_id),
          )
          const weightOf = (a: ShiftAsg) => (a.weight_half ? 0.5 : 1)
          const total = dayAsgs.reduce((s, a) => s + weightOf(a), 0)
          const need = req?.need_count ?? 0
          // 0024: position_id キーで集計（表示ラベルは posName で解決）
          const byPos = new Map<string, number>()
          for (const a of dayAsgs) {
            if (a.position_id) byPos.set(a.position_id, (byPos.get(a.position_id) ?? 0) + weightOf(a))
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
                {hasOvrOn(d.date) && (
                  <span className="ovr-mark" title="この日は必要人数の上書きあり">
                    ✎
                  </span>
                )}
                {bands.length === 0 && need > 0 && (
                  <span className={`cov-total mono${total >= need ? ' ok' : ' short'}`}>
                    {total}/{need}
                  </span>
                )}
              </div>

              {/* 帯未定義の店: 現行の通し充足度チップ（後方互換・無変更） */}
              {bands.length === 0 && req && Object.keys(req.need_by_position).length > 0 && (
                <div className="cov-rows">
                  {Object.entries(req.need_by_position).map(([pid, needN]) => {
                    const got = byPos.get(pid) ?? 0
                    return (
                      <span key={pid} className={`cov mono${got >= needN ? ' ok' : ' short'}`}>
                        {posName(pid)} {got}/{needN}
                      </span>
                    )
                  })}
                </div>
              )}

              {/* 帯定義済みの店: 帯別の過不足バンドを主表示（通しチップは出さない） */}
              {bands.length > 0 && (
                <div className="band-covs">
                  {bands.map((b) => {
                    // 0026: 2層解決（帯粒度）。ovr[date,band]→ovr[date,通し]→tpl[dt,band]→tpl[dt,通し]
                    const effReq = resolveNeed(d.date, dt, b.id)
                    const needBy = effReq?.need_by_position ?? {}
                    // 重なり判定（簡易版・当日域）: 帯に触れる配置を数える。
                    // 配置は 0-1440 域のみ（深夜跨ぎ保存手段なし）のため帯の1440超部分は実害なし。
                    // 按分せず「重なれば在籍1（0.5換算は0.5）」でカウントする
                    const bandAsgs = dayAsgs.filter(
                      (a) => a.start_min < b.end_min && a.end_min > b.start_min,
                    )
                    const haveBy = new Map<string, number>()
                    for (const a of bandAsgs) {
                      if (a.position_id)
                        haveBy.set(a.position_id, (haveBy.get(a.position_id) ?? 0) + weightOf(a))
                    }
                    const needEntries = Object.entries(needBy)
                    return (
                      <div key={b.id} className="band-cov">
                        <span className="band-cov-name">{b.name}</span>
                        {needEntries.length === 0 ? (
                          <span className="bc-unset">未設定</span>
                        ) : (
                          needEntries.map(([pid, needN]) => {
                            const got = haveBy.get(pid) ?? 0
                            const cls = got < needN ? ' short' : got === needN ? ' ok' : ' over'
                            return (
                              <span key={pid} className={`cov mono${cls}`}>
                                {posName(pid)} {got}/{needN}
                              </span>
                            )
                          })
                        )}
                      </div>
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
                      const declinedN = recs.filter((r) => r.response === 'declined').length
                      const pendingN = recs.filter((r) => r.response === 'pending').length
                      const invitedN = recs.length
                      const allDeclined =
                        invitedN > 0 && declinedN === invitedN && pendingN === 0 && appliedN === 0
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
                                  : allDeclined
                                    ? 'oc-alldeclined'
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
                                  ? `申請 ${appliedN}件・確認待ち${declinedN > 0 ? `・辞退${declinedN}` : ''}`
                                  : allDeclined
                                    ? '全員辞退・要対応'
                                    : declinedN > 0
                                      ? `承諾待ち・辞退${declinedN}`
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

              {/* C-1b: 草案レイヤ（実配置とは別物のプレビュー。破線＋autoバッジ・DB非書込） */}
              {plan &&
                planDerived &&
                (() => {
                  const dayPlan = plan.assignments
                    .map((a, i) => ({ a, i }))
                    .filter((x) => x.a.date === d.date)
                  const dayShorts = planDerived.shorts.filter((s) => s.date === d.date)
                  if (dayPlan.length === 0 && dayShorts.length === 0) return null
                  return (
                    <div className="day-plan">
                      <div className="plan-lab">
                        草案<span className="auto-badge">auto</span>
                      </div>
                      {dayPlan.map(({ a, i }) => (
                        <span key={i} className="plan-asg">
                          <b>{nameOf.get(a.staffId) ?? a.staffId}</b>
                          <span className="mono asg-time">
                            {minToHHMM(a.startMin)}-{minToHHMM(a.endMin)}
                          </span>
                          {bandName(a.bandId) && (
                            <span className="plan-band">{bandName(a.bandId)}</span>
                          )}
                          {posName(a.positionId) && (
                            <span className="asg-pos">{posName(a.positionId)}</span>
                          )}
                          <button
                            type="button"
                            className="plan-x"
                            aria-label="この草案配置を外す"
                            onClick={() => removePlanAsg(i)}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                      {dayShorts.map((s, j) => (
                        <span key={j} className="plan-short" title={s.reason}>
                          {bandName(s.bandId) && (
                            <span className="plan-band">{bandName(s.bandId)}</span>
                          )}
                          {posName(s.positionId)} 不足{s.lack}
                          {s.addable.length > 0 && (
                            <select
                              className="plan-add"
                              value=""
                              aria-label="この枠に手動で追加"
                              onChange={(e) => {
                                if (e.target.value)
                                  addPlanAsg(s.date, s.bandId, s.positionId, e.target.value)
                              }}
                            >
                              <option value="">＋追加</option>
                              {s.addable.map((c) => (
                                <option key={c.staffId} value={c.staffId}>
                                  {c.name}
                                </option>
                              ))}
                            </select>
                          )}
                        </span>
                      ))}
                    </div>
                  )
                })()}

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

  // スキルchip（0025・読取のみ）: 「このポジションで募集」の枠なら、候補に可否を可視化
  const skillsQ = useQuery({
    queryKey: ['store_skills', offer.store_id],
    enabled: !!offer.position_id,
    queryFn: () => fetchStoreSkills(offer.store_id),
  })
  const canOffered = (staffId: string) =>
    !!offer.position_id &&
    (skillsQ.data ?? []).some(
      (s) => s.staff_id === staffId && s.position_id === offer.position_id && s.can,
    )

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
                {canOffered(r.staff_id) && (
                  <span className="skill-chip">{positionName}○</span>
                )}
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

  // スキルchip（0025 app_store_skills・読取のみ）。候補限定（有効position×ロースター）は関数側で済み
  const skillsQ = useQuery({
    queryKey: ['store_skills', storeId],
    queryFn: () => fetchStoreSkills(storeId),
  })
  const canBy = new Map((skillsQ.data ?? []).map((r) => [`${r.staff_id}|${r.position_id}`, r.can]))
  const posNameOf = (id: string) => positions.find((p) => p.id === id)?.name ?? ''
  /** can=true のポジションchip。positionId 指定時はその1つだけ（「このポジションで募集」文脈） */
  const skillChips = (staffId: string, positionId?: string) => {
    const ids = positionId ? [positionId] : positions.map((p) => p.id)
    const hit = ids.filter((pid) => canBy.get(`${staffId}|${pid}`) === true)
    if (hit.length === 0) return null
    return (
      <span className="skill-chips">
        {hit.map((pid) => (
          <span key={pid} className="skill-chip">
            {posNameOf(pid)}○
          </span>
        ))}
      </span>
    )
  }

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
                      {skillChips(s.staffId, offPos || undefined)}
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
                {skillChips(s.staffId)}
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

  // あなたへのオファー（0018 definer。本人分だけ返る・token等の機微列なし）
  const myOffersQ = useQuery({
    queryKey: ['my_offers', staffId],
    enabled: !!staffId,
    queryFn: fetchMyOffers,
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

      {(myOffersQ.data?.length ?? 0) > 0 && (
        <>
          <div className="sec-h">
            <h3>あなたへのオファー</h3>
            <span className="rule" />
            <span className="cnt mono">{myOffersQ.data!.length}</span>
          </div>
          <ul className="my-offer-list">
            {myOffersQ.data!.map((o) => {
              const b = myOfferBadge(o)
              return (
                <li key={o.offer_id} className="my-offer-row">
                  <div className="my-offer-top">
                    <span className="mono small myshift-date">{dateLabel(o.work_date)}</span>
                    <span className="mono myshift-time">
                      {minToHHMM(o.start_min)}〜{minToHHMM(o.end_min)}
                    </span>
                    {o.position_name && <span className="asg-pos">{o.position_name}</span>}
                    <span className={`badge resp-badge-${b.cls}`}>{b.label}</span>
                    {o.my_response === 'applied' &&
                      o.offer_status === 'open' && (
                        <span className="mono my-offer-deadline">
                          回答締切{' '}
                          {new Date(o.deadline_at).toLocaleString('ja-JP', {
                            month: 'numeric',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                      )}
                  </div>
                  {o.my_response === 'applied' && o.my_comment && (
                    <div className="my-offer-comment">💬 {o.my_comment}</div>
                  )}
                  {o.my_response === 'pending' && o.offer_status === 'open' && (
                    <div className="note">メールのリンクから回答できます。</div>
                  )}
                </li>
              )
            })}
          </ul>
        </>
      )}
      {myOffersQ.error && (
        <p className="login-error" role="alert">
          {errText(myOffersQ.error, 'オファー状況を取得できませんでした')}
        </p>
      )}

      <p className="note">
        シフトの変更が必要なときは店舗の管理者に相談してください（マイシフトからは変更できません）。
      </p>
    </>
  )
}

/** 本人向けオファー行の状態バッジ。募集の取消/期限切れは response より優先して表示 */
function myOfferBadge(o: MyOfferRow): { cls: string; label: string } {
  if (o.offer_status === 'cancelled') return { cls: 'superseded', label: '募集取消' }
  if (o.offer_status === 'expired') return { cls: 'superseded', label: '募集期限切れ' }
  if (o.my_response === 'confirmed' && o.is_my_win === true) {
    return { cls: 'confirmed', label: '確定' }
  }
  switch (o.my_response) {
    case 'applied':
      return { cls: 'applied', label: '申請中' }
    case 'superseded':
      return { cls: 'superseded', label: '他の方で確定' }
    case 'declined':
      return { cls: 'declined', label: '辞退済み' }
    case 'confirmed':
      return { cls: 'confirmed', label: '確定' }
    default:
      return { cls: 'pending', label: '未回答' }
  }
}
