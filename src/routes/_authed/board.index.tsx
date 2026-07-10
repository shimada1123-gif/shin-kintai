import { useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/lib/auth'
import { useMe, type MeContext } from '@/lib/me-context'
import { usePermissions } from '@/lib/perm'
import { errText } from '@/lib/errors'
import { fetchEmploymentKinds, type EmploymentKind } from '@/lib/queries/master'
import {
  IMPORTANCE_LABEL,
  annErrText,
  createAnnouncement,
  deleteAnnouncement,
  fetchAnnouncements,
  fetchMyReadIds,
  markRead,
  updateAnnouncement,
  type AnnouncementRow,
  type Importance,
  type ScopeType,
} from '@/lib/queries/announcements'
import {
  getAnnouncementDeliveries,
  sendAnnouncementMail,
} from '@/lib/server/announce-mail'

export const Route = createFileRoute('/_authed/board/')({
  component: BoardPage,
})

const SCOPE_OPTIONS: { key: ScopeType; label: string; ownerOnly: boolean }[] = [
  { key: 'all', label: '全体', ownerOnly: true },
  { key: 'stores', label: '店舗別', ownerOnly: false },
  { key: 'kinds', label: '区分別', ownerOnly: true },
  { key: 'stores_and_kinds', label: '店舗×区分', ownerOnly: false },
]

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('ja-JP', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
  })
}

/** 宛先の表示（店舗名は me.stores で解決。RLS外の店舗は「他店舗」） */
function targetLabel(a: AnnouncementRow, me: MeContext, kinds: EmploymentKind[]): string {
  if (a.scope_type === 'all') return '全体'
  const storeNames = [
    ...new Set(a.targetStoreIds.map((id) => me.stores.find((s) => s.id === id)?.name ?? '他店舗')),
  ]
  const kindNames = a.targetKindIds.map((id) => kinds.find((k) => k.id === id)?.label ?? '不明な区分')
  if (a.scope_type === 'stores') return storeNames.join('・')
  if (a.scope_type === 'kinds') return kindNames.join('・')
  return `${storeNames.join('・')} の ${kindNames.join('・')}`
}

function BoardPage() {
  const { me } = useMe()
  const { user } = useAuth()
  const { has } = usePermissions()
  const qc = useQueryClient()

  const [detail, setDetail] = useState<AnnouncementRow | null>(null)
  const [editing, setEditing] = useState<AnnouncementRow | 'new' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  const listQ = useQuery({
    queryKey: ['announcements', me?.tenantId],
    enabled: !!me,
    queryFn: () => fetchAnnouncements(me!.tenantId),
  })
  const readsQ = useQuery({
    queryKey: ['ann_reads', user?.id],
    enabled: !!user,
    queryFn: () => fetchMyReadIds(user!.id),
  })
  const kindsQ = useQuery({
    queryKey: ['ek_master', me?.tenantId],
    enabled: !!me,
    queryFn: fetchEmploymentKinds,
  })

  const invalidateAll = () => {
    void qc.invalidateQueries({ queryKey: ['announcements'] })
    void qc.invalidateQueries({ queryKey: ['ann_reads'] })
    void qc.invalidateQueries({ queryKey: ['ann_unread'] })
  }

  const readMut = useMutation({
    mutationFn: (id: string) => markRead(id, user!.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['ann_reads'] })
      void qc.invalidateQueries({ queryKey: ['ann_unread'] })
    },
    // 既読の記録失敗は画面を止めない（次回開いたとき再試行される）
    onError: () => undefined,
  })

  const delMut = useMutation({
    mutationFn: (id: string) => deleteAnnouncement(id),
    onSuccess: () => {
      invalidateAll()
      setDetail(null)
    },
    onError: (e) => setError(annErrText(e, '削除できませんでした')),
  })

  if (!me || !user) return null

  const canPost = has('announce_post')
  const readSet = readsQ.data ?? new Set<string>()
  const kinds = kindsQ.data ?? []

  const openDetail = (a: AnnouncementRow) => {
    setError(null)
    setDetail(a)
    if (!readSet.has(a.id)) readMut.mutate(a.id)
  }

  /** 編集・削除ボタンの出し分け（最終判定は RLS） */
  const canManage = (a: AnnouncementRow): boolean =>
    me.role === 'owner' || a.author === user.id || canPost

  return (
    <section>
      <div className="eyebrow">掲示板 · お知らせ</div>
      <div className="page-h">
        <h1>掲示板</h1>
        <span className="desc">あなた宛のお知らせが新しい順に並びます。</span>
        {canPost && (
          <button
            className="btn pri board-new-btn"
            onClick={() => {
              setError(null)
              setInfo(null)
              setEditing('new')
            }}
          >
            ＋ お知らせを作成
          </button>
        )}
      </div>

      {/* 詳細モーダルを開いている間はモーダル内に出す（背後に隠れて見えないため） */}
      {error && !detail && (
        <p className="login-error" role="alert">
          {error}
        </p>
      )}
      {info && (
        <p className="board-info" role="status">
          {info}
        </p>
      )}

      {listQ.isPending && <p className="note">読み込み中…</p>}
      {listQ.error && (
        <p className="login-error" role="alert">
          {errText(listQ.error, 'お知らせの取得に失敗しました')}
        </p>
      )}

      {listQ.data && listQ.data.length === 0 && <p className="note">お知らせはありません。</p>}

      {listQ.data && listQ.data.length > 0 && (
        <div className="board-list">
          {listQ.data.map((a) => {
            const unread = !readSet.has(a.id)
            return (
              <button
                key={a.id}
                type="button"
                className={`board-item${unread ? ' is-unread' : ''}`}
                onClick={() => openDetail(a)}
              >
                <div className="board-item-top">
                  {unread && <span className="unread-dot" aria-label="未読" />}
                  <span className={`badge imp-${a.importance}`}>
                    {IMPORTANCE_LABEL[a.importance]}
                  </span>
                  <b className="board-title">{a.title}</b>
                </div>
                <div className="board-meta">
                  <span className="mono">{fmtDate(a.created_at)}</span>
                  <span>{a.authorName ?? '管理者'}</span>
                  <span className="board-scope">宛先: {targetLabel(a, me, kinds)}</span>
                </div>
              </button>
            )
          })}
        </div>
      )}

      {detail && (
        <DetailModal
          ann={detail}
          me={me}
          kinds={kinds}
          canManage={canManage(detail)}
          deleting={delMut.isPending}
          deleteError={error}
          onEdit={() => {
            setEditing(detail)
            setDetail(null)
          }}
          onDelete={() => {
            if (
              window.confirm(
                `「${detail.title}」を削除しますか？\n削除すると全員から見えなくなり、元に戻せません。`,
              )
            ) {
              delMut.mutate(detail.id)
            }
          }}
          onClose={() => setDetail(null)}
        />
      )}

      {editing && (
        <EditorModal
          me={me}
          kinds={kinds}
          existing={editing === 'new' ? null : editing}
          onSaved={(msg) => {
            invalidateAll()
            setEditing(null)
            setInfo(msg)
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  )
}

function DetailModal({
  ann,
  me,
  kinds,
  canManage,
  deleting,
  deleteError,
  onEdit,
  onDelete,
  onClose,
}: {
  ann: AnnouncementRow
  me: MeContext
  kinds: EmploymentKind[]
  canManage: boolean
  deleting: boolean
  deleteError: string | null
  onEdit: () => void
  onDelete: () => void
  onClose: () => void
}) {
  // メール配信状況（管理できる人だけ問い合わせる。サーバー側でも同じ権限を検証）
  const delivQ = useQuery({
    queryKey: ['ann_deliv', ann.id],
    enabled: canManage,
    queryFn: () => getAnnouncementDeliveries({ data: { announcement_id: ann.id } }),
  })

  return (
    <div className="modal show" onClick={onClose} role="dialog" aria-modal="true">
      <div className="mcard mcard-wide" onClick={(e) => e.stopPropagation()}>
        <div className="board-item-top">
          <span className={`badge imp-${ann.importance}`}>{IMPORTANCE_LABEL[ann.importance]}</span>
          <b className="board-detail-title">{ann.title}</b>
        </div>
        <div className="board-meta">
          <span className="mono">{fmtDate(ann.created_at)}</span>
          <span>{ann.authorName ?? '管理者'}</span>
          <span className="board-scope">宛先: {targetLabel(ann, me, kinds)}</span>
        </div>

        <div className="board-body">{ann.body}</div>

        {canManage && delivQ.data && (
          <div className="note board-deliv">
            {delivQ.data.delivered
              ? `メール配信: 送信 ${delivQ.data.sent} 件 / 失敗 ${delivQ.data.failed} 件${
                  delivQ.data.lastAt ? `（最終 ${fmtDate(delivQ.data.lastAt)}）` : ''
                }`
              : 'メール配信はまだ行われていません。'}
          </div>
        )}

        {deleteError && (
          <p className="login-error" role="alert">
            {deleteError}
          </p>
        )}

        <div className="mbtns">
          {canManage && (
            <>
              <button className="btn sm danger" disabled={deleting} onClick={onDelete}>
                {deleting ? '削除中…' : '削除'}
              </button>
              <button className="btn sm" onClick={onEdit}>
                編集
              </button>
            </>
          )}
          <button className="btn sm" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  )
}

function EditorModal({
  me,
  kinds,
  existing,
  onSaved,
  onClose,
}: {
  me: MeContext
  kinds: EmploymentKind[]
  existing: AnnouncementRow | null
  onSaved: (info: string | null) => void
  onClose: () => void
}) {
  const { user } = useAuth()
  const isOwner = me.role === 'owner'

  const [title, setTitle] = useState(existing?.title ?? '')
  const [body, setBody] = useState(existing?.body ?? '')
  const [importance, setImportance] = useState<Importance>(existing?.importance ?? 'normal')
  const [scopeType, setScopeType] = useState<ScopeType>(
    existing?.scope_type ?? (isOwner ? 'all' : 'stores'),
  )
  const [storeIds, setStoreIds] = useState<string[]>(existing?.targetStoreIds ?? [])
  const [kindIds, setKindIds] = useState<string[]>(existing?.targetKindIds ?? [])
  const [notify, setNotify] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: async (): Promise<string | null> => {
      const draft = { title, body, importance, scopeType, storeIds, kindIds }
      let id: string
      if (existing) {
        await updateAnnouncement(existing.id, draft, {
          storeIds: existing.targetStoreIds,
          kindIds: existing.targetKindIds,
        })
        id = existing.id
      } else {
        id = await createAnnouncement(me.tenantId, user!.id, draft)
      }
      if (!notify) return null

      // 投稿の保存は完了している。メール送信の失敗は保存を巻き戻さず結果だけ伝える
      try {
        const r = await sendAnnouncementMail({ data: { announcement_id: id } })
        if (r.total === 0) return '宛先に該当するスタッフがいなかったため、メールは送信されませんでした。'
        const extras: string[] = []
        if (r.failed > 0) extras.push(`失敗 ${r.failed} 件`)
        if (r.skipped > 0) extras.push(`アドレス未登録 ${r.skipped} 件`)
        return `${r.sent}人にメールを送信しました${extras.length > 0 ? `（${extras.join('・')}）` : ''}。`
      } catch (e) {
        return `投稿は保存しましたが、メール送信に失敗しました：${annErrText(e, '送信エラー')}`
      }
    },
    onSuccess: (msg) => onSaved(msg),
    onError: (e) => setError(annErrText(e, '保存できませんでした')),
  })

  const needsStores = scopeType === 'stores' || scopeType === 'stores_and_kinds'
  const needsKinds = scopeType === 'kinds' || scopeType === 'stores_and_kinds'

  const toggleIn = (list: string[], id: string): string[] =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id]

  // 宛先プレビュー「この投稿は 渋谷店のアルバイト に表示されます」
  const preview = useMemo(() => {
    if (scopeType === 'all') return '全員'
    const sn = storeIds
      .map((id) => me.stores.find((s) => s.id === id)?.name)
      .filter(Boolean)
      .join('・')
    const kn = kindIds
      .map((id) => kinds.find((k) => k.id === id)?.label)
      .filter(Boolean)
      .join('・')
    if (scopeType === 'stores') return sn || '（店舗未選択）'
    if (scopeType === 'kinds') return kn || '（区分未選択）'
    if (!sn || !kn) return '（店舗と区分を選択してください）'
    return `${sn}の${kn}`
  }, [scopeType, storeIds, kindIds, me.stores, kinds])

  return (
    <div className="modal show" onClick={onClose} role="dialog" aria-modal="true">
      <div className="mcard mcard-wide" onClick={(e) => e.stopPropagation()}>
        <div className="mh">{existing ? 'お知らせを編集' : 'お知らせを作成'}</div>

        {error && (
          <p className="login-error" role="alert">
            {error}
          </p>
        )}

        <label className="field">
          <span>タイトル</span>
          <input
            value={title}
            placeholder="例）年末年始の営業について"
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>

        <label className="field board-field">
          <span>本文</span>
          <textarea
            rows={6}
            value={body}
            placeholder="お知らせの内容"
            onChange={(e) => setBody(e.target.value)}
          />
        </label>

        <div className="field board-field">
          <span>重要度</span>
          <div className="pick-row">
            {(Object.keys(IMPORTANCE_LABEL) as Importance[]).map((k) => (
              <button
                key={k}
                type="button"
                className={`pick-btn imp-pick-${k}${importance === k ? ' on' : ''}`}
                onClick={() => setImportance(k)}
              >
                {IMPORTANCE_LABEL[k]}
              </button>
            ))}
          </div>
        </div>

        <div className="field board-field">
          <span>宛先</span>
          <div className="pick-row">
            {SCOPE_OPTIONS.map((o) => {
              const locked = o.ownerOnly && !isOwner
              return (
                <button
                  key={o.key}
                  type="button"
                  className={`pick-btn${scopeType === o.key ? ' on' : ''}`}
                  disabled={locked}
                  title={locked ? 'オーナーのみ選べます' : undefined}
                  onClick={() => setScopeType(o.key)}
                >
                  {o.label}
                </button>
              )
            })}
          </div>
          {!isOwner && <div className="note">「全体」「区分別」はオーナーのみ選べます。</div>}
        </div>

        {needsStores && (
          <div className="field board-field">
            <span>対象店舗（自分の管理範囲内）</span>
            <div className="target-checks">
              {me.stores.map((s) => (
                <label key={s.id} className="target-check">
                  <input
                    type="checkbox"
                    checked={storeIds.includes(s.id)}
                    onChange={() => setStoreIds((prev) => toggleIn(prev, s.id))}
                  />
                  <span>{s.name}</span>
                </label>
              ))}
              {me.stores.length === 0 && <div className="note">選択できる店舗がありません。</div>}
            </div>
          </div>
        )}

        {needsKinds && (
          <div className="field board-field">
            <span>対象の雇用区分</span>
            <div className="target-checks">
              {kinds.map((k) => (
                <label key={k.id} className="target-check">
                  <input
                    type="checkbox"
                    checked={kindIds.includes(k.id)}
                    onChange={() => setKindIds((prev) => toggleIn(prev, k.id))}
                  />
                  <span>{k.label}</span>
                </label>
              ))}
              {kinds.length === 0 && <div className="note">雇用区分が登録されていません。</div>}
            </div>
          </div>
        )}

        <p className="note board-preview">
          この投稿は <b>{preview}</b> に表示されます。
        </p>

        <label className="target-check board-notify">
          <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
          <span>メールでも通知する（宛先範囲のスタッフに送信）</span>
        </label>

        <div className="mbtns">
          <button className="btn sm" onClick={onClose}>
            閉じる
          </button>
          <button
            className="btn sm pri"
            disabled={save.isPending}
            onClick={() => {
              setError(null)
              save.mutate()
            }}
          >
            {save.isPending ? '保存中…' : existing ? '保存' : '投稿する'}
          </button>
        </div>
      </div>
    </div>
  )
}
