import { createServerFn } from '@tanstack/react-start'
import { getRequestHeader } from '@tanstack/react-start/server'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'
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

/* -------------------- フェーズ5-1: 確定（サーバ化＋確定/落選メール） -------------------- */

export interface ConfirmOfferResult {
  ok: boolean
  reason: string | null
  overlapWarning: boolean
  /** 勝者への確定メールが送れたか（アドレス未登録・送信失敗は false） */
  confirmed_mail_ok: boolean
  /** 落選者へ送れた「埋まりました」メールの件数 */
  superseded_mail_sent: number
}

/**
 * 管理者の確定をサーバ関数化。app_offer_confirm(0014) は勝者しか返さないため、
 * rpc 実行「直前」に applied/pending の recipients をスナップショットし、
 * 成功後に「勝者以外」を落選通知の宛先にする（押し出された集合と厳密一致）。
 * メール失敗は throw せず件数に積むだけ（確定は成立済み＝ロールバックしない）。
 */
export const confirmOffer = createServerFn({ method: 'POST' })
  .inputValidator((d: { recipient_id: string }) => {
    assert(typeof d.recipient_id === 'string' && d.recipient_id, '対象が指定されていません。')
    return d
  })
  .handler(async ({ data }): Promise<ConfirmOfferResult> => {
    const caller = await requireCaller()
    const admin = getAdminClient()

    const fail = (reason: string): ConfirmOfferResult => ({
      ok: false,
      reason,
      overlapWarning: false,
      confirmed_mail_ok: false,
      superseded_mail_sent: 0,
    })

    // b. recipient → offer を解決し、権限確認（definer 内チェックと二重）
    const { data: rec } = await admin
      .from('shift_offer_recipients')
      .select('id, offer_id, staff_id, email')
      .eq('id', data.recipient_id)
      .maybeSingle()
    if (!rec) return fail('invalid')

    const { data: off } = await admin
      .from('shift_offers')
      .select('id, tenant_id, store_id, work_date, start_min, end_min, position_id')
      .eq('id', rec.offer_id)
      .maybeSingle()
    if (!off || off.tenant_id !== caller.tenantId) return fail('invalid')

    const { storeName } = await assertShiftEditForStore(admin, caller, off.store_id)

    // c. 確定直前スナップショット（applied/pending ＝ 今回の確定で押し出される可能性のある集合）
    const { data: snapshot, error: snapErr } = await admin
      .from('shift_offer_recipients')
      .select('id, staff_id, email')
      .eq('offer_id', off.id)
      .in('response', ['applied', 'pending'])
    assert(!snapErr, '申請状況の取得に失敗しました。')

    // d. rpc は「呼び出し者の JWT ＋ anon キー」で実行する。
    //    service_role だと definer 内の app_has_perm/app_can_store（auth.uid() ベース）が
    //    null ユーザー扱いで必ず forbidden になるため、admin 経路では呼ばない
    const jwt = (getRequestHeader('authorization') ?? '').replace(/^Bearer\s+/i, '')
    const url =
      process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? import.meta.env.VITE_SUPABASE_URL
    const anonKey = process.env.VITE_SUPABASE_ANON_KEY ?? import.meta.env.VITE_SUPABASE_ANON_KEY
    assert(url && anonKey, 'Supabase の接続設定が見つかりません。')
    const asCaller = createClient<Database>(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    })

    const { data: raw, error: rpcErr } = await asCaller.rpc('app_offer_confirm', {
      p_recipient_id: data.recipient_id,
    })
    assert(!rpcErr, '確定処理に失敗しました。時間をおいて再度お試しください。')
    const r = (raw ?? {}) as {
      ok?: boolean
      reason?: string
      staff_id?: string
      overlap_warning?: boolean
    }

    // e. 失敗はそのまま返す（メールは送らない）
    if (r.ok !== true) return fail(r.reason ?? 'error')

    // f. 確定メール（勝者）＋埋まりましたメール（落選者）
    const winnerStaffId = r.staff_id ?? rec.staff_id
    const d2 = dateLabel(off.work_date)

    let positionName: string | null = null
    if (off.position_id) {
      const { data: p } = await admin
        .from('positions')
        .select('name')
        .eq('tenant_id', off.tenant_id)
        .eq('id', off.position_id)
        .maybeSingle()
      positionName = p?.name ?? null
    }

    // 勝者 email: スナップショット優先、null なら staff からテナント境界つきでフォールバック
    let winnerEmail = (snapshot ?? []).find((s) => s.staff_id === winnerStaffId)?.email ?? null
    if (!winnerEmail) {
      const { data: st } = await admin
        .from('staff')
        .select('email')
        .eq('tenant_id', off.tenant_id)
        .eq('id', winnerStaffId)
        .maybeSingle()
      winnerEmail = st?.email ?? null
    }

    let confirmedMailOk = false
    if (winnerEmail) {
      const lines = [
        `${d2.full} ${minToHHMM(off.start_min)}〜${minToHHMM(off.end_min)} のシフトが確定しました。`,
        '',
        `店舗: ${storeName}`,
      ]
      if (positionName) lines.push(`ポジション: ${positionName}`)
      lines.push('', '当日はよろしくお願いします。', '', '— SHIN勤怠')
      const res = await sendMail(
        winnerEmail,
        `【SHIN勤怠】${d2.md} シフト確定のお知らせ`,
        lines.join('\n'),
      )
      confirmedMailOk = res.ok
    }

    let supersededSent = 0
    const losers = (snapshot ?? []).filter((s) => s.staff_id !== winnerStaffId && s.email)
    const loserText = [
      `先日お願いした${d2.md}のシフトは、今回は他の方に決まりました。`,
      'またの機会によろしくお願いします。',
      '',
      '— SHIN勤怠',
    ].join('\n')
    for (const l of losers) {
      const res = await sendMail(l.email!, `【SHIN勤怠】${d2.md} シフトのお知らせ`, loserText)
      if (res.ok) supersededSent++
    }

    return {
      ok: true,
      reason: r.reason ?? null,
      overlapWarning: r.overlap_warning === true,
      confirmed_mail_ok: confirmedMailOk,
      superseded_mail_sent: supersededSent,
    }
  })

/* -------------------- フェーズ②: 下書きに溜める → まとめて一斉送信（1人1通） -------------------- */

export interface CreateDraftOffersResult {
  created_offers: number
  invited: number
  skipped: { work_date: string; reason: string }[]
}

/**
 * 下書きオファー作成。createOffers と同形だがメールを一切送らない（0通）。
 * 仮トークンの生値は破棄する（一斉送信時に再生成して token_hash を更新するため保存不要）。
 */
export const createDraftOffers = createServerFn({ method: 'POST' })
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
  .handler(async ({ data }): Promise<CreateDraftOffersResult> => {
    const caller = await requireCaller()
    const admin = getAdminClient()
    const { tenantId } = await assertShiftEditForStore(admin, caller, data.store_id)

    const allStaffIds = [...new Set(data.drafts.flatMap((d) => d.staff_ids))]
    const staffById = new Map<string, { email: string | null }>()
    if (allStaffIds.length > 0) {
      const { data: staffRows, error } = await admin
        .from('staff')
        .select('id, email')
        .eq('tenant_id', tenantId)
        .in('id', allStaffIds)
      assert(!error, 'スタッフ情報の取得に失敗しました。')
      for (const s of staffRows ?? []) staffById.set(s.id, { email: s.email })
    }

    const result: CreateDraftOffersResult = { created_offers: 0, invited: 0, skipped: [] }

    for (const dr of data.drafts) {
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
        status: 'draft',
        deadline_at: deadline.toISOString(),
        created_by: caller.userId,
      })
      if (offErr) {
        result.skipped.push({ work_date: dr.work_date, reason: `枠の作成に失敗（${offErr.code ?? 'DB'}）` })
        continue
      }
      result.created_offers++

      for (const staffId of staffIds) {
        const staff = staffById.get(staffId)!
        // 仮トークン（生値は即破棄。送信時に再生成して hash を差し替える）
        const tokenHash = await sha256Hex(generateOfferToken())
        const { error: recErr } = await admin.from('shift_offer_recipients').insert({
          id: crypto.randomUUID(),
          offer_id: offerId,
          staff_id: staffId,
          token_hash: tokenHash,
          response: 'pending',
          email: staff.email,
        })
        if (!recErr) result.invited++
      }
    }

    return result
  })

export interface DraftPreviewRecipient {
  staff_id: string
  staff_name: string
  email: string | null
  count: number
  has_email: boolean
}

export interface PreviewDraftOffersResult {
  total_offers: number
  recipients: DraftPreviewRecipient[]
}

/** 送信前プレビュー（送らない）。その店の下書き枠をスタッフ別に集約して返す */
export const previewDraftOffers = createServerFn({ method: 'POST' })
  .inputValidator((d: { store_id: string }) => {
    assert(typeof d.store_id === 'string' && d.store_id, '店舗が指定されていません。')
    return d
  })
  .handler(async ({ data }): Promise<PreviewDraftOffersResult> => {
    const caller = await requireCaller()
    const admin = getAdminClient()
    const { tenantId } = await assertShiftEditForStore(admin, caller, data.store_id)

    const { data: offers, error: offErr } = await admin
      .from('shift_offers')
      .select('id')
      .eq('store_id', data.store_id)
      .eq('status', 'draft')
    assert(!offErr, '下書きの取得に失敗しました。')
    const offerIds = (offers ?? []).map((o) => o.id)
    if (offerIds.length === 0) return { total_offers: 0, recipients: [] }

    const { data: recs, error: recErr } = await admin
      .from('shift_offer_recipients')
      .select('staff_id, email')
      .in('offer_id', offerIds)
    assert(!recErr, '招待予定の取得に失敗しました。')

    const byStaff = new Map<string, { email: string | null; count: number }>()
    for (const r of recs ?? []) {
      const cur = byStaff.get(r.staff_id) ?? { email: r.email, count: 0 }
      cur.count++
      if (!cur.email && r.email) cur.email = r.email
      byStaff.set(r.staff_id, cur)
    }

    const nameById = new Map<string, string>()
    if (byStaff.size > 0) {
      const { data: staffRows } = await admin
        .from('staff')
        .select('id, full_name')
        .eq('tenant_id', tenantId)
        .in('id', [...byStaff.keys()])
      for (const s of staffRows ?? []) nameById.set(s.id, s.full_name)
    }

    const recipients: DraftPreviewRecipient[] = [...byStaff.entries()]
      .map(([staffId, v]) => ({
        staff_id: staffId,
        staff_name: nameById.get(staffId) ?? '(不明)',
        email: v.email,
        count: v.count,
        has_email: !!v.email,
      }))
      .sort((a, b) => a.staff_name.localeCompare(b.staff_name, 'ja'))

    return { total_offers: offerIds.length, recipients }
  })

export interface SendDraftOffersResult {
  sent_mails: number
  offers_opened: number
  skipped_overdue: number
  skipped_no_email: number
}

/**
 * 下書きの一斉送信（唯一メールが飛ぶ関数）。スタッフ1人につき1通に集約。
 * - 締切を再検証し、過ぎた枠は送らず draft のまま残す（expire_due は open のみ対象のためここで弾く）
 * - 生トークンは送信時に新規生成 → token_hash を更新 → メール本文にのみ使用（DB非保存・ログ非出力）
 * - メールが1人でも送れた offer は open 化。全員送れなかった offer は draft のまま
 */
export const sendDraftOffers = createServerFn({ method: 'POST' })
  .inputValidator((d: { store_id: string }) => {
    assert(typeof d.store_id === 'string' && d.store_id, '店舗が指定されていません。')
    return d
  })
  .handler(async ({ data }): Promise<SendDraftOffersResult> => {
    const caller = await requireCaller()
    const admin = getAdminClient()
    const { tenantId, storeName } = await assertShiftEditForStore(admin, caller, data.store_id)

    const { data: offers, error: offErr } = await admin
      .from('shift_offers')
      .select('id, work_date, start_min, end_min, position_id, deadline_at')
      .eq('store_id', data.store_id)
      .eq('status', 'draft')
    assert(!offErr, '下書きの取得に失敗しました。')

    const now = Date.now()
    const sendable = (offers ?? []).filter((o) => new Date(o.deadline_at).getTime() > now)
    const result: SendDraftOffersResult = {
      sent_mails: 0,
      offers_opened: 0,
      skipped_overdue: (offers ?? []).length - sendable.length,
      skipped_no_email: 0,
    }
    if (sendable.length === 0) return result

    const posIds = [...new Set(sendable.map((o) => o.position_id).filter((p): p is string => !!p))]
    const posNameById = new Map<string, string>()
    if (posIds.length > 0) {
      const { data: posRows } = await admin
        .from('positions')
        .select('id, name')
        .eq('tenant_id', tenantId)
        .in('id', posIds)
      for (const p of posRows ?? []) posNameById.set(p.id, p.name)
    }
    const offerById = new Map(sendable.map((o) => [o.id, o]))

    const { data: recs, error: recErr } = await admin
      .from('shift_offer_recipients')
      .select('id, offer_id, staff_id, email')
      .in(
        'offer_id',
        sendable.map((o) => o.id),
      )
    assert(!recErr, '招待予定の取得に失敗しました。')

    interface MailItem {
      recId: string
      offerId: string
      workDate: string
      startMin: number
      endMin: number
      positionName: string | null
      token: string
    }
    const byEmail = new Map<string, MailItem[]>()

    for (const r of recs ?? []) {
      if (!r.email) {
        result.skipped_no_email++
        continue
      }
      const off = offerById.get(r.offer_id)
      if (!off) continue
      // 生トークンを新規生成して hash を差し替え（生値はメール本文にのみ使う）
      const token = generateOfferToken()
      const tokenHash = await sha256Hex(token)
      const { error: updErr } = await admin
        .from('shift_offer_recipients')
        .update({ token_hash: tokenHash })
        .eq('id', r.id)
      if (updErr) continue
      const list = byEmail.get(r.email) ?? []
      list.push({
        recId: r.id,
        offerId: r.offer_id,
        workDate: off.work_date,
        startMin: off.start_min,
        endMin: off.end_min,
        positionName: off.position_id ? (posNameById.get(off.position_id) ?? null) : null,
        token,
      })
      byEmail.set(r.email, list)
    }

    const openedOffers = new Set<string>()
    for (const [email, items] of byEmail) {
      items.sort((a, b) => a.workDate.localeCompare(b.workDate) || a.startMin - b.startMin)
      const blocks = items.map((i) => {
        const d = dateLabel(i.workDate)
        return [
          `${d.full} ${minToHHMM(i.startMin)}〜${minToHHMM(i.endMin)}${i.positionName ? ` ${i.positionName}` : ''}`,
          `参加（コメント可）: ${BASE_URL}/offer/accept?t=${i.token}`,
          `不参加: ${BASE_URL}/offer/decline?t=${i.token}`,
        ].join('\n')
      })
      const text = [
        `${storeName}からシフトのお願いです。ご都合の合う枠があればご回答ください。`,
        '',
        blocks.join('\n\n'),
        '',
        '※先着ではありません。締切後に店舗が確認して確定します。',
        '',
        '— SHIN勤怠 からの自動送信です。',
      ].join('\n')

      const res = await sendMail(email, `【SHIN勤怠】シフトのお願い（${items.length}件）`, text)
      if (res.ok) {
        result.sent_mails++
        await admin
          .from('shift_offer_recipients')
          .update({ sent_at: new Date().toISOString() })
          .in(
            'id',
            items.map((i) => i.recId),
          )
        for (const i of items) openedOffers.add(i.offerId)
      }
    }

    if (openedOffers.size > 0) {
      const { error: openErr } = await admin
        .from('shift_offers')
        .update({ status: 'open' })
        .in('id', [...openedOffers])
        .eq('status', 'draft')
      if (!openErr) result.offers_opened = openedOffers.size
    }

    return result
  })
