import { useQuery } from '@tanstack/react-query'
import { getSupabase } from '@/lib/auth/supabase-client'
import { pgErrorToJa } from '@/lib/errors'
import { useAuth } from '@/lib/auth'
import { useMe } from '@/lib/me-context'

/**
 * 掲示板（announcements）のデータ層。通常セッション + RLS のみ（service_role 不使用）。
 * - 閲覧は ann_sel（app_announcement_visible）。ここで返るのは「自分に見える投稿」だけ
 * - 投稿は ann_ins（announce_post。all/kinds は owner のみ）
 * - 編集・論理削除は ann_upd（投稿者本人 or announce_post∧対象店舗の管理者。削除済みは不可）
 * - 宛先は join テーブル（announcement_stores / announcement_kinds）。越権は RLS が最終防壁
 * - email_deliveries はフェーズβまで触らない
 */

export type Importance = 'normal' | 'important' | 'urgent'
export type ScopeType = 'all' | 'stores' | 'kinds' | 'stores_and_kinds'

export const IMPORTANCE_LABEL: Record<Importance, string> = {
  normal: '通常',
  important: '重要',
  urgent: '緊急',
}

export interface AnnouncementRow {
  id: string
  author: string | null
  authorName: string | null
  title: string
  body: string
  importance: Importance
  scope_type: ScopeType
  created_at: string
  updated_at: string
  targetStoreIds: string[]
  targetKindIds: string[]
}

/** RLS違反を掲示板の文脈の日本語にする */
export function annErrText(e: unknown, fallback = '処理に失敗しました'): string {
  if (e instanceof Error) {
    const msg = e.message ?? ''
    const code = 'code' in e ? (e as { code?: string }).code : undefined
    if (code === '42501' || /row-level security/i.test(msg)) {
      return '権限がありません。掲示板への投稿・編集には掲示板権限（announce_post）と対象店舗の管理権限が必要です。'
    }
    return pgErrorToJa(e, fallback)
  }
  return fallback
}

/** 自分に見えるお知らせ一覧（新しい順）。宛先と投稿者名も解決して返す */
export async function fetchAnnouncements(tenantId: string): Promise<AnnouncementRow[]> {
  const supabase = await getSupabase()
  const { data, error } = await supabase
    .from('announcements')
    .select(
      'id, author, title, body, importance, scope_type, created_at, updated_at, announcement_stores(store_id), announcement_kinds(employment_kind_id)',
    )
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
  if (error) throw error

  const rows = data ?? []

  // 投稿者名は staff.user_id 経由で解決（見つからなければ「管理者」表示は画面側）
  const authorIds = [...new Set(rows.map((r) => r.author).filter((a): a is string => !!a))]
  const nameByUser = new Map<string, string>()
  if (authorIds.length > 0) {
    const { data: st } = await supabase
      .from('staff')
      .select('user_id, full_name')
      .eq('tenant_id', tenantId)
      .in('user_id', authorIds)
    for (const s of st ?? []) {
      if (s.user_id) nameByUser.set(s.user_id, s.full_name)
    }
  }

  return rows.map((r) => ({
    id: r.id,
    author: r.author,
    authorName: r.author ? (nameByUser.get(r.author) ?? null) : null,
    title: r.title,
    body: r.body,
    importance: r.importance as Importance,
    scope_type: r.scope_type as ScopeType,
    created_at: r.created_at,
    updated_at: r.updated_at,
    targetStoreIds: (r.announcement_stores ?? []).map((s) => s.store_id),
    targetKindIds: (r.announcement_kinds ?? []).map((k) => k.employment_kind_id),
  }))
}

/** 自分が既読にした announcement_id の一覧 */
export async function fetchMyReadIds(userId: string): Promise<Set<string>> {
  const supabase = await getSupabase()
  const { data, error } = await supabase
    .from('announcement_reads')
    .select('announcement_id')
    .eq('user_id', userId)
  if (error) throw error
  return new Set((data ?? []).map((r) => r.announcement_id))
}

/** 既読を記録（本人∧可視のみ RLS が許可）。二重記録は握りつぶす */
export async function markRead(announcementId: string, userId: string): Promise<void> {
  const supabase = await getSupabase()
  const { error } = await supabase
    .from('announcement_reads')
    .upsert(
      { announcement_id: announcementId, user_id: userId },
      { onConflict: 'announcement_id,user_id', ignoreDuplicates: true },
    )
  if (error) throw error
}

export interface AnnouncementDraft {
  title: string
  body: string
  importance: Importance
  scopeType: ScopeType
  storeIds: string[]
  kindIds: string[]
}

function validateDraft(d: AnnouncementDraft): void {
  if (!d.title.trim()) throw new Error('タイトルを入力してください。')
  if (!d.body.trim()) throw new Error('本文を入力してください。')
  const needsStores = d.scopeType === 'stores' || d.scopeType === 'stores_and_kinds'
  const needsKinds = d.scopeType === 'kinds' || d.scopeType === 'stores_and_kinds'
  if (needsStores && d.storeIds.length === 0) throw new Error('対象の店舗を選んでください。')
  if (needsKinds && d.kindIds.length === 0) throw new Error('対象の雇用区分を選んでください。')
}

/** 宛先 join 行の insert（scope に応じて必要な分だけ） */
async function insertTargets(
  announcementId: string,
  scopeType: ScopeType,
  storeIds: string[],
  kindIds: string[],
): Promise<void> {
  const supabase = await getSupabase()
  if (scopeType === 'stores' || scopeType === 'stores_and_kinds') {
    const { error } = await supabase
      .from('announcement_stores')
      .insert(storeIds.map((store_id) => ({ announcement_id: announcementId, store_id })))
    if (error) throw error
  }
  if (scopeType === 'kinds' || scopeType === 'stores_and_kinds') {
    const { error } = await supabase
      .from('announcement_kinds')
      .insert(
        kindIds.map((employment_kind_id) => ({
          announcement_id: announcementId,
          employment_kind_id,
        })),
      )
    if (error) throw error
  }
}

/** 投稿作成。本体 → 宛先の順に insert。宛先で失敗したら本体を論理削除して原因を投げ直す */
export async function createAnnouncement(
  tenantId: string,
  authorId: string,
  d: AnnouncementDraft,
): Promise<void> {
  validateDraft(d)
  const supabase = await getSupabase()
  // RETURNING（insert().select()）は ann_sel の評価対象になり、可視性ヘルパーが
  // 同一ステートメント内の挿入行を参照できず失敗する。id はクライアント生成で回避する。
  const id = crypto.randomUUID()
  const { error } = await supabase.from('announcements').insert({
    id,
    tenant_id: tenantId,
    author: authorId,
    title: d.title.trim(),
    body: d.body.trim(),
    importance: d.importance,
    scope_type: d.scopeType,
  })
  if (error) throw error

  try {
    await insertTargets(id, d.scopeType, d.storeIds, d.kindIds)
  } catch (e) {
    // 宛先なしの投稿を残さない（本体は論理削除。失敗しても元エラーを優先）
    await supabase
      .from('announcements')
      .update({ deleted_at: new Date().toISOString(), deleted_by: authorId })
      .eq('id', id)
    throw e
  }
}

/** 編集。本体を更新し、宛先は差分で付け替える */
export async function updateAnnouncement(
  id: string,
  d: AnnouncementDraft,
  prev: { storeIds: string[]; kindIds: string[] },
): Promise<void> {
  validateDraft(d)
  const supabase = await getSupabase()
  const { data: updated, error } = await supabase
    .from('announcements')
    .update({
      title: d.title.trim(),
      body: d.body.trim(),
      importance: d.importance,
      scope_type: d.scopeType,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select('id')
  if (error) throw error
  if (!updated || updated.length === 0) {
    throw new Error('この投稿を編集する権限がないか、すでに削除されています。')
  }

  const wantStores =
    d.scopeType === 'stores' || d.scopeType === 'stores_and_kinds' ? d.storeIds : []
  const wantKinds = d.scopeType === 'kinds' || d.scopeType === 'stores_and_kinds' ? d.kindIds : []

  const delStores = prev.storeIds.filter((s) => !wantStores.includes(s))
  const addStores = wantStores.filter((s) => !prev.storeIds.includes(s))
  const delKinds = prev.kindIds.filter((k) => !wantKinds.includes(k))
  const addKinds = wantKinds.filter((k) => !prev.kindIds.includes(k))

  if (delStores.length > 0) {
    const { error: e } = await supabase
      .from('announcement_stores')
      .delete()
      .eq('announcement_id', id)
      .in('store_id', delStores)
    if (e) throw e
  }
  if (delKinds.length > 0) {
    const { error: e } = await supabase
      .from('announcement_kinds')
      .delete()
      .eq('announcement_id', id)
      .in('employment_kind_id', delKinds)
    if (e) throw e
  }
  if (addStores.length > 0) {
    const { error: e } = await supabase
      .from('announcement_stores')
      .insert(addStores.map((store_id) => ({ announcement_id: id, store_id })))
    if (e) throw e
  }
  if (addKinds.length > 0) {
    const { error: e } = await supabase
      .from('announcement_kinds')
      .insert(addKinds.map((employment_kind_id) => ({ announcement_id: id, employment_kind_id })))
    if (e) throw e
  }
}

/** 論理削除（deleted_at/deleted_by）。復元不可（RLSで削除済みは編集も閲覧も不可） */
export async function deleteAnnouncement(id: string, userId: string): Promise<void> {
  const supabase = await getSupabase()
  const { data, error } = await supabase
    .from('announcements')
    .update({ deleted_at: new Date().toISOString(), deleted_by: userId })
    .eq('id', id)
    .select('id')
  if (error) throw error
  if (!data || data.length === 0) {
    throw new Error('この投稿を削除する権限がないか、すでに削除されています。')
  }
}

/**
 * 未読件数（ナビバッジ用）。可視な投稿 − 既読。
 * バッジは補助表示なので、取得失敗時は 0 を返して画面を止めない。
 */
export function useUnreadAnnouncements() {
  const { me } = useMe()
  const { user } = useAuth()
  return useQuery({
    queryKey: ['ann_unread', me?.tenantId, user?.id],
    enabled: !!me && !!user,
    staleTime: 60_000,
    queryFn: async (): Promise<number> => {
      const supabase = await getSupabase()
      const [a, r] = await Promise.all([
        supabase
          .from('announcements')
          .select('id')
          .eq('tenant_id', me!.tenantId)
          .is('deleted_at', null),
        supabase.from('announcement_reads').select('announcement_id').eq('user_id', user!.id),
      ])
      if (a.error || r.error) return 0
      const read = new Set((r.data ?? []).map((x) => x.announcement_id))
      return (a.data ?? []).filter((x) => !read.has(x.id)).length
    },
  })
}
