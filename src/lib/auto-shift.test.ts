/**
 * C-1a: buildAutoShift のユニットテスト。
 * 実行: npm run test:autoshift  （= node src/lib/auto-shift.test.ts・Node組込みの型ストリップで直接実行）
 * フレームワーク不使用（node:assert のみ）。全ケース決定的。
 */
import assert from 'node:assert/strict'
import {
  buildAutoShift,
  type AutoAvail,
  type BuildAutoShiftInput,
} from './auto-shift.ts'

/* ------------------------- テスト用ビルダ ------------------------- */

// 2026-07-12(日)〜2026-07-18(土)
const WEEK = ['2026-07-12', '2026-07-13', '2026-07-14', '2026-07-15', '2026-07-16', '2026-07-17', '2026-07-18']
const MON = '2026-07-13'
const TUE = '2026-07-14'

const P1 = 'pos-1'
const P2 = 'pos-2'
const B1 = 'band-1' // 12:00-15:00
const B2 = 'band-2' // 17:00-22:00

function baseInput(over: Partial<BuildAutoShiftInput> = {}): BuildAutoShiftInput {
  return {
    weekDays: WEEK,
    needs: [],
    bands: [
      { id: B1, startMin: 720, endMin: 900 },
      { id: B2, startMin: 1020, endMin: 1320 },
    ],
    positions: [
      { id: P1, sortOrder: 1 },
      { id: P2, sortOrder: 2 },
    ],
    availRows: [],
    skillMap: new Map(),
    roster: [],
    dayoffRows: [],
    closedDows: [],
    ...over,
  }
}

const avail = (staff: string, date: string): AutoAvail => ({
  staff_id: staff,
  work_date: date,
  kind: 'avail',
  start_min: null,
  end_min: null,
})
const partial = (staff: string, date: string, s: number, e: number): AutoAvail => ({
  staff_id: staff,
  work_date: date,
  kind: 'partial',
  start_min: s,
  end_min: e,
})
const off = (staff: string, date: string): AutoAvail => ({
  staff_id: staff,
  work_date: date,
  kind: 'off',
  start_min: null,
  end_min: null,
})
const skills = (pairs: [string, string][]): Map<string, boolean> =>
  new Map(pairs.map(([st, po]) => [`${st}|${po}`, true]))
const staff = (id: string, def: string | null = null) => ({ staffId: id, positionDefaultId: def })

let passed = 0
function t(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`OK  ${name}`)
}

/* ------------------------------ テスト ------------------------------ */

t('決定性: same input を2回 → 完全一致（順序含む）', () => {
  const make = (): BuildAutoShiftInput =>
    baseInput({
      needs: [
        { date: MON, bandId: B1, needByPosition: { [P1]: 2, [P2]: 1 } },
        { date: TUE, bandId: B2, needByPosition: { [P1]: 1 } },
      ],
      availRows: [avail('a', MON), avail('b', MON), avail('c', MON), avail('a', TUE), avail('b', TUE)],
      skillMap: skills([['a', P1], ['b', P1], ['c', P1], ['a', P2], ['b', P2], ['c', P2]]),
      roster: [staff('a'), staff('b'), staff('c')],
    })
  assert.deepEqual(buildAutoShift(make()), buildAutoShift(make()))
})

t('需要=供給: ちょうど埋まる（不足0）', () => {
  const r = buildAutoShift(
    baseInput({
      needs: [{ date: MON, bandId: B1, needByPosition: { [P1]: 2 } }],
      availRows: [avail('a', MON), avail('b', MON)],
      skillMap: skills([['a', P1], ['b', P1]]),
      roster: [staff('a'), staff('b')],
    }),
  )
  assert.equal(r.assignments.length, 2)
  assert.equal(r.unfilled.length, 0)
  assert.deepEqual(r.assignments.map((x) => x.staffId).sort(), ['a', 'b'])
})

t('供給不足: 候補ゼロ → unfilled(no_candidate)', () => {
  const r = buildAutoShift(
    baseInput({
      needs: [{ date: MON, bandId: B1, needByPosition: { [P1]: 1 } }],
      roster: [staff('a')], // 希望もスキルも無し
    }),
  )
  assert.equal(r.assignments.length, 0)
  assert.deepEqual(r.unfilled, [{ date: MON, bandId: B1, positionId: P1, reason: 'no_candidate' }])
})

t('供給不足: 候補は居るが同枠で使い切り → unfilled(all_assigned_elsewhere)', () => {
  // 1人しか居ないのに同帯で P1×1 + P2×1 → P2 は使い切りで不足
  const r = buildAutoShift(
    baseInput({
      needs: [{ date: MON, bandId: B1, needByPosition: { [P1]: 1, [P2]: 1 } }],
      availRows: [avail('a', MON)],
      skillMap: skills([['a', P1], ['a', P2]]),
      roster: [staff('a')],
    }),
  )
  assert.equal(r.assignments.length, 1)
  assert.equal(r.unfilled.length, 1)
  assert.equal(r.unfilled[0].reason, 'all_assigned_elsewhere')
})

t('①partial: 帯を完全カバー → 候補', () => {
  const r = buildAutoShift(
    baseInput({
      needs: [{ date: MON, bandId: B1, needByPosition: { [P1]: 1 } }], // 720-900
      availRows: [partial('a', MON, 720, 900)],
      skillMap: skills([['a', P1]]),
      roster: [staff('a')],
    }),
  )
  assert.equal(r.assignments.length, 1)
})

t('①partial: 部分重なりのみ → 候補外', () => {
  const r = buildAutoShift(
    baseInput({
      needs: [{ date: MON, bandId: B1, needByPosition: { [P1]: 1 } }], // 720-900
      availRows: [partial('a', MON, 780, 900)], // 開始が帯に届かない
      skillMap: skills([['a', P1]]),
      roster: [staff('a')],
    }),
  )
  assert.equal(r.assignments.length, 0)
  assert.equal(r.unfilled[0].reason, 'no_candidate')
})

t('off/未提出 → 候補外', () => {
  const r = buildAutoShift(
    baseInput({
      needs: [{ date: MON, bandId: B1, needByPosition: { [P1]: 2 } }],
      availRows: [off('a', MON)], // a=×、b=未提出（行なし）
      skillMap: skills([['a', P1], ['b', P1]]),
      roster: [staff('a'), staff('b')],
    }),
  )
  assert.equal(r.assignments.length, 0)
  assert.equal(r.unfilled.length, 2)
})

t('③skill未設定（行なし）→ 候補外', () => {
  const r = buildAutoShift(
    baseInput({
      needs: [{ date: MON, bandId: B1, needByPosition: { [P2]: 1 } }],
      availRows: [avail('a', MON)],
      skillMap: skills([['a', P1]]), // P2 は未設定
      roster: [staff('a')],
    }),
  )
  assert.equal(r.assignments.length, 0)
})

t('公休 → 候補外', () => {
  const r = buildAutoShift(
    baseInput({
      needs: [{ date: MON, bandId: B1, needByPosition: { [P1]: 1 } }],
      availRows: [avail('a', MON)],
      skillMap: skills([['a', P1]]),
      roster: [staff('a')],
      dayoffRows: [{ staff_id: 'a', work_date: MON }],
    }),
  )
  assert.equal(r.assignments.length, 0)
})

t('定休 → その日は割付対象外（C-0と同じ closed_dows 規則・スロット自体を作らない）', () => {
  const r = buildAutoShift(
    baseInput({
      needs: [{ date: MON, bandId: B1, needByPosition: { [P1]: 1 } }], // 月曜
      availRows: [avail('a', MON)],
      skillMap: skills([['a', P1]]),
      roster: [staff('a')],
      closedDows: [1], // 月曜定休
    }),
  )
  assert.equal(r.assignments.length, 0)
  assert.equal(r.unfilled.length, 0) // 不足ですらない＝対象外
})

t('タイブレーク1: avail(○) > partial(△・完全カバーでも)', () => {
  const r = buildAutoShift(
    baseInput({
      needs: [{ date: MON, bandId: B1, needByPosition: { [P1]: 1 } }],
      availRows: [partial('a', MON, 0, 1439), avail('b', MON)], // a=△(id昇順で先) b=○
      skillMap: skills([['a', P1], ['b', P1]]),
      roster: [staff('a'), staff('b')],
    }),
  )
  assert.equal(r.assignments[0].staffId, 'b')
})

t('タイブレーク2: 既定ポジ一致を優先（staff_id昇順より強い）', () => {
  const r = buildAutoShift(
    baseInput({
      needs: [{ date: MON, bandId: B1, needByPosition: { [P1]: 1 } }],
      availRows: [avail('a', MON), avail('b', MON)],
      skillMap: skills([['a', P1], ['b', P1]]),
      roster: [staff('a'), staff('b', P1)], // b の既定ポジ=P1
    }),
  )
  assert.equal(r.assignments[0].staffId, 'b')
})

t('タイブレーク3: 週割当(分)が少ない人を優先（平準化・実行内で動的加算）', () => {
  // B1(月)で a が先に1枠取る → B2(月)は b が優先されるはず
  const r = buildAutoShift(
    baseInput({
      needs: [
        { date: MON, bandId: B1, needByPosition: { [P1]: 1 } },
        { date: MON, bandId: B2, needByPosition: { [P1]: 1 } },
      ],
      availRows: [avail('a', MON), avail('b', MON)],
      skillMap: skills([['a', P1], ['b', P1]]),
      roster: [staff('a'), staff('b')],
    }),
  )
  const byBand = new Map(r.assignments.map((x) => [x.bandId, x.staffId]))
  assert.equal(byBand.get(B1), 'a') // 同点→staff_id昇順で a
  assert.equal(byBand.get(B2), 'b') // a は既に180分 → b 優先
})

t('タイブレーク4: 全同点は staff_id 昇順', () => {
  const r = buildAutoShift(
    baseInput({
      needs: [{ date: MON, bandId: B1, needByPosition: { [P1]: 1 } }],
      availRows: [avail('b', MON), avail('a', MON)], // 入力順を逆にしても
      skillMap: skills([['a', P1], ['b', P1]]),
      roster: [staff('b'), staff('a')],
    }),
  )
  assert.equal(r.assignments[0].staffId, 'a')
})

t('1人1(date,band)1配置: 同帯の別ポジションに二重配置しない', () => {
  const r = buildAutoShift(
    baseInput({
      needs: [{ date: MON, bandId: B1, needByPosition: { [P1]: 1, [P2]: 1 } }],
      availRows: [avail('a', MON), avail('b', MON)],
      skillMap: skills([['a', P1], ['a', P2], ['b', P1], ['b', P2]]),
      roster: [staff('a'), staff('b')],
    }),
  )
  assert.equal(r.assignments.length, 2)
  const keys = r.assignments.map((x) => `${x.staffId}|${x.date}|${x.bandId}`)
  assert.equal(new Set(keys).size, keys.length) // 同一人×同枠なし
})

t('②跨ぎ帯: end>1439 は 1439 にクリップ（○のみ候補・partialはクリップ後をカバーすれば候補）', () => {
  const r = buildAutoShift(
    baseInput({
      bands: [{ id: B1, startMin: 1200, endMin: 1740 }], // 20:00-翌5:00
      needs: [{ date: MON, bandId: B1, needByPosition: { [P1]: 2 } }],
      availRows: [avail('a', MON), partial('b', MON, 1200, 1439)],
      skillMap: skills([['a', P1], ['b', P1]]),
      roster: [staff('a'), staff('b')],
    }),
  )
  assert.equal(r.assignments.length, 2)
  for (const x of r.assignments) {
    assert.equal(x.startMin, 1200)
    assert.equal(x.endMin, 1439) // クリップ
  }
})

t('②帯なし店: 日=1帯(bandId=null)・時刻=営業時間', () => {
  const r = buildAutoShift(
    baseInput({
      bands: [],
      needs: [{ date: MON, bandId: null, needByPosition: { [P1]: 1 } }],
      availRows: [avail('a', MON)],
      skillMap: skills([['a', P1]]),
      roster: [staff('a')],
      openMin: 600,
      closeMin: 1380,
    }),
  )
  assert.deepEqual(
    r.assignments.map((x) => [x.bandId, x.startMin, x.endMin]),
    [[null, 600, 1380]],
  )
})

t('②帯なし店: 営業時間なし → フォールバック 17:00-22:00', () => {
  const r = buildAutoShift(
    baseInput({
      bands: [],
      needs: [{ date: MON, bandId: null, needByPosition: { [P1]: 1 } }],
      availRows: [avail('a', MON)],
      skillMap: skills([['a', P1]]),
      roster: [staff('a')],
    }),
  )
  assert.deepEqual([r.assignments[0].startMin, r.assignments[0].endMin], [1020, 1320])
})

t('割付順: 候補の少ないスロットから埋める（制約の厳しい所を先に）', () => {
  // P2 は b しかできない。b を P1 に先に使うと P2 が埋まらないが、
  // 候補少ない P2(=bのみ) が先に処理されるので両方埋まる
  const r = buildAutoShift(
    baseInput({
      needs: [{ date: MON, bandId: B1, needByPosition: { [P1]: 1, [P2]: 1 } }],
      availRows: [avail('a', MON), avail('b', MON)],
      skillMap: skills([['a', P1], ['b', P1], ['b', P2]]),
      roster: [staff('a'), staff('b')],
    }),
  )
  assert.equal(r.assignments.length, 2)
  assert.equal(r.unfilled.length, 0)
  assert.equal(r.assignments.find((x) => x.positionId === P2)?.staffId, 'b')
  assert.equal(r.assignments.find((x) => x.positionId === P1)?.staffId, 'a')
})

t('縮退: needs空 / roster空 / 需要0 → 空出力・例外なし', () => {
  assert.deepEqual(buildAutoShift(baseInput()), { assignments: [], unfilled: [] })
  assert.deepEqual(
    buildAutoShift(baseInput({ needs: [{ date: MON, bandId: B1, needByPosition: {} }] })),
    { assignments: [], unfilled: [] },
  )
  assert.deepEqual(
    buildAutoShift(
      baseInput({ needs: [{ date: MON, bandId: B1, needByPosition: { [P1]: 0 } }], roster: [] }),
    ),
    { assignments: [], unfilled: [] },
  )
})

t('週外の日付の needs は無視', () => {
  const r = buildAutoShift(
    baseInput({
      needs: [{ date: '2026-08-01', bandId: B1, needByPosition: { [P1]: 1 } }],
      availRows: [avail('a', '2026-08-01')],
      skillMap: skills([['a', P1]]),
      roster: [staff('a')],
    }),
  )
  assert.deepEqual(r, { assignments: [], unfilled: [] })
})

console.log(`\n${passed} tests passed`)
