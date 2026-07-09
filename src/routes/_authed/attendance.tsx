import { Fragment, useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { detailCsvRows, summaryCsvRows } from '@/lib/attendance-csv'
import { downloadCsv } from '@/lib/csv'
import { errText } from '@/lib/errors'
import { useMe } from '@/lib/me-context'
import { usePermissions } from '@/lib/perm'
import {
  applyDirectCorrection,
  approveCorrection,
  fetchCorrectionsFor,
  fetchDay,
  fetchPending,
  fetchRangeAll,
  fetchStaffRange,
  rejectCorrection,
  requestCorrection,
  targetLabel,
  type AttRow,
  type FieldChange,
  type PendingCorrection,
} from '@/lib/queries/attendance'
import { fetchStaffList } from '@/lib/queries/master'
import {
  breakMinutes,
  fmtHM,
  hhmm,
  isoToLocalInput,
  localInputToIso,
  rowStatus,
  STATUS_LABEL,
  workedMinutes,
  ymd,
} from '@/lib/worktime'

export const Route = createFileRoute('/_authed/attendance')({
  component: AttendancePage,
})

type Tab = 'day' | 'staff' | 'pending'

function AttendancePage() {
  const { me } = useMe()
  const perms = usePermissions()

  const isStaff = me?.role === 'staff'
  const canApprove = perms.has('correction_approve')
  const [tab, setTab] = useState<Tab>(isStaff ? 'staff' : 'day')

  if (!me) return null

  return (
    <section>
      <div className="eyebrow">勤怠 · 補正</div>
      <div className="page-h">
        <h1>勤怠</h1>
        <span className="desc">
          {isStaff ? '自分の打刻の確認と、時刻の修正申請ができます。' : '打刻の確認・修正・承認。'}
        </span>
      </div>

      {!isStaff && (
        <div className="tab-row">
          <button className={`tab${tab === 'day' ? ' on' : ''}`} onClick={() => setTab('day')}>
            日別×スタッフ
          </button>
          <button className={`tab${tab === 'staff' ? ' on' : ''}`} onClick={() => setTab('staff')}>
            スタッフ別×期間
          </button>
          {canApprove && (
            <button
              className={`tab${tab === 'pending' ? ' on' : ''}`}
              onClick={() => setTab('pending')}
            >
              承認待ち
            </button>
          )}
        </div>
      )}

      {tab === 'day' && !isStaff && <DayView canEdit={canApprove} />}
      {tab === 'staff' && <StaffView canEdit={canApprove && !isStaff} lockToSelf={isStaff} />}
      {tab === 'pending' && canApprove && !isStaff && <PendingView />}
    </section>
  )
}

/* ------------------------------ 共通: 行テーブル ------------------------------ */

function gpsChip(status: string) {
  const label = status === 'ok' ? '圏内' : status === 'out' ? '圏外' : '位置未確認'
  const cls = status === 'ok' ? 'gps-ok' : status === 'out' ? 'gps-out' : 'gps-unv'
  return <span className={`gps-chip ${cls}`}>{label}</span>
}

function statusChip(row: AttRow) {
  const s = rowStatus(row)
  const cls = s === 'done' ? 'st-out' : s === 'on_break' ? 'st-br' : 'st-in'
  return (
    <span className={`st ${cls}`}>
      <span className="dot" />
      {STATUS_LABEL[s]}
    </span>
  )
}

function RowsTable({
  rows,
  showStaff,
  showDate,
  onEdit,
  onRequest,
  historyMode,
}: {
  rows: AttRow[]
  showStaff: boolean
  showDate: boolean
  onEdit?: (row: AttRow) => void
  onRequest?: (row: AttRow) => void
  /** admin=監査ビュー / self=本人ビュー（RLSが0件を返すことがある） */
  historyMode?: 'admin' | 'self'
}) {
  const [openHistory, setOpenHistory] = useState<string | null>(null)
  const hasActions = !!(onEdit || onRequest || historyMode)
  const colCount = 7 + (showDate ? 1 : 0) + (showStaff ? 1 : 0) + (hasActions ? 1 : 0)

  return (
    <div className="card table-wrap">
      <table>
        <thead>
          <tr>
            {showDate && <th>日付</th>}
            {showStaff && <th>スタッフ</th>}
            <th>店舗</th>
            <th>出勤</th>
            <th>退勤</th>
            <th>休憩計</th>
            <th>実働</th>
            <th>GPS</th>
            <th>状態</th>
            {hasActions && <th />}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={colCount} className="note">
                対象の打刻がありません。
              </td>
            </tr>
          )}
          {rows.map((r) => (
            <Fragment key={r.id}>
              <tr>
                {showDate && (
                  <td className="mono small">
                    {new Date(r.clock_in_at).toLocaleDateString('ja-JP', {
                      month: '2-digit',
                      day: '2-digit',
                      weekday: 'short',
                    })}
                  </td>
                )}
                {showStaff && (
                  <td>
                    <b>{r.staff_name}</b>
                  </td>
                )}
                <td className="note">{r.store_name}</td>
                <td className="mono">{hhmm(r.clock_in_at)}</td>
                <td className="mono">{hhmm(r.clock_out_at)}</td>
                <td className="mono">{fmtHM(breakMinutes(r.breaks))}</td>
                <td className="mono strong-hm">{fmtHM(workedMinutes(r))}</td>
                <td>{gpsChip(r.gps_status)}</td>
                <td>{statusChip(r)}</td>
                {hasActions && (
                  <td className="row-actions">
                    {onEdit && (
                      <button className="btn sm" onClick={() => onEdit(r)}>
                        編集
                      </button>
                    )}
                    {onRequest && (
                      <button className="btn sm" onClick={() => onRequest(r)}>
                        修正を申請
                      </button>
                    )}
                    {historyMode && (
                      <button
                        className={`btn sm${openHistory === r.id ? ' hist-open' : ''}`}
                        onClick={() => setOpenHistory(openHistory === r.id ? null : r.id)}
                      >
                        {openHistory === r.id ? '履歴を閉じる' : '補正履歴'}
                      </button>
                    )}
                  </td>
                )}
              </tr>
              {historyMode && openHistory === r.id && (
                <tr>
                  <td colSpan={colCount} className="hist-cell">
                    <CorrectionHistory attendanceId={r.id} mode={historyMode} />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ---------------------------- 補正履歴（展開表示） ---------------------------- */

const CORR_STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: '承認待ち', cls: 'cs-pending' },
  approved: { label: '承認済み', cls: 'cs-approved' },
  rejected: { label: '却下', cls: 'cs-rejected' },
}

function CorrectionHistory({
  attendanceId,
  mode,
}: {
  attendanceId: string
  mode: 'admin' | 'self'
}) {
  const q = useQuery({
    queryKey: ['att', 'corr', attendanceId],
    queryFn: () => fetchCorrectionsFor(attendanceId),
  })

  if (q.isPending) return <p className="note">履歴を読み込み中…</p>

  // RLS に弾かれた場合もエラーにせず案内文言に落とす
  if (q.error) {
    return <p className="note">補正・申請の履歴は管理者にお問い合わせください。</p>
  }

  if (!q.data || q.data.length === 0) {
    return mode === 'self' ? (
      <p className="note">
        補正・申請の履歴はありません。閲覧が制限されている場合は、管理者にお問い合わせください。
      </p>
    ) : (
      <p className="note">補正履歴はありません。</p>
    )
  }

  return (
    <ul className="hist-list">
      {q.data.map((c) => {
        const st = CORR_STATUS[c.status] ?? { label: c.status, cls: '' }
        return (
          <li key={c.id} className="hist-item">
            <span className="mono small hist-when">
              {new Date(c.created_at).toLocaleString('ja-JP', {
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
            <span className="badge b-tag">{targetLabel(c.target_field)}</span>
            <span className="mono">{hhmm(c.old_value)}</span>
            <span className="hist-arrow">→</span>
            <span className="mono strong-hm">{hhmm(c.new_value)}</span>
            <span className={`corr-status ${st.cls}`}>{st.label}</span>
            <span className="note">
              {c.is_direct ? `${c.actor_name} が直接修正` : `${c.actor_name} の申請`}
              {c.reason ? ` · ${c.reason}` : ''}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

/* ------------------------------ 1. 日別×スタッフ ------------------------------ */

function DlIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3v12" />
      <path d="m7 11 5 5 5-5" />
      <path d="M4 21h16" />
    </svg>
  )
}

/** クイック選択: 今日 / 今週(月〜日) / 今月 / 先月 の開始・終了 */
function quickRange(kind: 'today' | 'week' | 'month' | 'lastMonth'): { from: string; to: string } {
  const now = new Date()
  if (kind === 'today') return { from: ymd(now), to: '' }
  if (kind === 'week') {
    const dow = (now.getDay() + 6) % 7 // 月曜=0
    const mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow)
    const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6)
    return { from: ymd(mon), to: ymd(sun) }
  }
  if (kind === 'month') {
    return {
      from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)),
      to: ymd(new Date(now.getFullYear(), now.getMonth() + 1, 0)),
    }
  }
  return {
    from: ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
    to: ymd(new Date(now.getFullYear(), now.getMonth(), 0)),
  }
}

function DayView({ canEdit }: { canEdit: boolean }) {
  const { me } = useMe()
  const [day, setDay] = useState(ymd(new Date()))
  const [storeId, setStoreId] = useState('')
  const [editing, setEditing] = useState<AttRow | null>(null)
  const [rangeTo, setRangeTo] = useState('')
  const [exportMsg, setExportMsg] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const qc = useQueryClient()

  const q = useQuery({
    queryKey: ['att', 'day', day, storeId],
    queryFn: () => fetchDay(day, storeId || null),
  })

  if (!me) return null

  const storeName = storeId ? (me.stores.find((s) => s.id === storeId)?.name ?? '店舗') : '全店'

  // 明細CSV: 終了日が空なら表示中の1日、指定があれば期間でまとめて取得
  const exportDetail = async () => {
    setExportMsg(null)
    setExporting(true)
    try {
      const to = rangeTo || day
      const rows =
        rangeTo && rangeTo !== day
          ? await fetchRangeAll(day, rangeTo, storeId || null)
          : (q.data ?? [])
      if (rows.length === 0) {
        setExportMsg('対象データがありません')
        return
      }
      const name =
        to === day ? `勤怠明細_${storeName}_${day}.csv` : `勤怠明細_${storeName}_${day}_${to}.csv`
      downloadCsv(name, detailCsvRows(rows))
      setExportMsg('ダウンロードしました ✓')
    } catch (e) {
      setExportMsg(errText(e, 'エクスポートに失敗しました'))
    } finally {
      setExporting(false)
    }
  }

  const applyQuick = (kind: 'today' | 'week' | 'month' | 'lastMonth') => {
    const r = quickRange(kind)
    setDay(r.from)
    setRangeTo(r.to)
    setExportMsg(null)
  }

  return (
    <>
      <div className="card export-bar">
        <div className="export-fields">
          <label className="field">
            <span>抽出期間（開始日）</span>
            <input
              type="date"
              value={day}
              onChange={(e) => {
                setDay(e.target.value)
                setExportMsg(null)
              }}
            />
          </label>
          <span className="range-tilde">〜</span>
          <label className="field">
            <span>終了日（空 = 単日）</span>
            <input
              type="date"
              value={rangeTo}
              min={day}
              onChange={(e) => {
                setRangeTo(e.target.value)
                setExportMsg(null)
              }}
            />
          </label>
          <label className="field">
            <span>店舗</span>
            <select value={storeId} onChange={(e) => setStoreId(e.target.value)}>
              <option value="">すべて</option>
              {me.stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="export-quick">
          <button className="tab" onClick={() => applyQuick('today')}>
            今日
          </button>
          <button className="tab" onClick={() => applyQuick('week')}>
            今週
          </button>
          <button className="tab" onClick={() => applyQuick('month')}>
            今月
          </button>
          <button className="tab" onClick={() => applyQuick('lastMonth')}>
            先月
          </button>
        </div>

        <div className="export-actions">
          <button className="btn-dl" disabled={exporting} onClick={() => void exportDetail()}>
            <DlIcon />
            {exporting ? '生成中…' : 'CSVをダウンロード（明細）'}
          </button>
          {exportMsg && <span className="note export-msg">{exportMsg}</span>}
        </div>

        <p className="note">
          終了日が空の場合は開始日の1日分を出力します。下の一覧には開始日の打刻を表示しています。
        </p>
      </div>

      {q.isPending && <p className="note">読み込み中…</p>}
      {q.error && (
        <p className="login-error" role="alert">
          {errText(q.error, '勤怠を取得できませんでした')}
        </p>
      )}
      {q.data && (
        <RowsTable
          rows={q.data}
          showStaff
          showDate={false}
          onEdit={canEdit ? setEditing : undefined}
          historyMode={canEdit ? 'admin' : undefined}
        />
      )}

      {editing && (
        <EditModal
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            void qc.invalidateQueries({ queryKey: ['att'] })
          }}
        />
      )}
    </>
  )
}

/* ---------------------------- 2. スタッフ別×期間 ---------------------------- */

function monthRange(offset: 0 | -1): { from: string; to: string } {
  const now = new Date()
  const first = new Date(now.getFullYear(), now.getMonth() + offset, 1)
  const last =
    offset === 0 ? now : new Date(now.getFullYear(), now.getMonth(), 0) /* 先月末日 */
  return { from: ymd(first), to: ymd(last) }
}

function StaffView({ canEdit, lockToSelf }: { canEdit: boolean; lockToSelf: boolean }) {
  const { me } = useMe()
  const qc = useQueryClient()
  const [staffId, setStaffId] = useState(lockToSelf ? (me?.staffId ?? '') : '')
  const [preset, setPreset] = useState<'this' | 'last' | 'custom'>('this')
  const [custom, setCustom] = useState(monthRange(0))
  const [editing, setEditing] = useState<AttRow | null>(null)
  const [requesting, setRequesting] = useState<AttRow | null>(null)

  // 集計CSVの交通費計算にも使うため、本人ビューでも取得する
  // （staff_assignments は RLS により自分の分しか返らない）
  const staffQ = useQuery({
    queryKey: ['master', 'staff'],
    queryFn: fetchStaffList,
  })

  const range = preset === 'this' ? monthRange(0) : preset === 'last' ? monthRange(-1) : custom

  const q = useQuery({
    queryKey: ['att', 'staff', staffId, range.from, range.to],
    queryFn: () => fetchStaffRange(staffId, range.from, range.to),
    enabled: !!staffId,
  })

  const [exportMsg, setExportMsg] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  if (!me) return null

  const assignments = (staffQ.data ?? []).flatMap((s) => s.assignments)

  // 集計CSV: 選択中スタッフ（表示中データ）または全スタッフ一括（期間で取得）
  const exportSummary = async (allStaff: boolean) => {
    setExportMsg(null)
    setExporting(true)
    try {
      const rows = allStaff ? await fetchRangeAll(range.from, range.to) : (q.data ?? [])
      const csv = summaryCsvRows(rows, assignments, range.from, range.to)
      if (csv.length <= 1) {
        setExportMsg('対象データがありません')
        return
      }
      const who = allStaff
        ? '全スタッフ'
        : ((staffQ.data ?? []).find((s) => s.id === staffId)?.full_name ?? 'スタッフ')
      downloadCsv(`勤怠集計_${who}_${range.from}_${range.to}.csv`, csv)
      setExportMsg('ダウンロードしました ✓')
    } catch (e) {
      setExportMsg(errText(e, 'エクスポートに失敗しました'))
    } finally {
      setExporting(false)
    }
  }
  if (lockToSelf && !me.staffId) {
    return <p className="note">このアカウントにスタッフ情報が紐付いていないため、勤怠はありません。</p>
  }

  const totalMin = (q.data ?? []).reduce((sum, r) => sum + (workedMinutes(r) ?? 0), 0)
  const doneCount = (q.data ?? []).filter((r) => r.clock_out_at).length

  return (
    <>
      <div className="filter-row">
        {!lockToSelf && (
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
        )}
        <label className="field">
          <span>期間</span>
          <select
            value={preset}
            onChange={(e) => setPreset(e.target.value as 'this' | 'last' | 'custom')}
          >
            <option value="this">今月</option>
            <option value="last">先月</option>
            <option value="custom">カスタム</option>
          </select>
        </label>
        {preset === 'custom' && (
          <>
            <label className="field">
              <span>開始</span>
              <input
                type="date"
                value={custom.from}
                onChange={(e) => setCustom({ ...custom, from: e.target.value })}
              />
            </label>
            <label className="field">
              <span>終了</span>
              <input
                type="date"
                value={custom.to}
                onChange={(e) => setCustom({ ...custom, to: e.target.value })}
              />
            </label>
          </>
        )}
      </div>

      {!staffId && !lockToSelf && <p className="note">スタッフを選択してください。</p>}
      {q.isPending && !!staffId && <p className="note">読み込み中…</p>}
      {q.error && (
        <p className="login-error" role="alert">
          {errText(q.error, '勤怠を取得できませんでした')}
        </p>
      )}

      {q.data && (
        <>
          <div className="card kpi period-total">
            <div className="k">期間合計（実働 · 退勤済み {doneCount} 日）</div>
            <div className="v">{fmtHM(totalMin)}</div>
          </div>
          <RowsTable
            rows={q.data}
            showStaff={false}
            showDate
            onEdit={canEdit ? setEditing : undefined}
            onRequest={lockToSelf ? setRequesting : undefined}
            historyMode={lockToSelf ? 'self' : canEdit ? 'admin' : undefined}
          />

          <div className="export-actions summary-export">
            <button className="btn-dl" disabled={exporting} onClick={() => void exportSummary(false)}>
              <DlIcon />
              {exporting ? '生成中…' : 'CSVをダウンロード（集計）'}
            </button>
            {!lockToSelf && (
              <button
                className="btn-dl secondary"
                disabled={exporting}
                onClick={() => void exportSummary(true)}
              >
                <DlIcon />
                全スタッフ一括（集計）
              </button>
            )}
            {exportMsg && <span className="note export-msg">{exportMsg}</span>}
          </div>
        </>
      )}

      {editing && (
        <EditModal
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            void qc.invalidateQueries({ queryKey: ['att'] })
          }}
        />
      )}
      {requesting && (
        <RequestModal
          row={requesting}
          onClose={() => setRequesting(null)}
          onSent={() => {
            setRequesting(null)
            void qc.invalidateQueries({ queryKey: ['att'] })
          }}
        />
      )}
    </>
  )
}

/* --------------------------- 補正A: 直接修正モーダル --------------------------- */

function EditModal({
  row,
  onClose,
  onSaved,
}: {
  row: AttRow
  onClose: () => void
  onSaved: () => void
}) {
  const { me } = useMe()
  const [clockIn, setClockIn] = useState(isoToLocalInput(row.clock_in_at))
  const [clockOut, setClockOut] = useState(isoToLocalInput(row.clock_out_at))
  const [breaks, setBreaks] = useState(
    row.breaks.map((b) => ({
      id: b.id,
      start: isoToLocalInput(b.break_start_at),
      end: isoToLocalInput(b.break_end_at),
    })),
  )
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: async () => {
      const changes: FieldChange[] = []
      const inIso = localInputToIso(clockIn)
      if (inIso && inIso !== row.clock_in_at) {
        changes.push({ target: 'clock_in_at', oldValue: row.clock_in_at, newValue: inIso })
      }
      const outIso = localInputToIso(clockOut)
      if (outIso && outIso !== row.clock_out_at) {
        changes.push({ target: 'clock_out_at', oldValue: row.clock_out_at, newValue: outIso })
      }
      for (const b of breaks) {
        const orig = row.breaks.find((x) => x.id === b.id)
        if (!orig) continue
        const sIso = localInputToIso(b.start)
        if (sIso && sIso !== orig.break_start_at) {
          changes.push({
            target: `break_start_at#${b.id}`,
            oldValue: orig.break_start_at,
            newValue: sIso,
          })
        }
        const eIso = localInputToIso(b.end)
        if (eIso && eIso !== orig.break_end_at) {
          changes.push({
            target: `break_end_at#${b.id}`,
            oldValue: orig.break_end_at,
            newValue: eIso,
          })
        }
      }
      if (changes.length === 0) throw new Error('変更がありません。')
      await applyDirectCorrection(me!.tenantId, row.id, changes, reason.trim() || '管理者修正')
    },
    onSuccess: onSaved,
    onError: (e) => setError(errText(e, '保存に失敗しました')),
  })

  if (!me) return null

  return (
    <div className="modal show" onClick={onClose} role="dialog" aria-modal="true">
      <div className="mcard mcard-wide" onClick={(e) => e.stopPropagation()}>
        <div className="mh">
          {row.staff_name} · {new Date(row.clock_in_at).toLocaleDateString('ja-JP')} の打刻を修正
        </div>

        {error && (
          <p className="login-error" role="alert">
            {error}
          </p>
        )}

        <div className="asg-grid">
          <label className="field">
            <span>出勤</span>
            <input
              type="datetime-local"
              value={clockIn}
              onChange={(e) => setClockIn(e.target.value)}
            />
          </label>
          <label className="field">
            <span>退勤</span>
            <div className="pw-row">
              <input
                type="datetime-local"
                value={clockOut}
                onChange={(e) => setClockOut(e.target.value)}
              />
              {!clockOut && (
                <button
                  type="button"
                  className="btn sm"
                  title="押し忘れ対応: 退勤時刻を補完します"
                  onClick={() => setClockOut(isoToLocalInput(new Date().toISOString()))}
                >
                  補完
                </button>
              )}
            </div>
          </label>
        </div>

        {breaks.length > 0 && (
          <div className="fld">
            <label>休憩</label>
            {breaks.map((b, i) => (
              <div key={b.id} className="asg-grid commute">
                <label className="field">
                  <span>開始 {i + 1}</span>
                  <input
                    type="datetime-local"
                    value={b.start}
                    onChange={(e) =>
                      setBreaks(breaks.map((x) => (x.id === b.id ? { ...x, start: e.target.value } : x)))
                    }
                  />
                </label>
                <label className="field">
                  <span>終了 {i + 1}</span>
                  <div className="pw-row">
                    <input
                      type="datetime-local"
                      value={b.end}
                      onChange={(e) =>
                        setBreaks(breaks.map((x) => (x.id === b.id ? { ...x, end: e.target.value } : x)))
                      }
                    />
                    {!b.end && (
                      <button
                        type="button"
                        className="btn sm"
                        title="押し忘れ対応: 休憩終了を補完します"
                        onClick={() =>
                          setBreaks(
                            breaks.map((x) =>
                              x.id === b.id
                                ? { ...x, end: isoToLocalInput(new Date().toISOString()) }
                                : x,
                            ),
                          )
                        }
                      >
                        補完
                      </button>
                    )}
                  </div>
                </label>
              </div>
            ))}
          </div>
        )}

        <label className="field">
          <span>修正理由（履歴に残ります）</span>
          <input
            className="ri"
            value={reason}
            placeholder="例）退勤の押し忘れ"
            onChange={(e) => setReason(e.target.value)}
          />
        </label>

        <div className="mbtns">
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
            {save.isPending ? '保存中…' : '保存（履歴を残す）'}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ---------------------------- 補正B: スタッフ申請 ---------------------------- */

function RequestModal({
  row,
  onClose,
  onSent,
}: {
  row: AttRow
  onClose: () => void
  onSent: () => void
}) {
  const { me } = useMe()

  // 申請できる対象（この打刻が持つフィールド）
  const targets = useMemo(() => {
    const list: { target: string; label: string; current: string | null }[] = [
      { target: 'clock_in_at', label: '出勤', current: row.clock_in_at },
      { target: 'clock_out_at', label: '退勤', current: row.clock_out_at },
    ]
    row.breaks.forEach((b, i) => {
      list.push({
        target: `break_start_at#${b.id}`,
        label: `休憩開始 ${i + 1}`,
        current: b.break_start_at,
      })
      list.push({
        target: `break_end_at#${b.id}`,
        label: `休憩終了 ${i + 1}`,
        current: b.break_end_at,
      })
    })
    return list
  }, [row])

  const [target, setTarget] = useState(targets[0].target)
  const [newTime, setNewTime] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  const selected = targets.find((t) => t.target === target)!

  const send = useMutation({
    mutationFn: async () => {
      const iso = localInputToIso(newTime)
      if (!iso) throw new Error('希望時刻を入力してください。')
      if (!reason.trim()) throw new Error('理由を入力してください。')
      await requestCorrection(me!.tenantId, row.id, target, selected.current, iso, reason.trim())
    },
    onSuccess: onSent,
    onError: (e) => setError(errText(e, '申請に失敗しました')),
  })

  if (!me) return null

  return (
    <div className="modal show" onClick={onClose} role="dialog" aria-modal="true">
      <div className="mcard mcard-wide" onClick={(e) => e.stopPropagation()}>
        <div className="mh">
          {new Date(row.clock_in_at).toLocaleDateString('ja-JP')} の修正を申請
        </div>
        <p className="note">申請は承認されるまで打刻には反映されません。</p>

        {error && (
          <p className="login-error" role="alert">
            {error}
          </p>
        )}

        <label className="field">
          <span>直したい時刻</span>
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            {targets.map((t) => (
              <option key={t.target} value={t.target}>
                {t.label}（現在 {hhmm(t.current)}）
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>希望時刻</span>
          <input
            type="datetime-local"
            value={newTime}
            onChange={(e) => setNewTime(e.target.value)}
          />
        </label>

        <label className="field">
          <span>理由（必須）</span>
          <input
            className="ri"
            value={reason}
            placeholder="例）退勤を押し忘れました"
            onChange={(e) => setReason(e.target.value)}
          />
        </label>

        <div className="mbtns">
          <button className="btn sm" onClick={onClose}>
            閉じる
          </button>
          <button
            className="btn sm pri"
            disabled={send.isPending}
            onClick={() => {
              setError(null)
              send.mutate()
            }}
          >
            {send.isPending ? '送信中…' : '申請する'}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------- 承認待ち一覧 ------------------------------- */

function PendingView() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['att', 'pending'], queryFn: fetchPending })
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['att'] })

  const approve = useMutation({
    mutationFn: ({ c, note }: { c: PendingCorrection; note?: string }) => approveCorrection(c, note),
    onSuccess: invalidate,
    onError: (e) => setError(errText(e, '承認に失敗しました')),
  })
  const reject = useMutation({
    mutationFn: ({ c, note }: { c: PendingCorrection; note?: string }) => rejectCorrection(c, note),
    onSuccess: invalidate,
    onError: (e) => setError(errText(e, '却下に失敗しました')),
  })

  return (
    <>
      {error && (
        <p className="login-error" role="alert">
          {error}
        </p>
      )}
      {q.isPending && <p className="note">読み込み中…</p>}
      {q.data && q.data.length === 0 && <p className="note">承認待ちの申請はありません。</p>}

      {(q.data ?? []).map((c) => (
        <div key={c.id} className="card pending-card">
          <div className="pending-head">
            <b>{c.staff_name}</b>
            <span className="note">
              {c.store_name} · {new Date(c.clock_in_at).toLocaleDateString('ja-JP')} の打刻
            </span>
            <span className="mono small pending-when">
              申請 {new Date(c.created_at).toLocaleString('ja-JP')}
            </span>
          </div>
          <div className="pending-body">
            <span className="badge b-tag">{targetLabel(c.target_field)}</span>
            <span className="mono">{hhmm(c.old_value)}</span>
            <span className="arrow">→</span>
            <span className="mono strong-hm">{hhmm(c.new_value)}</span>
          </div>
          {c.reason && <p className="note">理由: {c.reason}</p>}
          <div className="pending-actions">
            <input
              className="ri note-input"
              placeholder="申請者へのメモ（任意）"
              value={notes[c.id] ?? ''}
              onChange={(e) => setNotes({ ...notes, [c.id]: e.target.value })}
            />
            <button
              className="btn sm pri"
              disabled={approve.isPending || reject.isPending}
              onClick={() => approve.mutate({ c, note: notes[c.id] })}
            >
              承認して反映
            </button>
            <button
              className="btn sm danger"
              disabled={approve.isPending || reject.isPending}
              onClick={() => reject.mutate({ c, note: notes[c.id] })}
            >
              却下
            </button>
          </div>
        </div>
      ))}
    </>
  )
}
