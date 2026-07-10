import { createServerFn } from '@tanstack/react-start'
import { getAdminClient } from '@/lib/supabase-admin.server'
import { sendMail } from '@/lib/resend.server'
import { requireCaller } from './caller'
import { assert } from './permissions'
import { assertShiftEditForStore } from './offer-create'

/**
 * フェーズ①: シフトの「確定(published)」と「スタッフへの通知(メール)」の分離（0017 notified_at）。
 * announce-mail.ts / offer-create.ts と同型: requireCaller → 手書き権限チェック →
 * getAdminClient(service_role) → sendMail 集約（1人1通）。
 * 対象は常に「status='published' ∧ notified_at is null」（全期間・週フィルタなし）。
 * メール失敗は throw せず件数化（部分失敗許容）。email 無しは notified_at を打たない＝次回また対象。
 */

const minToHHMM = (min: number): string =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`

function dateFull(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00+09:00`)
  const opts: Intl.DateTimeFormatOptions = { timeZone: 'Asia/Tokyo' }
  const m = d.toLocaleString('ja-JP', { ...opts, month: 'numeric' }).replace('月', '')
  const day = d.toLocaleString('ja-JP', { ...opts, day: 'numeric' }).replace('日', '')
  const wd = d.toLocaleString('ja-JP', { ...opts, weekday: 'short' })
  return `${m}月${day}日（${wd}）`
}

export interface ShiftNotifyRecipient {
  staff_id: string
  staff_name: string
  email: string | null
  count: number
  has_email: boolean
}

export interface PreviewShiftNotifyResult {
  total: number
  recipients: ShiftNotifyRecipient[]
}

/** 送信前プレビュー（送らない・全期間）。未通知の確定シフトをスタッフ別に集約 */
export const previewShiftNotify = createServerFn({ method: 'POST' })
  .inputValidator((d: { store_id: string }) => {
    assert(typeof d.store_id === 'string' && d.store_id, '店舗が指定されていません。')
    return d
  })
  .handler(async ({ data }): Promise<PreviewShiftNotifyResult> => {
    const caller = await requireCaller()
    const admin = getAdminClient()
    const { tenantId } = await assertShiftEditForStore(admin, caller, data.store_id)

    const { data: rows, error } = await admin
      .from('shift_assignments')
      .select('staff_id')
      .eq('store_id', data.store_id)
      .eq('status', 'published')
      .is('notified_at', null)
    assert(!error, '未通知シフトの取得に失敗しました。')

    const countByStaff = new Map<string, number>()
    for (const r of rows ?? []) countByStaff.set(r.staff_id, (countByStaff.get(r.staff_id) ?? 0) + 1)
    if (countByStaff.size === 0) return { total: 0, recipients: [] }

    const { data: staffRows } = await admin
      .from('staff')
      .select('id, full_name, email')
      .eq('tenant_id', tenantId)
      .in('id', [...countByStaff.keys()])
    const infoById = new Map((staffRows ?? []).map((s) => [s.id, s]))

    const recipients: ShiftNotifyRecipient[] = [...countByStaff.entries()]
      .map(([staffId, count]) => {
        const s = infoById.get(staffId)
        return {
          staff_id: staffId,
          staff_name: s?.full_name ?? '(不明)',
          email: s?.email ?? null,
          count,
          has_email: !!s?.email,
        }
      })
      .sort((a, b) => a.staff_name.localeCompare(b.staff_name, 'ja'))

    return { total: (rows ?? []).length, recipients }
  })

export interface SendShiftNotifyResult {
  notified_staff: number
  notified_rows: number
  skipped_no_email: number
}

/** 未通知の確定シフトを1人1通で通知（唯一メールが飛ぶ）。成功したスタッフの行に notified_at をスタンプ */
export const sendShiftNotify = createServerFn({ method: 'POST' })
  .inputValidator((d: { store_id: string }) => {
    assert(typeof d.store_id === 'string' && d.store_id, '店舗が指定されていません。')
    return d
  })
  .handler(async ({ data }): Promise<SendShiftNotifyResult> => {
    const caller = await requireCaller()
    const admin = getAdminClient()
    const { tenantId, storeName } = await assertShiftEditForStore(admin, caller, data.store_id)

    const { data: rows, error } = await admin
      .from('shift_assignments')
      .select('id, staff_id, work_date, start_min, end_min, position_id')
      .eq('store_id', data.store_id)
      .eq('status', 'published')
      .is('notified_at', null)
    assert(!error, '未通知シフトの取得に失敗しました。')

    const result: SendShiftNotifyResult = { notified_staff: 0, notified_rows: 0, skipped_no_email: 0 }
    const all = rows ?? []
    if (all.length === 0) return result

    // ポジション名（tenant 境界つき）
    const posIds = [...new Set(all.map((r) => r.position_id).filter((p): p is string => !!p))]
    const posNameById = new Map<string, string>()
    if (posIds.length > 0) {
      const { data: posRows } = await admin
        .from('positions')
        .select('id, name')
        .eq('tenant_id', tenantId)
        .in('id', posIds)
      for (const p of posRows ?? []) posNameById.set(p.id, p.name)
    }

    // スタッフ情報
    const staffIds = [...new Set(all.map((r) => r.staff_id))]
    const { data: staffRows } = await admin
      .from('staff')
      .select('id, full_name, email')
      .eq('tenant_id', tenantId)
      .in('id', staffIds)
    const staffById = new Map((staffRows ?? []).map((s) => [s.id, s]))

    // スタッフ1人 → 確定シフト一覧 に集約
    const byStaff = new Map<string, typeof all>()
    for (const r of all) {
      const list = byStaff.get(r.staff_id) ?? []
      list.push(r)
      byStaff.set(r.staff_id, list)
    }

    for (const [staffId, items] of byStaff) {
      const staff = staffById.get(staffId)
      if (!staff?.email) {
        result.skipped_no_email++
        continue // notified_at は打たない＝次回また通知対象になる
      }
      items.sort((a, b) => a.work_date.localeCompare(b.work_date) || a.start_min - b.start_min)
      const lines = items.map((i) => {
        const pos = i.position_id ? (posNameById.get(i.position_id) ?? null) : null
        return `${dateFull(i.work_date)} ${minToHHMM(i.start_min)}〜${minToHHMM(i.end_min)}${pos ? ` ${pos}` : ''}`
      })
      const text = [
        'あなたの確定シフトをお知らせします。',
        '',
        ...lines,
        '',
        `店舗: ${storeName}`,
        '',
        '当日はよろしくお願いします。',
        '',
        '— SHIN勤怠',
      ].join('\n')

      const res = await sendMail(
        staff.email,
        `【SHIN勤怠】確定シフトのお知らせ（${items.length}件）`,
        text,
      )
      if (res.ok) {
        // blind update（.select なし）で通知済みスタンプ
        const { error: updErr } = await admin
          .from('shift_assignments')
          .update({ notified_at: new Date().toISOString() })
          .in(
            'id',
            items.map((i) => i.id),
          )
        if (!updErr) {
          result.notified_staff++
          result.notified_rows += items.length
        }
      }
    }

    return result
  })
