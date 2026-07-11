/**
 * C-3: 軽量労務アラート（純関数）。
 *
 * 初版は全ソフト＝可視化のみ（確定ブロックしない）。判定4種・固定閾値（LABOR_THRESHOLDS に集約）:
 *   1. 週20h（社保加入ライン）: 社保対象（shakaiTarget=true）のみ。1200分以上=warn / 1080分以上=info（接近）。
 *   2. 連勤: 配置のある日が 6日以上連続 → warn。全員対象。
 *   3. 勤務間インターバル: 連続2日の 前日end→翌日start が 540分（9h）未満 → warn。全員対象。
 *      跨ぎ配置（endMin>1440 の将来表現）も式 (1440 - end) + start で自然に扱える。
 *      ※現行データは end≤1439 クリップ（C-1確定）のため過大評価方向＝見逃し側に倒れる。
 *   4. 深夜: 22:00（1320分）を超えて働く配置がある → info（違反でなく事実バッジ）。全員対象。
 *      境界: end=1320 ちょうどは深夜労働0分のため非該当（end>1320 で判定）。
 *
 * 純関数: fetch/乱数/now を使わない。同一入力→同一出力（アラート順も固定）。
 * shakaiTarget は呼び出し側で決める（現状 employment_kinds に社保フラグ列が無いため、
 * 結線層では「非社員 is_regular=false」を対象として渡す。将来フラグ列が出来たら差し替え）。
 */

export const LABOR_THRESHOLDS = {
  /** 社保加入ライン: 週20h（分） */
  WEEK_SHAKAI_MIN: 1200,
  /** 接近の目安: 週18h（分） */
  WEEK_SHAKAI_NEAR_MIN: 1080,
  /** 連勤警告: この日数以上の連続勤務 */
  MAX_CONSEC: 6,
  /** 勤務間インターバル下限: 9h（分） */
  MIN_INTERVAL_MIN: 540,
  /** 深夜の開始: 22:00（分） */
  LATE_NIGHT_START_MIN: 1320,
} as const

export interface LaborAsg {
  staffId: string
  date: string // YYYY-MM-DD
  startMin: number
  endMin: number
}

export interface LaborRosterEntry {
  staffId: string
  /** 週20h判定の対象か（社保加入ライン監視対象。現状の結線=非社員） */
  shakaiTarget: boolean
}

export interface LaborAlert {
  kind: 'warn' | 'info'
  code: 'week20' | 'consec' | 'interval' | 'latenight'
  detail: string
}

export interface LaborAlertsResult {
  /** アラートのあるスタッフのみ。値の並びは code 固定順（week20→consec→interval→latenight） */
  byStaff: Map<string, LaborAlert[]>
}

/** 翌日の YYYY-MM-DD（入力日付からの決定的計算） */
function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00`)
  const n = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`
}

const hrsLabel = (min: number) => `${Math.round((min / 60) * 10) / 10}h`

export function laborAlerts(input: {
  /** その週の配置（draft+published 両方・手組み/草案を問わず呼び出し側が合成して渡す） */
  assignments: LaborAsg[]
  roster: LaborRosterEntry[]
  weekDays: string[]
}): LaborAlertsResult {
  const T = LABOR_THRESHOLDS
  const weekSet = new Set(input.weekDays)
  const shakaiBy = new Map(input.roster.map((r) => [r.staffId, r.shakaiTarget]))

  // staff → date → その日の配置（週内のみ）
  const byStaff = new Map<string, Map<string, LaborAsg[]>>()
  for (const a of input.assignments) {
    if (!weekSet.has(a.date)) continue
    const days = byStaff.get(a.staffId) ?? new Map<string, LaborAsg[]>()
    const list = days.get(a.date) ?? []
    list.push(a)
    days.set(a.date, list)
    byStaff.set(a.staffId, days)
  }

  const out = new Map<string, LaborAlert[]>()
  // 決定的順序: staffId 昇順
  const staffIds = [...byStaff.keys()].sort()

  for (const staffId of staffIds) {
    const days = byStaff.get(staffId)!
    const dates = [...days.keys()].sort()
    const alerts: LaborAlert[] = []

    // 1. 週20h（社保対象のみ・2段: 超過=warn / 接近=info）
    let weekMin = 0
    for (const list of days.values()) for (const a of list) weekMin += a.endMin - a.startMin
    if (shakaiBy.get(staffId) === true) {
      if (weekMin >= T.WEEK_SHAKAI_MIN) {
        alerts.push({ kind: 'warn', code: 'week20', detail: `週${hrsLabel(weekMin)}（社保ライン20h超過）` })
      } else if (weekMin >= T.WEEK_SHAKAI_NEAR_MIN) {
        alerts.push({ kind: 'info', code: 'week20', detail: `週${hrsLabel(weekMin)}（社保ライン20hに接近）` })
      }
    }

    // 2. 連勤（配置のある日の最長連続。週内判定）
    let maxRun = 0
    let run = 0
    let cursor: string | null = null
    for (const d of dates) {
      run = cursor !== null && d === nextDay(cursor) ? run + 1 : 1
      cursor = d
      if (run > maxRun) maxRun = run
    }
    if (maxRun >= T.MAX_CONSEC) {
      alerts.push({ kind: 'warn', code: 'consec', detail: `${maxRun}連勤` })
    }

    // 3. インターバル（連続2日のみ。前日の最遅end → 翌日の最早start。最悪値を1件で報告）
    let worst: number | null = null
    for (const d of dates) {
      const nd = nextDay(d)
      if (!days.has(nd)) continue
      const endMax = Math.max(...days.get(d)!.map((a) => a.endMin))
      const startMin = Math.min(...days.get(nd)!.map((a) => a.startMin))
      const interval = 1440 - endMax + startMin // 跨ぎ(end>1440)も自然に負担分が引かれる
      if (worst === null || interval < worst) worst = interval
    }
    if (worst !== null && worst < T.MIN_INTERVAL_MIN) {
      const h = Math.floor(worst / 60)
      const m = worst % 60
      alerts.push({
        kind: 'warn',
        code: 'interval',
        detail: `勤務間インターバル ${h}h${m > 0 ? `${m}m` : ''}（9h未満）`,
      })
    }

    // 4. 深夜（22:00を超えて働く日がある＝事実の info。end=1320丁度は深夜0分で非該当）
    let nightDays = 0
    for (const list of days.values()) {
      if (list.some((a) => a.endMin > T.LATE_NIGHT_START_MIN)) nightDays++
    }
    if (nightDays > 0) {
      alerts.push({ kind: 'info', code: 'latenight', detail: `深夜勤務 ${nightDays}日` })
    }

    if (alerts.length > 0) out.set(staffId, alerts)
  }

  return { byStaff: out }
}
