/**
 * C-1a: 自動シフト割付エンジン（純関数）。
 *
 * 設計原則（設計メモ§1 C-1・§3 確定事項）:
 * - 決定的: 乱数・現在時刻を使わない。同点は完全順序化（最後は staffId 昇順）。same input → same output。
 * - 設定最小: 入力は 希望(shift_availability) × 必要数(resolveNeed) × スキル(can) × 公休/定休 のみ。
 *   相性・グループ・重み付けは扱わない。
 * - 不足は埋めない: 候補が尽きたスロットは unfilled として返す（無理な割付をしない）。
 * - DBに書かない: fetch も insert もしない。全て引数で受け、草案配列を返すだけ（保存は C-1c）。
 *
 * 確定した小決定:
 * ① partial(△) は希望時刻が「実際に生成される配置時刻」を完全カバーする時のみ候補（部分重なりは候補外）。
 *    ※跨ぎ帯(end>1440)の配置は 1439 でクリップされるため、カバー判定もクリップ後レンジに対して行う
 *    （配置されない深夜部分まで要求しない）。
 * ② 生成配置時刻は常に帯が決める（希望時刻に依存しない）。帯あり=帯時刻（end>1439は1439クリップ）。
 *    帯なし店は日=1帯（bandId=null）とみなし、店営業時間（openMin/closeMin）が無ければ 17:00-22:00。
 * ③ スキル未設定（行なし）は候補外（can===true のみ候補）。
 */

/* ------------------------------- 型 ------------------------------- */

export interface AutoNeed {
  date: string
  /** null=通し（帯なし店）。resolveNeed(date, dt, bandId) の結果を日×帯ごとに並べたもの */
  bandId: string | null
  /** position_id キー × 必要人数（0024 id キー・normalizeNeedByPosition 適用済みを渡す） */
  needByPosition: Record<string, number>
}

export interface AutoBand {
  id: string
  startMin: number
  /** 0021: 深夜跨ぎは +1440 表現（end ≤ 1800） */
  endMin: number
}

export interface AutoAvail {
  staff_id: string
  work_date: string
  kind: 'avail' | 'partial' | 'off'
  start_min: number | null
  end_min: number | null
}

export interface AutoRosterEntry {
  staffId: string
  positionDefaultId: string | null
}

export interface BuildAutoShiftInput {
  /** 対象週の日付（この中の日しか割付しない） */
  weekDays: string[]
  /** 日×帯ごとの必要人数（resolveNeed の結果。null だった枠は含めない） */
  needs: AutoNeed[]
  /** 店の帯定義（帯なし店は空配列） */
  bands: AutoBand[]
  /** 有効ポジション（スロット順序用の sort_order） */
  positions: { id: string; sortOrder: number }[]
  /** 希望（shift_availability の週ぶん。行なし=未提出=候補外） */
  availRows: AutoAvail[]
  /** `${staff_id}|${position_id}` → can（0025。行なし=未設定=候補外） */
  skillMap: ReadonlyMap<string, boolean>
  /** 店ロースター（既定ポジ優先タイブレーク用） */
  roster: AutoRosterEntry[]
  /** 週内の公休（staff_day_off） */
  dayoffRows: { staff_id: string; work_date: string }[]
  /** 定休曜日（0=日..6=土）。定休日は割付対象外 */
  closedDows: number[]
  /** 帯なし店の生成配置時刻（店営業時間）。無ければ 17:00-22:00 */
  openMin?: number | null
  closeMin?: number | null
}

export interface AutoAssignment {
  staffId: string
  date: string
  bandId: string | null
  positionId: string
  startMin: number
  endMin: number
  source: 'auto'
}

export type UnfilledReason = 'no_candidate' | 'all_assigned_elsewhere'

export interface UnfilledSlot {
  date: string
  bandId: string | null
  positionId: string
  reason: UnfilledReason
}

export interface BuildAutoShiftResult {
  assignments: AutoAssignment[]
  unfilled: UnfilledSlot[]
}

/* ----------------------------- 内部ヘルパ ----------------------------- */

const DEFAULT_OPEN_MIN = 17 * 60 // 17:00（AsgEditorModal の既定と同じ）
const DEFAULT_CLOSE_MIN = 22 * 60 // 22:00
const DAY_MAX_MIN = 1439 // shift_assignments は日内(0-1439)のみ（深夜跨ぎ保存手段なし）

function dowOf(date: string): number {
  return new Date(`${date}T00:00:00`).getDay()
}

/* ---------------------- C-1c: 保存前の衝突分割 ---------------------- */

/** 衝突判定に必要な既存配置の最小形（ShiftAsg と構造互換・draft/published 両方を渡す） */
export interface ExistingAsgLite {
  staff_id: string
  work_date: string
  start_min: number
  end_min: number
}

/**
 * C-1c: 草案を「保存する行」と「既存配置と衝突するためスキップする行」に分割する純関数。
 * 衝突 = 同一 staff ∧ 同一 date ∧ 時間重なり(a.start < b.end && a.end > b.start)。
 * - 既存優先（(a)方式）: 衝突草案は skipped へ。既存行には一切触れない。
 * - 同一 staff×date でも時間が重ならなければ保存対象（分割シフト正当）。接する（end==start）は重なりでない。
 * - 決定的: toSave / skipped とも plan の元順序を保持。
 */
export function splitPlanByConflict(
  planAssignments: AutoAssignment[],
  existingAsgs: ExistingAsgLite[],
): { toSave: AutoAssignment[]; skipped: AutoAssignment[] } {
  const byStaffDate = new Map<string, ExistingAsgLite[]>()
  for (const e of existingAsgs) {
    const k = `${e.staff_id}|${e.work_date}`
    const list = byStaffDate.get(k) ?? []
    list.push(e)
    byStaffDate.set(k, list)
  }
  const toSave: AutoAssignment[] = []
  const skipped: AutoAssignment[] = []
  for (const a of planAssignments) {
    const hit = (byStaffDate.get(`${a.staffId}|${a.date}`) ?? []).some(
      (e) => a.startMin < e.end_min && a.endMin > e.start_min,
    )
    ;(hit ? skipped : toSave).push(a)
  }
  return { toSave, skipped }
}

/* --------------------------- 候補判定（共有） --------------------------- */

/**
 * C-1b: プレビューの手修正（空き枠への手動追加候補・不足理由の再計算）でも
 * buildAutoShift と同一の候補規則を使うためのファクトリ。ロジックは C-1a のまま
 * （抽出のみ・挙動不変はユニットテストで担保）。
 */
export function createEligibility(input: BuildAutoShiftInput): {
  /** ② 生成配置時刻は帯が決める。帯なし=営業時間 or 17:00-22:00。跨ぎは 1439 クリップ */
  timesOf: (bandId: string | null) => { startMin: number; endMin: number }
  /** 候補判定（スロットの人選候補になれるか。割付状況は見ない静的判定） */
  isEligible: (staff: AutoRosterEntry, date: string, bandId: string | null, positionId: string) => boolean
  /** 希望の種別（タイブレーク用。候補確定後に呼ぶ前提） */
  availKindOf: (staffId: string, date: string) => 'avail' | 'partial' | 'off' | null
} {
  const bandById = new Map(input.bands.map((b) => [b.id, b]))
  const availBy = new Map(input.availRows.map((a) => [`${a.staff_id}|${a.work_date}`, a]))
  const dayoffSet = new Set(input.dayoffRows.map((o) => `${o.staff_id}|${o.work_date}`))

  const timesOf = (bandId: string | null): { startMin: number; endMin: number } => {
    if (bandId !== null) {
      const b = bandById.get(bandId)
      if (!b) return { startMin: DEFAULT_OPEN_MIN, endMin: DEFAULT_CLOSE_MIN } // 定義漏れの防御
      return { startMin: Math.min(b.startMin, DAY_MAX_MIN), endMin: Math.min(b.endMin, DAY_MAX_MIN) }
    }
    const s = input.openMin ?? DEFAULT_OPEN_MIN
    const e = input.closeMin ?? DEFAULT_CLOSE_MIN
    return { startMin: Math.min(s, DAY_MAX_MIN), endMin: Math.min(e, DAY_MAX_MIN) }
  }

  const isEligible = (staff: AutoRosterEntry, date: string, bandId: string | null, positionId: string): boolean => {
    // 公休（C-0 と同じく明示行で判定。定休日はスロット展開側で丸ごと除外済み）
    if (dayoffSet.has(`${staff.staffId}|${date}`)) return false
    // ③ スキル: can===true のみ（行なし=未設定=候補外）
    if (input.skillMap.get(`${staff.staffId}|${positionId}`) !== true) return false
    // 希望: 行なし=未提出=候補外 / off=候補外
    const av = availBy.get(`${staff.staffId}|${date}`)
    if (!av || av.kind === 'off') return false
    if (av.kind === 'avail') return true
    // ① partial は生成配置時刻（クリップ後）を完全カバーする時のみ
    const t = timesOf(bandId)
    return av.start_min !== null && av.end_min !== null && av.start_min <= t.startMin && av.end_min >= t.endMin
  }

  const availKindOf = (staffId: string, date: string) => availBy.get(`${staffId}|${date}`)?.kind ?? null

  return { timesOf, isEligible, availKindOf }
}

/* ------------------------------ 本体 ------------------------------ */

export function buildAutoShift(input: BuildAutoShiftInput): BuildAutoShiftResult {
  const { weekDays, needs, positions, roster, closedDows } = input

  /* --- 辞書化（全て決定的な参照） --- */
  const weekSet = new Set(weekDays)
  const posSort = new Map(positions.map((p) => [p.id, p.sortOrder]))
  const { timesOf, isEligible, availKindOf } = createEligibility(input)

  /* --- 1. スロット展開: (date, band, position) × 必要人数ぶん複製 --- */
  interface Slot {
    date: string
    bandId: string | null
    positionId: string
    /** ソート用: 帯開始時刻（帯なしは生成時刻の開始） */
    bandStart: number
  }
  const slots: Slot[] = []
  for (const n of needs) {
    if (!weekSet.has(n.date)) continue // 週外は対象外
    if (closedDows.includes(dowOf(n.date))) continue // 定休日は全員休み扱い＝割付対象外
    const bandStart = timesOf(n.bandId).startMin
    // ポジションキーは決定的順序（sort_order → id）で展開
    const posIds = Object.keys(n.needByPosition).sort(
      (a, b) => (posSort.get(a) ?? 0) - (posSort.get(b) ?? 0) || (a < b ? -1 : a > b ? 1 : 0),
    )
    for (const pid of posIds) {
      const cnt = n.needByPosition[pid]
      if (!Number.isFinite(cnt) || cnt <= 0) continue
      for (let i = 0; i < Math.trunc(cnt); i++) {
        slots.push({ date: n.date, bandId: n.bandId, positionId: pid, bandStart })
      }
    }
  }

  /* --- 3. 割付順: 候補人数の少ない順（静的カウント）。同数は date → band開始 → position sort → id --- */
  const eligibleCount = new Map<string, number>()
  const eligibleKey = (s: Slot) => `${s.date}|${s.bandId ?? 'all'}|${s.positionId}`
  for (const s of slots) {
    const k = eligibleKey(s)
    if (!eligibleCount.has(k)) {
      eligibleCount.set(k, roster.filter((r) => isEligible(r, s.date, s.bandId, s.positionId)).length)
    }
  }
  const cmp = (a: Slot, b: Slot): number =>
    (eligibleCount.get(eligibleKey(a))! - eligibleCount.get(eligibleKey(b))!) ||
    (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) ||
    (a.bandStart - b.bandStart) ||
    ((posSort.get(a.positionId) ?? 0) - (posSort.get(b.positionId) ?? 0)) ||
    (a.positionId < b.positionId ? -1 : a.positionId > b.positionId ? 1 : 0) ||
    ((a.bandId ?? '') < (b.bandId ?? '') ? -1 : (a.bandId ?? '') > (b.bandId ?? '') ? 1 : 0)
  const ordered = [...slots].sort(cmp)

  /* --- 4. 順に割付。1人1(date,band)1配置・週割当分を動的加算（平準化） --- */
  const assignments: AutoAssignment[] = []
  const unfilled: UnfilledSlot[] = []
  /** `${staffId}|${date}|${bandId??'all'}` → その枠で既に配置済み */
  const usedInBand = new Set<string>()
  /** staffId → 当該週の割当合計（分・この実行内） */
  const weekMin = new Map<string, number>()

  for (const slot of ordered) {
    const eligibles = roster.filter((r) => isEligible(r, slot.date, slot.bandId, slot.positionId))
    if (eligibles.length === 0) {
      unfilled.push({ date: slot.date, bandId: slot.bandId, positionId: slot.positionId, reason: 'no_candidate' })
      continue
    }
    const free = eligibles.filter(
      (r) => !usedInBand.has(`${r.staffId}|${slot.date}|${slot.bandId ?? 'all'}`),
    )
    if (free.length === 0) {
      unfilled.push({
        date: slot.date,
        bandId: slot.bandId,
        positionId: slot.positionId,
        reason: 'all_assigned_elsewhere',
      })
      continue
    }
    // タイブレーク（この順で完全決定化）: avail>partial → 既定ポジ一致 → 週割当分少 → staffId昇順
    const kindRank = (r: AutoRosterEntry) =>
      availKindOf(r.staffId, slot.date) === 'avail' ? 0 : 1
    const pick = [...free].sort(
      (x, y) =>
        kindRank(x) - kindRank(y) ||
        (x.positionDefaultId === slot.positionId ? 0 : 1) - (y.positionDefaultId === slot.positionId ? 0 : 1) ||
        (weekMin.get(x.staffId) ?? 0) - (weekMin.get(y.staffId) ?? 0) ||
        (x.staffId < y.staffId ? -1 : x.staffId > y.staffId ? 1 : 0),
    )[0]

    const t = timesOf(slot.bandId)
    assignments.push({
      staffId: pick.staffId,
      date: slot.date,
      bandId: slot.bandId,
      positionId: slot.positionId,
      startMin: t.startMin,
      endMin: t.endMin,
      source: 'auto',
    })
    usedInBand.add(`${pick.staffId}|${slot.date}|${slot.bandId ?? 'all'}`)
    weekMin.set(pick.staffId, (weekMin.get(pick.staffId) ?? 0) + (t.endMin - t.startMin))
  }

  return { assignments, unfilled }
}
