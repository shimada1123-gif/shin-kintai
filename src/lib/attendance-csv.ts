import type { AttRow } from '@/lib/queries/attendance'
import type { Assignment } from '@/lib/queries/master'
import { breakMinutes, fmtHM, hhmm, rowStatus, STATUS_LABEL, workedMinutes } from '@/lib/worktime'

/**
 * 勤怠CSVの行組み立て（デモ行は呼び出し側のクエリで既に除外済み）。
 * 文字コード・改行・エスケープは csv.ts（BOM付きUTF-8 / CRLF / RFC4180）が担う。
 */

const GPS_LABEL: Record<string, string> = {
  ok: '圏内',
  out: '圏外',
  unverified: '位置未確認',
}

/** 分 → 給与ソフト向けの小数時間（例 450分 → "7.50"） */
function decimalHours(min: number | null): string {
  if (min === null) return ''
  return (min / 60).toFixed(2)
}

const dateOf = (iso: string) =>
  new Date(iso).toLocaleDateString('sv-SE') // yyyy-mm-dd（端末ローカル）

/* ------------------------------- 明細CSV ------------------------------- */

export function detailCsvRows(rows: AttRow[]): string[][] {
  const header = [
    '日付',
    '店舗',
    'スタッフ',
    '出勤時刻',
    '退勤時刻',
    '休憩合計(HH:MM)',
    '実働(HH:MM)',
    '実働(小数)',
    'GPSステータス',
    '備考',
  ]
  const body = rows.map((r) => {
    const worked = workedMinutes(r)
    const status = rowStatus(r)
    return [
      dateOf(r.clock_in_at),
      r.store_name,
      r.staff_name,
      hhmm(r.clock_in_at),
      r.clock_out_at ? hhmm(r.clock_out_at) : '',
      fmtHM(breakMinutes(r.breaks)),
      worked === null ? '' : fmtHM(worked),
      decimalHours(worked),
      GPS_LABEL[r.gps_status] ?? r.gps_status,
      status === 'done' ? '' : STATUS_LABEL[status], // 未退勤/休憩中の注記
    ]
  })
  return [header, ...body]
}

/* ------------------------------- 集計CSV ------------------------------- */

/** 期間に含まれる暦月数（月額交通費の掛け数） */
function monthsSpanned(fromDay: string, toDay: string): number {
  const [fy, fm] = fromDay.split('-').map(Number)
  const [ty, tm] = toDay.split('-').map(Number)
  return Math.max(1, (ty * 12 + tm) - (fy * 12 + fm) + 1)
}

export function summaryCsvRows(
  rows: AttRow[],
  assignments: Assignment[],
  fromDay: string,
  toDay: string,
): string[][] {
  const header = [
    'スタッフ',
    '店舗',
    '期間',
    '出勤日数',
    '実働合計(HH:MM)',
    '実働合計(小数)',
    '交通費合計(円)',
  ]

  // スタッフ×店舗で集計
  const groups = new Map<
    string,
    { staff_name: string; store_name: string; staff_id: string; store_id: string; days: Set<string>; totalMin: number }
  >()
  for (const r of rows) {
    const key = `${r.staff_id}|${r.store_id}`
    let g = groups.get(key)
    if (!g) {
      g = {
        staff_name: r.staff_name,
        store_name: r.store_name,
        staff_id: r.staff_id,
        store_id: r.store_id,
        days: new Set(),
        totalMin: 0,
      }
      groups.set(key, g)
    }
    g.days.add(dateOf(r.clock_in_at))
    g.totalMin += workedMinutes(r) ?? 0 // 未退勤は合計に入れない
  }

  const months = monthsSpanned(fromDay, toDay)
  const period = `${fromDay}〜${toDay}`

  const body = [...groups.values()]
    .sort((a, b) => a.staff_name.localeCompare(b.staff_name, 'ja'))
    .map((g) => {
      // 交通費: daily=日額×出勤日数 / monthly=月額×暦月数 / none=0。
      // 所属が見えない（wage_individual_view なし=RLSで不可視）場合は空欄。
      const asg = assignments.find((a) => a.staff_id === g.staff_id && a.store_id === g.store_id)
      let commute = ''
      if (asg) {
        if (asg.commute_type === 'daily') commute = String(asg.commute_amount * g.days.size)
        else if (asg.commute_type === 'monthly') commute = String(asg.commute_amount * months)
        else commute = '0'
      }
      return [
        g.staff_name,
        g.store_name,
        period,
        String(g.days.size),
        fmtHM(g.totalMin),
        decimalHours(g.totalMin),
        commute,
      ]
    })

  return [header, ...body]
}
