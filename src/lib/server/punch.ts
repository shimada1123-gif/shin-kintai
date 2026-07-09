// createServerFn の handler 本体はクライアントバンドルから除去され、RPC スタブだけが残る。
// service_role と QR_DISPLAY_SECRET は *.server.ts 側にあり、handler の中でしか触らない。
import { createServerFn } from '@tanstack/react-start'
import { getAdminClient } from '@/lib/supabase-admin.server'
import { generateToken, signStoreId, verifyStoreSig } from '@/lib/qr-secret.server'
import { requireCaller } from './caller'
import { assert } from './permissions'

const TOKEN_TTL_SEC = 60

export type PunchKind = 'clock_in' | 'clock_out' | 'break_start' | 'break_end'
export type GpsStatus = 'ok' | 'unverified' | 'out'

/* ------------------------------------------------------------------ */
/* 距離計算                                                            */
/* ------------------------------------------------------------------ */

/** 2点間の距離（メートル）。ハーバサイン。 */
function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371e3
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

/* ------------------------------------------------------------------ */
/* 1. 据置ページのURL署名（オーナー/店長がURLを発行する）                */
/* ------------------------------------------------------------------ */

export const issueDisplayUrl = createServerFn({ method: 'POST' })
  .inputValidator((d: { store_id: string }) => {
    assert(d.store_id, '店舗が指定されていません。')
    return d
  })
  .handler(async ({ data }): Promise<{ path: string }> => {
    const caller = await requireCaller()
    const admin = getAdminClient()

    // 自テナントの店舗であること、かつ管理権限のある役割であることを確認
    assert(caller.role !== 'staff', '据置QRのURLを発行する権限がありません。')

    const { data: store } = await admin
      .from('stores')
      .select('id, tenant_id, area_id')
      .eq('id', data.store_id)
      .maybeSingle()
    assert(store && store.tenant_id === caller.tenantId, '店舗が見つかりません。')

    if (caller.role === 'area_manager') {
      assert(store.area_id === caller.scopeAreaId, '自分のエリア外の店舗です。')
    }
    if (caller.role === 'store_manager') {
      assert(store.id === caller.scopeStoreId, '自分の店舗以外は指定できません。')
    }

    const sig = await signStoreId(data.store_id)
    return { path: `/display/${data.store_id}?sig=${sig}` }
  })

/* ------------------------------------------------------------------ */
/* 2. 据置ページからのワンタイムQR発行（ログイン不要・署名で認可）        */
/* ------------------------------------------------------------------ */

const PUNCH_KINDS: PunchKind[] = ['clock_in', 'break_start', 'break_end', 'clock_out']

/**
 * モデルB: 店舗端末が種別ボタンを押すたびに1枚だけ発行する。
 * kind はここで確定してトークン側に持たせる（クライアント送信の kind は以後信用しない）。
 */
export const issuePunchToken = createServerFn({ method: 'POST' })
  .inputValidator((d: { store_id: string; kind: PunchKind; sig: string }) => {
    assert(d.store_id && d.sig, 'パラメータが不足しています。')
    assert(PUNCH_KINDS.includes(d.kind), '不正な打刻種別です。')
    return d
  })
  .handler(
    async ({
      data,
    }): Promise<{ token: string; expires_at: string; store_name: string; kind: PunchKind }> => {
      // ログイン不要。認可は HMAC 署名のみ（定数時間比較）。
      const valid = await verifyStoreSig(data.store_id, data.sig)
      assert(valid, 'この表示URLは無効です。管理画面から発行し直してください。')

      const admin = getAdminClient()

      const { data: store } = await admin
        .from('stores')
        .select('id, name')
        .eq('id', data.store_id)
        .maybeSingle()
      assert(store, '店舗が見つかりません。')

      // 掃除：期限切れ・使用済みのトークン（この店舗ぶんのみ）
      const nowIso = new Date().toISOString()
      await admin.from('qr_tokens').delete().eq('store_id', data.store_id).lt('expires_at', nowIso)
      await admin
        .from('qr_tokens')
        .delete()
        .eq('store_id', data.store_id)
        .not('used_at', 'is', null)

      const token = generateToken()
      const expiresAt = new Date(Date.now() + TOKEN_TTL_SEC * 1000).toISOString()

      const { error } = await admin.from('qr_tokens').insert({
        store_id: data.store_id,
        token,
        kind: data.kind,
        expires_at: expiresAt,
        used_at: null,
      })
      assert(!error, 'トークンを発行できませんでした。')

      return { token, expires_at: expiresAt, store_name: store.name, kind: data.kind }
    },
  )

/* ------------------------------------------------------------------ */
/* 3. 打刻                                                             */
/* ------------------------------------------------------------------ */

export interface PunchInput {
  token: string
  // kind はクライアントから受けない。トークンに紐づく kind（issuePunchToken で確定）のみを信用する。
  gps_lat?: number | null
  gps_lng?: number | null
}

export interface PunchResult {
  kind: PunchKind
  gps_status: GpsStatus
  store_name: string
  at: string
  message: string
}

const USED_OR_EXPIRED_MSG =
  'このQRは使用済みか期限切れです。店舗端末で新しいQRを出してください。'

export const punch = createServerFn({ method: 'POST' })
  .inputValidator((d: PunchInput) => {
    assert(d.token, 'QRコードを読み取ってください。')
    return d
  })
  .handler(async ({ data }): Promise<PunchResult> => {
    // (a) 呼び出し元を Bearer から確定する（user_id の自己申告は信用しない）
    const caller = await requireCaller()
    const admin = getAdminClient()

    // (b) トークン照合：存在・未使用・未失効。kind はここ（=トークン由来）で確定する
    const { data: qr } = await admin
      .from('qr_tokens')
      .select('id, store_id, kind, expires_at, used_at')
      .eq('token', data.token)
      .maybeSingle()
    assert(qr, 'QRコードが無効です。店舗端末で新しいQRを出してください。')
    assert(!qr.used_at, USED_OR_EXPIRED_MSG)
    assert(new Date(qr.expires_at).getTime() > Date.now(), USED_OR_EXPIRED_MSG)
    assert(
      qr.kind && PUNCH_KINDS.includes(qr.kind as PunchKind),
      '種別のないQRです。店舗端末で新しいQRを出してください。',
    )
    const kind = qr.kind as PunchKind

    const storeId = qr.store_id

    const { data: store } = await admin
      .from('stores')
      .select('id, tenant_id, name, lat, lng, geofence_radius_m, gps_policy')
      .eq('id', storeId)
      .maybeSingle()
    assert(store, '店舗が見つかりません。')
    assert(store.tenant_id === caller.tenantId, '所属外の店舗のQRコードです。')

    // (c) 本人の staff を解決
    const { data: membership } = await admin
      .from('memberships')
      .select('staff_id')
      .eq('user_id', caller.userId)
      .maybeSingle()
    assert(
      membership?.staff_id,
      'このアカウントにスタッフ情報が紐付いていません。管理者に連絡してください。',
    )
    const staffId = membership.staff_id

    // (d) その店舗に所属しているか
    const { data: assignment } = await admin
      .from('staff_assignments')
      .select('id, is_active, employment_kind_id')
      .eq('staff_id', staffId)
      .eq('store_id', storeId)
      .maybeSingle()
    assert(assignment, 'この店舗に所属していないため打刻できません。')
    assert(assignment.is_active, 'この店舗での所属が無効になっています。')

    // (e) 業務委託（requires_clock=false）は打刻できない
    if (assignment.employment_kind_id) {
      const { data: kind } = await admin
        .from('employment_kinds')
        .select('label, requires_clock')
        .eq('id', assignment.employment_kind_id)
        .maybeSingle()
      if (kind && !kind.requires_clock) {
        throw new Error(
          `${kind.label} は打刻の対象外です。稼働は自己申告・請求書ベースで提出してください。`,
        )
      }
    }

    // (f) GPS 判定（block はここで throw = トークン未消費のまま）
    const gpsStatus = resolveGpsStatus(store, data.gps_lat ?? null, data.gps_lng ?? null)

    const now = new Date().toISOString()

    // (g) 状態の検証のみ先に行う。ここまでのどの失敗でもトークンは消費されない。
    const { data: openRow } = await admin
      .from('attendance')
      .select('id')
      .eq('staff_id', staffId)
      .eq('store_id', storeId)
      .eq('is_demo', false)
      .is('clock_out_at', null)
      .order('clock_in_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    let openBreak: { id: string } | null = null
    if (openRow) {
      const { data: ob } = await admin
        .from('attendance_breaks')
        .select('id')
        .eq('attendance_id', openRow.id)
        .is('break_end_at', null)
        .order('break_start_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      openBreak = ob
    }

    if (kind === 'clock_in') {
      assert(!openRow, 'すでに出勤中です。退勤してから再度出勤してください。')
    } else {
      assert(openRow, '出勤の記録がありません。店舗端末で「出勤」のQRを出してください。')
      if (kind === 'break_start') assert(!openBreak, 'すでに休憩中です。')
      if (kind === 'break_end') assert(openBreak, '休憩が開始されていません。')
      if (kind === 'clock_out')
        assert(!openBreak, '休憩中は退勤できません。先に休憩を終了してください。')
    }

    // (h) atomic 消費：未使用かつ未失効の行だけを条件付き UPDATE。
    //     行ロックにより2人同時は1人だけ更新でき、0件なら他者が先に消費した。
    //     全検証を通過した後に置くので、検証失敗ではトークンを浪費しない。
    const { data: consumed, error: consumeErr } = await admin
      .from('qr_tokens')
      .update({ used_at: now, used_by: staffId })
      .eq('id', qr.id)
      .is('used_at', null)
      .gt('expires_at', now)
      .select('id')
    assert(!consumeErr, '打刻を処理できませんでした。もう一度お試しください。')
    assert(consumed && consumed.length === 1, USED_OR_EXPIRED_MSG)

    // (i) 書き込み。消費済みなので同じQRでの二重打刻はもう起きない。
    let message: string

    if (kind === 'clock_in') {
      const { error } = await admin.from('attendance').insert({
        tenant_id: caller.tenantId,
        staff_id: staffId,
        store_id: storeId,
        clock_in_at: now,
        source: 'qr',
        gps_lat: data.gps_lat ?? null,
        gps_lng: data.gps_lng ?? null,
        gps_status: gpsStatus,
        is_demo: false,
      })
      assert(!error, '出勤を記録できませんでした。店舗端末で新しいQRを出してください。')
      message = '出勤を記録しました。'
    } else if (kind === 'break_start') {
      const { error } = await admin
        .from('attendance_breaks')
        .insert({ attendance_id: openRow!.id, break_start_at: now })
      assert(!error, '休憩の開始を記録できませんでした。店舗端末で新しいQRを出してください。')
      message = '休憩を開始しました。'
    } else if (kind === 'break_end') {
      const { error } = await admin
        .from('attendance_breaks')
        .update({ break_end_at: now })
        .eq('id', openBreak!.id)
      assert(!error, '休憩の終了を記録できませんでした。店舗端末で新しいQRを出してください。')
      message = '休憩を終了しました。'
    } else {
      const { error } = await admin
        .from('attendance')
        .update({
          clock_out_at: now,
          gps_lat: data.gps_lat ?? null,
          gps_lng: data.gps_lng ?? null,
          gps_status: gpsStatus,
        })
        .eq('id', openRow!.id)
      assert(!error, '退勤を記録できませんでした。店舗端末で新しいQRを出してください。')
      message = '退勤を記録しました。'
    }

    return { kind, gps_status: gpsStatus, store_name: store.name, at: now, message }
  })

/**
 * GPS ポリシーの判定。block のときだけ打刻を止める。
 *  off   : 位置を見ない → 常に ok
 *  flag  : 記録する。圏内 ok / 圏外 out / 未取得 unverified（いずれも打刻は通す）
 *  block : 圏内 ok のみ。圏外・未取得は拒否
 */
function resolveGpsStatus(
  store: { lat: number | null; lng: number | null; geofence_radius_m: number; gps_policy: string },
  lat: number | null,
  lng: number | null,
): GpsStatus {
  if (store.gps_policy === 'off') return 'ok'

  const hasFix = lat !== null && lng !== null
  const hasStoreCoord = store.lat !== null && store.lng !== null

  if (!hasFix || !hasStoreCoord) {
    if (store.gps_policy === 'block') {
      throw new Error(
        '位置情報を取得できないため打刻できません。位置情報を許可して、もう一度お試しください。',
      )
    }
    return 'unverified'
  }

  const distance = distanceMeters(lat, lng, store.lat!, store.lng!)
  const inside = distance <= store.geofence_radius_m

  if (inside) return 'ok'

  if (store.gps_policy === 'block') {
    throw new Error(
      `店舗から約${Math.round(distance)}m 離れています。店舗の近く（${store.geofence_radius_m}m 以内）で打刻してください。`,
    )
  }
  return 'out'
}

/* ------------------------------------------------------------------ */
/* 4. 本人の当日勤怠                                                    */
/* ------------------------------------------------------------------ */

export interface TodayAttendance {
  id: string
  store_name: string
  clock_in_at: string
  clock_out_at: string | null
  gps_status: string
  breaks: { id: string; break_start_at: string; break_end_at: string | null }[]
}

export const myAttendanceToday = createServerFn({ method: 'GET' }).handler(
  async (): Promise<TodayAttendance[]> => {
    const caller = await requireCaller()
    const admin = getAdminClient()

    const { data: membership } = await admin
      .from('memberships')
      .select('staff_id')
      .eq('user_id', caller.userId)
      .maybeSingle()
    if (!membership?.staff_id) return []

    // 当日は店舗のタイムゾーン（Asia/Tokyo）基準。深夜跨ぎを拾うため 18 時間前から見る。
    const since = new Date(Date.now() - 18 * 60 * 60 * 1000).toISOString()

    const { data, error } = await admin
      .from('attendance')
      .select(
        'id, clock_in_at, clock_out_at, gps_status, store_id, stores (name), attendance_breaks (id, break_start_at, break_end_at)',
      )
      .eq('staff_id', membership.staff_id)
      .eq('is_demo', false)
      .gte('clock_in_at', since)
      .order('clock_in_at', { ascending: false })

    assert(!error, '本日の勤怠を取得できませんでした。')

    return (data ?? []).map((a) => ({
      id: a.id,
      store_name: (a.stores as { name: string } | null)?.name ?? '',
      clock_in_at: a.clock_in_at,
      clock_out_at: a.clock_out_at,
      gps_status: a.gps_status,
      breaks: (a.attendance_breaks ?? []) as TodayAttendance['breaks'],
    }))
  },
)

/* ------------------------------------------------------------------ */
/* 5. テストモード専用（デモ打刻 / 一括削除）                            */
/* ------------------------------------------------------------------ */

/** demo_manage 権限 かつ tenants.settings.test_mode=true を要求する。RLS でも同条件を課す（二層）。 */
async function requireDemoMode(callerTenantId: string, callerUserId: string) {
  const admin = getAdminClient()

  const { data: tenant } = await admin
    .from('tenants')
    .select('settings')
    .eq('id', callerTenantId)
    .maybeSingle()
  const settings = (tenant?.settings ?? {}) as { test_mode?: boolean }
  assert(settings.test_mode === true, 'テストモードが有効ではありません。設定から有効にしてください。')

  const { data: membership } = await admin
    .from('memberships')
    .select('role')
    .eq('user_id', callerUserId)
    .maybeSingle()
  assert(membership, 'membership がありません。')

  if (membership.role === 'owner') return // owner は常時フル

  const { data: perm } = await admin
    .from('role_permissions')
    .select('allowed')
    .eq('tenant_id', callerTenantId)
    .eq('role', membership.role)
    .eq('permission_key', 'demo_manage')
    .maybeSingle()
  assert(perm?.allowed === true, 'デモ打刻を操作する権限がありません。')
}

export const demoPunch = createServerFn({ method: 'POST' })
  .inputValidator((d: { store_id: string; staff_id: string; kind: PunchKind }) => {
    assert(d.store_id && d.staff_id, '店舗とスタッフを指定してください。')
    assert(
      ['clock_in', 'clock_out', 'break_start', 'break_end'].includes(d.kind),
      '不正な打刻種別です。',
    )
    return d
  })
  .handler(async ({ data }): Promise<{ message: string }> => {
    const caller = await requireCaller()
    await requireDemoMode(caller.tenantId, caller.userId)

    const admin = getAdminClient()
    const now = new Date().toISOString()

    const { data: openRow } = await admin
      .from('attendance')
      .select('id')
      .eq('staff_id', data.staff_id)
      .eq('store_id', data.store_id)
      .eq('is_demo', true)
      .is('clock_out_at', null)
      .order('clock_in_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (data.kind === 'clock_in') {
      assert(!openRow, 'このスタッフはデモ出勤中です。')
      const { error } = await admin.from('attendance').insert({
        tenant_id: caller.tenantId,
        staff_id: data.staff_id,
        store_id: data.store_id,
        clock_in_at: now,
        source: 'demo',
        gps_status: 'ok', // デモは位置検証をしない
        is_demo: true,
      })
      assert(!error, 'デモ出勤を記録できませんでした。')
      return { message: 'デモ出勤を記録しました。' }
    }

    assert(openRow, 'デモの出勤記録がありません。')

    const { data: openBreak } = await admin
      .from('attendance_breaks')
      .select('id')
      .eq('attendance_id', openRow.id)
      .is('break_end_at', null)
      .limit(1)
      .maybeSingle()

    if (data.kind === 'break_start') {
      assert(!openBreak, 'すでにデモ休憩中です。')
      const { error } = await admin
        .from('attendance_breaks')
        .insert({ attendance_id: openRow.id, break_start_at: now })
      assert(!error, 'デモ休憩を開始できませんでした。')
      return { message: 'デモ休憩を開始しました。' }
    }
    if (data.kind === 'break_end') {
      assert(openBreak, 'デモ休憩が開始されていません。')
      const { error } = await admin
        .from('attendance_breaks')
        .update({ break_end_at: now })
        .eq('id', openBreak.id)
      assert(!error, 'デモ休憩を終了できませんでした。')
      return { message: 'デモ休憩を終了しました。' }
    }

    assert(!openBreak, '休憩中は退勤できません。')
    const { error } = await admin
      .from('attendance')
      .update({ clock_out_at: now })
      .eq('id', openRow.id)
    assert(!error, 'デモ退勤を記録できませんでした。')
    return { message: 'デモ退勤を記録しました。' }
  })

export const clearDemo = createServerFn({ method: 'POST' })
  .inputValidator((d: { store_id?: string }) => d)
  .handler(async ({ data }): Promise<{ deleted: number }> => {
    const caller = await requireCaller()
    await requireDemoMode(caller.tenantId, caller.userId)

    const admin = getAdminClient()
    let query = admin
      .from('attendance')
      .delete({ count: 'exact' })
      .eq('tenant_id', caller.tenantId)
      .eq('is_demo', true)

    if (data.store_id) query = query.eq('store_id', data.store_id)

    const { count, error } = await query
    assert(!error, 'デモ打刻を削除できませんでした。')
    return { deleted: count ?? 0 }
  })
