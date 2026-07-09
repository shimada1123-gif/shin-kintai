/**
 * 実働時間の単純計算（Phase 1）。
 * 実働 = clock_out − clock_in − Σ(休憩)。
 * 割増・深夜区分・日跨ぎの特別処理はしない（Phase 2）。
 */

export interface BreakLike {
  break_start_at: string
  break_end_at: string | null
}

export interface AttendanceLike {
  clock_in_at: string
  clock_out_at: string | null
  breaks: BreakLike[]
}

/** 休憩合計（分）。終了していない休憩は数えない。 */
export function breakMinutes(breaks: BreakLike[]): number {
  let ms = 0
  for (const b of breaks) {
    if (b.break_end_at) {
      ms += new Date(b.break_end_at).getTime() - new Date(b.break_start_at).getTime()
    }
  }
  return Math.max(0, Math.round(ms / 60_000))
}

/** 実働（分）。退勤が無い行は null（勤務中/休憩中）。 */
export function workedMinutes(row: AttendanceLike): number | null {
  if (!row.clock_out_at) return null
  const gross =
    new Date(row.clock_out_at).getTime() - new Date(row.clock_in_at).getTime()
  const net = Math.round(gross / 60_000) - breakMinutes(row.breaks)
  return Math.max(0, net)
}

/** 分 → "HH:MM"（Space Mono で表示する前提） */
export function fmtHM(min: number | null): string {
  if (min === null) return '—'
  const h = Math.floor(min / 60)
  const m = min % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export type RowStatus = 'working' | 'on_break' | 'done'

export function rowStatus(row: AttendanceLike): RowStatus {
  if (row.clock_out_at) return 'done'
  if (row.breaks.some((b) => !b.break_end_at)) return 'on_break'
  return 'working'
}

export const STATUS_LABEL: Record<RowStatus, string> = {
  working: '勤務中',
  on_break: '休憩中',
  done: '退勤済み',
}

const pad = (n: number) => String(n).padStart(2, '0')

/** ISO → datetime-local 入力値（端末ローカル時刻） */
export function isoToLocalInput(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** datetime-local 入力値 → ISO（空は null） */
export function localInputToIso(v: string): string | null {
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

export const hhmm = (iso: string | null): string =>
  iso
    ? new Date(iso).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
    : '—'

export const ymd = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
