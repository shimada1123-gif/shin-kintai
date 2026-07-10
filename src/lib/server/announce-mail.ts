import { createServerFn } from '@tanstack/react-start'
import { getAdminClient, type AdminClient } from '@/lib/supabase-admin.server'
import { sendMail } from '@/lib/resend.server'
import { requireCaller } from './caller'
import { assert, type Caller } from './permissions'

/**
 * 掲示板フェーズβ：メール一斉配信。
 * - service_role は対象者メールの収集と email_deliveries への記録にのみ使用
 * - 呼び出し元の権限は requireCaller + canManageAnnouncement で自前検証
 *   （owner / 投稿者本人 / announce_post∧対象店舗が自スコープ … 0009 の app_announcement_manage のミラー）
 * - 宛先は DB に保存済みの scope_type + join テーブル（announcement_stores/kinds）だけから解決する。
 *   クライアントから宛先リストは一切受け取らない＝投稿の対象範囲外へは構造的に送れない
 */

const BOARD_URL_BASE = 'https://kintai.worldwave.workers.dev/board'

interface AnnRow {
  id: string
  tenant_id: string
  author: string | null
  title: string
  body: string
  importance: string
  scope_type: string
  deleted_at: string | null
}

/** 0009 の app_announcement_manage と同じ判定（owner / 投稿者 / announce_post∧対象店舗が自スコープ） */
async function loadManageableAnnouncement(
  admin: AdminClient,
  caller: Caller,
  announcementId: string,
): Promise<AnnRow> {
  const { data: ann, error } = await admin
    .from('announcements')
    .select('id, tenant_id, author, title, body, importance, scope_type, deleted_at')
    .eq('id', announcementId)
    .maybeSingle()
  assert(!error && ann && ann.tenant_id === caller.tenantId, 'お知らせが見つかりません。')
  assert(!ann.deleted_at, '削除されたお知らせです。')

  if (caller.role === 'owner' || (ann.author !== null && ann.author === caller.userId)) {
    return ann
  }

  const { data: perm } = await admin
    .from('role_permissions')
    .select('allowed')
    .eq('tenant_id', caller.tenantId)
    .eq('role', caller.role)
    .eq('permission_key', 'announce_post')
    .maybeSingle()
  assert(perm?.allowed === true, 'メール配信の権限がありません（掲示板権限が必要です）。')

  const { data: targets } = await admin
    .from('announcement_stores')
    .select('store_id')
    .eq('announcement_id', announcementId)
  const storeIds = (targets ?? []).map((t) => t.store_id)
  assert(storeIds.length > 0, 'この投稿を配信できるのは投稿者本人かオーナーだけです。')

  let inScope = false
  if (caller.role === 'area_manager') {
    const { data: stores } = await admin.from('stores').select('id, area_id').in('id', storeIds)
    inScope = (stores ?? []).some((s) => s.area_id !== null && s.area_id === caller.scopeAreaId)
  } else if (caller.role === 'store_manager') {
    inScope = caller.scopeStoreId !== null && storeIds.includes(caller.scopeStoreId)
  } else if (caller.role === 'staff') {
    if (caller.scopeStoreId && storeIds.includes(caller.scopeStoreId)) {
      inScope = true
    } else {
      const { data: mem } = await admin
        .from('memberships')
        .select('staff_id')
        .eq('tenant_id', caller.tenantId)
        .eq('user_id', caller.userId)
        .maybeSingle()
      if (mem?.staff_id) {
        const { data: sa } = await admin
          .from('staff_assignments')
          .select('store_id')
          .eq('staff_id', mem.staff_id)
          .in('store_id', storeIds)
        inScope = (sa ?? []).length > 0
      }
    }
  }
  assert(inScope, '対象店舗が自分の管理範囲にありません。')
  return ann
}

interface Recipient {
  staffId: string
  userId: string | null
  name: string
  email: string
}

/**
 * 宛先解決。投稿の scope_type と join テーブルの実データに厳密に従う。
 * - all              → テナントの有効スタッフ全員
 * - stores           → 対象店舗に有効所属のあるスタッフ
 * - kinds            → 対象区分の有効所属のあるスタッフ
 * - stores_and_kinds → 店舗一致 ∧ 区分一致（可視性 RLS と同じ AND）
 */
async function resolveRecipients(
  admin: AdminClient,
  ann: AnnRow,
): Promise<{ recipients: Recipient[]; noEmail: Recipient[] }> {
  let staffIds: string[] | null = null // null = 全有効スタッフ

  if (ann.scope_type !== 'all') {
    const [stRes, kdRes, asgRes] = await Promise.all([
      admin.from('announcement_stores').select('store_id').eq('announcement_id', ann.id),
      admin.from('announcement_kinds').select('employment_kind_id').eq('announcement_id', ann.id),
      admin
        .from('staff_assignments')
        .select('staff_id, store_id, employment_kind_id')
        .eq('tenant_id', ann.tenant_id)
        .eq('is_active', true),
    ])
    assert(!stRes.error && !kdRes.error && !asgRes.error, '宛先の解決に失敗しました。')

    const targetStores = new Set((stRes.data ?? []).map((r) => r.store_id))
    const targetKinds = new Set((kdRes.data ?? []).map((r) => r.employment_kind_id))
    const asg = asgRes.data ?? []

    const byStore = new Set(
      asg.filter((a) => targetStores.has(a.store_id)).map((a) => a.staff_id),
    )
    const byKind = new Set(
      asg
        .filter((a) => a.employment_kind_id !== null && targetKinds.has(a.employment_kind_id))
        .map((a) => a.staff_id),
    )

    if (ann.scope_type === 'stores') staffIds = [...byStore]
    else if (ann.scope_type === 'kinds') staffIds = [...byKind]
    else staffIds = [...byStore].filter((id) => byKind.has(id))

    if (staffIds.length === 0) return { recipients: [], noEmail: [] }
  }

  let q = admin
    .from('staff')
    .select('id, user_id, full_name, email')
    .eq('tenant_id', ann.tenant_id)
    .eq('status', 'active')
  if (staffIds) q = q.in('id', staffIds)
  const { data: staff, error } = await q
  assert(!error, '宛先スタッフの取得に失敗しました。')

  const recipients: Recipient[] = []
  const noEmail: Recipient[] = []
  const seen = new Set<string>()
  for (const s of staff ?? []) {
    const email = (s.email ?? '').trim().toLowerCase()
    const r: Recipient = { staffId: s.id, userId: s.user_id, name: s.full_name, email }
    if (!email) {
      noEmail.push(r)
      continue
    }
    if (seen.has(email)) continue // 重複メールは1通に
    seen.add(email)
    recipients.push(r)
  }
  return { recipients, noEmail }
}

function subjectOf(ann: AnnRow): string {
  const prefix = ann.importance === 'urgent' ? '［緊急］' : ann.importance === 'important' ? '［重要］' : ''
  return `${prefix}${ann.title}`
}

function bodyOf(ann: AnnRow): string {
  const excerpt = ann.body.length > 200 ? `${ann.body.slice(0, 200)}…` : ann.body
  return [
    ann.title,
    '',
    excerpt,
    '',
    `▼ 掲示板で全文を見る`,
    `${BOARD_URL_BASE}/${ann.id}`,
    '',
    '— SHIN勤怠 掲示板からの自動送信です。',
  ].join('\n')
}

export interface SendMailResult {
  sent: number
  failed: number
  skipped: number // メールアドレス未登録
  total: number
}

/** お知らせを宛先範囲のスタッフへメール配信し、結果を email_deliveries に記録する */
export const sendAnnouncementMail = createServerFn({ method: 'POST' })
  .inputValidator((d: { announcement_id: string }) => {
    assert(typeof d.announcement_id === 'string' && d.announcement_id, '投稿が指定されていません。')
    return d
  })
  .handler(async ({ data }): Promise<SendMailResult> => {
    const caller = await requireCaller()
    const admin = getAdminClient()
    const ann = await loadManageableAnnouncement(admin, caller, data.announcement_id)

    const { recipients, noEmail } = await resolveRecipients(admin, ann)

    const subject = subjectOf(ann)
    const text = bodyOf(ann)
    const nowIso = () => new Date().toISOString()

    type DeliveryRow = {
      announcement_id: string
      user_id: string | null
      email: string
      status: 'sent' | 'failed'
      sent_at: string | null
      error: string | null
    }
    const rows: DeliveryRow[] = []

    let sent = 0
    let failed = 0
    // 件数が少ない前提の逐次送信（Resend のレート内）。失敗しても残りは続行
    for (const r of recipients) {
      const result = await sendMail(r.email, subject, text)
      if (result.ok) {
        sent++
        rows.push({
          announcement_id: ann.id,
          user_id: r.userId,
          email: r.email,
          status: 'sent',
          sent_at: nowIso(),
          error: null,
        })
      } else {
        failed++
        rows.push({
          announcement_id: ann.id,
          user_id: r.userId,
          email: r.email,
          status: 'failed',
          sent_at: null,
          error: result.error ?? '送信に失敗しました',
        })
      }
    }

    // メールアドレス未登録のスタッフもログとして残す（email は空文字・failed 扱い）
    for (const r of noEmail) {
      rows.push({
        announcement_id: ann.id,
        user_id: r.userId,
        email: '',
        status: 'failed',
        sent_at: null,
        error: 'メールアドレス未登録',
      })
    }

    if (rows.length > 0) {
      const { error: insErr } = await admin.from('email_deliveries').insert(rows)
      // 記録失敗は送信自体を巻き戻せないため、エラーにせずコンソールに残す
      if (insErr) console.error('email_deliveries insert failed:', insErr.message)
    }

    return { sent, failed, skipped: noEmail.length, total: recipients.length + noEmail.length }
  })

export interface DeliveryStatus {
  delivered: boolean
  sent: number
  failed: number
  lastAt: string | null
}

/** 配信状況（管理できる人のみ）。email_deliveries を集計して返す */
export const getAnnouncementDeliveries = createServerFn({ method: 'POST' })
  .inputValidator((d: { announcement_id: string }) => {
    assert(typeof d.announcement_id === 'string' && d.announcement_id, '投稿が指定されていません。')
    return d
  })
  .handler(async ({ data }): Promise<DeliveryStatus> => {
    const caller = await requireCaller()
    const admin = getAdminClient()
    await loadManageableAnnouncement(admin, caller, data.announcement_id)

    const { data: rows, error } = await admin
      .from('email_deliveries')
      .select('status, sent_at')
      .eq('announcement_id', data.announcement_id)
    assert(!error, '配信状況の取得に失敗しました。')

    const list = rows ?? []
    const sent = list.filter((r) => r.status === 'sent').length
    const failed = list.filter((r) => r.status === 'failed').length
    const lastAt = list
      .map((r) => r.sent_at)
      .filter((t): t is string => !!t)
      .sort()
      .pop()

    return { delivered: list.length > 0, sent, failed, lastAt: lastAt ?? null }
  })
