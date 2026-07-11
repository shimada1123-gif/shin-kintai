/**
 * C-3: laborAlerts のユニットテスト。
 * 実行: npm run test:labor （= node src/lib/labor-alerts.test.ts）
 */
import assert from 'node:assert/strict'
import { laborAlerts, type LaborAsg } from './labor-alerts.ts'

// 2026-07-12(日)〜2026-07-18(土)
const WEEK = ['2026-07-12', '2026-07-13', '2026-07-14', '2026-07-15', '2026-07-16', '2026-07-17', '2026-07-18']
const D = WEEK

const asg = (staff: string, date: string, s: number, e: number): LaborAsg => ({
  staffId: staff,
  date,
  startMin: s,
  endMin: e,
})
const run = (assignments: LaborAsg[], shakai = true) =>
  laborAlerts({ assignments, roster: [{ staffId: 'a', shakaiTarget: shakai }], weekDays: WEEK })
const codes = (r: ReturnType<typeof laborAlerts>, staff = 'a') =>
  (r.byStaff.get(staff) ?? []).map((x) => `${x.kind}:${x.code}`)

let passed = 0
function t(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`OK  ${name}`)
}

/* ---- 1. 週20h（社保対象のみ・2段） ---- */

t('週20h: 社保対象で1200分以上 → warn', () => {
  // 4日×5h=1200分
  const r = run([asg('a', D[0], 600, 900), asg('a', D[1], 600, 900), asg('a', D[2], 600, 900), asg('a', D[3], 600, 900)])
  assert.ok(codes(r).includes('warn:week20'))
})

t('週20h: 社保対象で1080-1199分 → info（接近）', () => {
  const r = run([asg('a', D[0], 600, 900), asg('a', D[1], 600, 900), asg('a', D[2], 600, 900), asg('a', D[3], 600, 780)])
  assert.ok(codes(r).includes('info:week20'))
  assert.ok(!codes(r).includes('warn:week20'))
})

t('週20h: 社保対象外は同時間でも week20 なし', () => {
  const r = run(
    [asg('a', D[0], 600, 900), asg('a', D[1], 600, 900), asg('a', D[2], 600, 900), asg('a', D[3], 600, 900)],
    false,
  )
  assert.ok(!codes(r).some((c) => c.endsWith('week20')))
})

t('週20h: 1080分未満は warn/info なし', () => {
  const r = run([asg('a', D[0], 600, 900)])
  assert.ok(!codes(r).some((c) => c.endsWith('week20')))
})

/* ---- 2. 連勤 ---- */

t('連勤: 6連勤 → warn（詳細に6連勤）', () => {
  const r = run(D.slice(0, 6).map((d) => asg('a', d, 600, 700)))
  const al = r.byStaff.get('a')!.find((x) => x.code === 'consec')!
  assert.equal(al.kind, 'warn')
  assert.equal(al.detail, '6連勤')
})

t('連勤: 5連勤は warn なし', () => {
  const r = run(D.slice(0, 5).map((d) => asg('a', d, 600, 700)))
  assert.ok(!codes(r).includes('warn:consec'))
})

t('連勤: 飛び石（間に休み）は連続でない', () => {
  // 3日+休み+3日 = 最長3連勤
  const r = run([D[0], D[1], D[2], D[4], D[5], D[6]].map((d) => asg('a', d, 600, 700)))
  assert.ok(!codes(r).includes('warn:consec'))
})

/* ---- 3. インターバル ---- */

t('インターバル: 前日23:00→翌日7:00（480分）→ warn', () => {
  const r = run([asg('a', D[0], 1020, 1380), asg('a', D[1], 420, 700)])
  const al = r.byStaff.get('a')!.find((x) => x.code === 'interval')!
  assert.equal(al.kind, 'warn')
  assert.ok(al.detail.includes('8h'))
})

t('インターバル: ちょうど540分（9h）は warn なし', () => {
  // end 22:00(1320) → 翌 7:00(420): 120+420=540
  const r = run([asg('a', D[0], 1020, 1320), asg('a', D[1], 420, 700)])
  assert.ok(!codes(r).includes('warn:interval'))
})

t('インターバル: 跨ぎ表現（end>1440）は実endで計算', () => {
  // end=翌2:00(1560) → 翌日10:00(600): 1440-1560+600 = 480 < 540 → warn
  const r = run([asg('a', D[0], 1200, 1560), asg('a', D[1], 600, 900)])
  assert.ok(codes(r).includes('warn:interval'))
})

t('インターバル: 連続していない2日は対象外', () => {
  const r = run([asg('a', D[0], 1020, 1380), asg('a', D[2], 420, 700)])
  assert.ok(!codes(r).includes('warn:interval'))
})

/* ---- 4. 深夜 ---- */

t('深夜: 22:00を超える配置 → info（日数つき）', () => {
  const r = run([asg('a', D[0], 1200, 1380), asg('a', D[1], 1200, 1439)])
  const al = r.byStaff.get('a')!.find((x) => x.code === 'latenight')!
  assert.equal(al.kind, 'info')
  assert.equal(al.detail, '深夜勤務 2日')
})

t('深夜: end=1320ちょうど（22:00終業）は非該当・日中のみも非該当', () => {
  const r = run([asg('a', D[0], 1020, 1320), asg('a', D[1], 600, 900)])
  assert.ok(!codes(r).includes('info:latenight'))
})

/* ---- 決定性・縮退 ---- */

t('決定性: same input を2回 → 完全一致（アラート順含む）', () => {
  const mk = () => [
    ...D.slice(0, 6).map((d) => asg('a', d, 1020, 1380)),
    asg('a', D[6], 420, 1380),
    asg('b', D[0], 600, 700),
  ]
  const input = () => ({
    assignments: mk(),
    roster: [
      { staffId: 'a', shakaiTarget: true },
      { staffId: 'b', shakaiTarget: false },
    ],
    weekDays: WEEK,
  })
  const r1 = laborAlerts(input())
  const r2 = laborAlerts(input())
  assert.deepEqual([...r1.byStaff.entries()], [...r2.byStaff.entries()])
  // code 固定順（week20→consec→interval→latenight）
  assert.deepEqual(
    r1.byStaff.get('a')!.map((x) => x.code),
    ['week20', 'consec', 'interval', 'latenight'],
  )
})

t('縮退: 配置0/roster0 → 空・例外なし', () => {
  assert.equal(laborAlerts({ assignments: [], roster: [], weekDays: WEEK }).byStaff.size, 0)
  assert.equal(
    laborAlerts({ assignments: [asg('a', '2026-08-01', 600, 700)], roster: [], weekDays: WEEK }).byStaff.size,
    0,
  ) // 週外は無視
})

console.log(`\n${passed} tests passed`)
