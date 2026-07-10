import { createServerFn } from '@tanstack/react-start'
import { getAdminClient, type AdminClient } from '@/lib/supabase-admin.server'
import { sendMail } from '@/lib/resend.server'
import { requireCaller } from './caller'
import { assert, type Caller } from './permissions'

/**
 * オファー作成（フェーズ4-a）。announce-mail.ts の sendAnnouncementMail と同型：
 * requireCaller で JWT 検証 → 手書き権限チェック（shift_edit ∧ 対象店 = app_can_store 相当）→
 * service_role で insert → sendMail ループ → 結果集計。
 * - 生トークンは 16バイト乱数の base64url。DB には sha256 hex のみ保存し、ログにも残さない
 * - メール失敗で offer はロールバックしない（部分成功を許容し件数で報告）
 */

const BASE_URL = 'https://kintai.worldwave.workers.dev'

export interface OfferDraftInput {
  work_date: string
  position_id: string | null
  start_min: number
  end_min: number
  /** ISO 文字列。now より未来であること */
  deadline_at: string
  staff_ids: string[]
}

export interface CreateOffersResult {
  created_offers: number
  invited: number
  mail_ok: number
  mail_failed: number
  skipped: { work_date: string; reason: string }[]
}

/** 16バイト乱数 → base64url（生値はメールリンク専用。戻り値をログに出さないこと） */
function generateOfferToken(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** DB 側 encode(digest(token,'sha256'),'hex') と同じ計算 */
async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const minToHHMM = (min: number): string =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`

function dateLabel(ymd: string): { md: string; full: string } {
  const d = new Date(`${ymd}T00:00:00+09:00`)
  const opts: Intl.DateTimeFormatOptions = { timeZone: 'Asia/Tokyo' }
  const m = d.toLocaleString('ja-JP', { ...opts, month: 'numeric' }).replace('月', '')
  const day = d.toLocaleString('ja-JP', { ...opts, day: 'numeric' }).replace('日', '')
  const wd = d.toLocaleString('ja-JP', { ...opts, weekday: 'short' })
  return { md: `${m}月${day}日`, full: `${m}月${day}日（${wd}）` }
}

/** shift_edit ∧ 対象店（app_can_store のミラー）。settings.ts / announce-mail.ts の手書きチェックに倣う */
async function assertShiftEditForStore(
  admin: AdminClient,
  caller: Caller,
  storeId: string,
): Promise<{ tenantId: string; storeName: string }> {
  const { data: store } = await admin
    .from('stores')
    .select('id, tenant_id, area_id, name')
    .eq('id', storeId)
    .maybeSingle()
  assert(store && store.tenant_id === caller.tenantId, '店舗が見つかりません。')

  if (caller.role !== 'owner') {
    const { data: perm } = await admin
      .from('role_permissions')
      .select('allowed')
      .eq('tenant_id', caller.tenantId)
      .eq('role', caller.role)
      .eq('permission_key', 'shift_edit')
      .maybeSingle()
    assert(perm?.allowed === true, 'オファーを送るにはシフト編集権限（shift_edit）が必要です。')

    if (caller.role === 'area_manager') {
      assert(store.area_id !== null && store.area_id === caller.scopeAreaId, '自分のエリア外の店舗です。')
    } else if (caller.role === 'store_manager') {
      assert(store.id === caller.scopeStoreId, '自分の店舗以外にはオファーを送れません。')
    } else {
      // staff で shift_edit を持つ場合: scope 一致 or 所属（app_can_store の staff 分岐と同じ）
      let inScope = caller.scopeStoreId === store.id
      if (!inScope) {
        const { data: mem } = await admin
          .from('memberships')
          .select('staff_id')
          .eq('tenant_id', caller.tenantId)
          .eq('user_id', caller.userId)
          .maybeSingle()
        if (mem?.staff_id) {
          const { data: sa } = await admin
            .from('staff_assignments')
            .select('id')
            .eq('staff_id', mem.staff_id)
            .eq('store_id', store.id)
            .limit(1)
          inScope = (sa ?? []).length > 0
        }
      }
      assert(inScope, '対象店舗が自分の管理範囲にありません。')
    }
  }
  return { tenantId: store.tenant_id, storeName: store.name }
}

function buildMailText(a: {
  storeName: string
  workDate: string
  startMin: number
  endMin: number
  positionName: string | null
  deadlineAt: string
  acceptUrl: string
  declineUrl: string
}): { subject: string; text: string } {
  const d = dateLabel(a.workDate)
  const deadline = new Date(a.deadlineAt).toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
  const lines = [
    `${a.storeName}からシフトのお願いです。`,
    '',
    `日時: ${d.full} ${minToHHMM(a.startMin)}〜${minToHHMM(a.endMin)}`,
  ]
  if (a.positionName) lines.push(`ポジション: ${a.positionName}`)
  lines.push(
    `店舗: ${a.storeName}`,
    '',
    '参加できる場合はこちら（コメントも書けます）:',
    a.acceptUrl,
    '',
    '参加できない場合はこちら:',
    a.declineUrl,
    '',
    '※先着ではありません。締切後に店舗が確認して確定します。',
    `回答締切: ${deadline}`,
    '',
    '— SHIN勤怠 からの自動送信です。',
  )
  return { subject: `【SHIN勤怠】${d.md} シフトのお願い`, text: lines.join('\n') }
}

export const createOffers = createServerFn({ method: 'POST' })
  .inputValidator((d: { store_id: string; drafts: OfferDraftInput[] }) => {
    assert(typeof d.store_id === 'string' && d.store_id, '店舗が指定されていません。')
    assert(Array.isArray(d.drafts) && d.drafts.length > 0, 'オファー枠がありません。')
    assert(d.drafts.length <= 31, '一度に作成できる枠は31件までです。')
    for (const dr of d.drafts) {
      assert(
        typeof dr.work_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dr.work_date),
        '日付の形式が不正です。',
      )
      assert(Array.isArray(dr.staff_ids), '招待するスタッフの指定が不正です。')
      assert(dr.staff_ids.length <= 100, '一度に招待できるのは100名までです。')
    }
    return d
  })
  .handler(async ({ data }): Promise<CreateOffersResult> => {
    const caller = await requireCaller()
    const admin = getAdminClient()
    const { tenantId, storeName } = await assertShiftEditForStore(admin, caller, data.store_id)

    // 参照マスタを一括解決（スタッフはテナント境界つき＝他テナントIDはここで落ちる）
    const allStaffIds = [...new Set(data.drafts.flatMap((d) => d.staff_ids))]
    const staffById = new Map<string, { name: string; email: string | null }>()
    if (allStaffIds.length > 0) {
      const { data: staffRows, error } = await admin
        .from('staff')
        .select('id, full_name, email')
        .eq('tenant_id', tenantId)
        .in('id', allStaffIds)
      assert(!error, 'スタッフ情報の取得に失敗しました。')
      for (const s of staffRows ?? []) staffById.set(s.id, { name: s.full_name, email: s.email })
    }
    const posIds = [...new Set(data.drafts.map((d) => d.position_id).filter((p): p is string => !!p))]
    const posNameById = new Map<string, string>()
    if (posIds.length > 0) {
      const { data: posRows } = await admin
        .from('positions')
        .select('id, name')
        .eq('tenant_id', tenantId)
        .in('id', posIds)
      for (const p of posRows ?? []) posNameById.set(p.id, p.name)
    }

    const result: CreateOffersResult = {
      created_offers: 0,
      invited: 0,
      mail_ok: 0,
      mail_failed: 0,
      skipped: [],
    }

    for (const dr of data.drafts) {
      // 枠バリデーション（違反はスキップして理由を集計。0013 の CHECK とも整合）
      if (
        !Number.isInteger(dr.start_min) ||
        !Number.isInteger(dr.end_min) ||
        dr.start_min < 0 ||
        dr.end_min > 1440 ||
        dr.start_min >= dr.end_min
      ) {
        result.skipped.push({ work_date: dr.work_date, reason: '時間帯が不正です' })
        continue
      }
      const deadline = new Date(dr.deadline_at)
      if (!dr.deadline_at || Number.isNaN(deadline.getTime()) || deadline.getTime() <= Date.now()) {
        result.skipped.push({ work_date: dr.work_date, reason: '締切が過去か不正です' })
        continue
      }
      const staffIds = [...new Set(dr.staff_ids)].filter((id) => staffById.has(id))
      const unknown = new Set(dr.staff_ids).size - staffIds.length
      if (unknown > 0) {
        result.skipped.push({ work_date: dr.work_date, reason: `対象外のスタッフ ${unknown} 名を除外` })
      }
      if (staffIds.length === 0) {
        result.skipped.push({ work_date: dr.work_date, reason: '招待するスタッフがいません' })
        continue
      }

      const offerId = crypto.randomUUID()
      const { error: offErr } = await admin.from('shift_offers').insert({
        id: offerId,
        tenant_id: tenantId,
        store_id: data.store_id,
        work_date: dr.work_date,
        position_id: dr.position_id,
        start_min: dr.start_min,
        end_min: dr.end_min,
        weight_half: false,
        status: 'open',
        deadline_at: deadline.toISOString(),
        created_by: caller.userId,
      })
      if (offErr) {
        result.skipped.push({ work_date: dr.work_date, reason: `枠の作成に失敗（${offErr.code ?? 'DB'}）` })
        continue
      }
      result.created_offers++

      const positionName = dr.position_id ? (posNameById.get(dr.position_id) ?? null) : null

      for (const staffId of staffIds) {
        const staff = staffById.get(staffId)!
        const token = generateOfferToken()
        const tokenHash = await sha256Hex(token)
        const recipientId = crypto.randomUUID()

        const { error: recErr } = await admin.from('shift_offer_recipients').insert({
          id: recipientId,
          offer_id: offerId,
          staff_id: staffId,
          token_hash: tokenHash,
          response: 'pending',
          email: staff.email,
        })
        if (recErr) {
          result.mail_failed++
          continue
        }
        result.invited++

        if (!staff.email) {
          result.mail_failed++ // アドレス未登録は送信不可（招待行は残る＝画面から個別連絡できる）
          continue
        }

        const { subject, text } = buildMailText({
          storeName,
          workDate: dr.work_date,
          startMin: dr.start_min,
          endMin: dr.end_min,
          positionName,
          deadlineAt: deadline.toISOString(),
          acceptUrl: `${BASE_URL}/offer/accept?t=${token}`,
          declineUrl: `${BASE_URL}/offer/decline?t=${token}`,
        })
        const mail = await sendMail(staff.email, subject, text)
        if (mail.ok) {
          result.mail_ok++
          await admin
            .from('shift_offer_recipients')
            .update({ sent_at: new Date().toISOString() })
            .eq('id', recipientId)
        } else {
          result.mail_failed++
        }
      }
    }

    return result
  })
