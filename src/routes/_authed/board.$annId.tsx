import { useEffect, useRef } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/lib/auth'
import { useMe, type MeContext } from '@/lib/me-context'
import { errText } from '@/lib/errors'
import { fetchEmploymentKinds, type EmploymentKind } from '@/lib/queries/master'
import {
  IMPORTANCE_LABEL,
  fetchAnnouncements,
  fetchMyReadIds,
  markRead,
  type AnnouncementRow,
} from '@/lib/queries/announcements'

/**
 * メール内リンクの着地ページ（/board/{id}）。
 * 未ログインなら _authed が /login?redirect=/board/{id} へ飛ばし、ログイン後にここへ戻る。
 * 閲覧可否は RLS（一覧に返らない投稿=権限なし）。開いたら既読を記録する。
 */
export const Route = createFileRoute('/_authed/board/$annId')({
  component: BoardDetailPage,
})

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('ja-JP', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
  })
}

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

function BoardDetailPage() {
  const { annId } = Route.useParams()
  const { me } = useMe()
  const { user } = useAuth()
  const qc = useQueryClient()

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

  const readMut = useMutation({
    mutationFn: (id: string) => markRead(id, user!.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['ann_reads'] })
      void qc.invalidateQueries({ queryKey: ['ann_unread'] })
    },
    onError: () => undefined,
  })

  const ann = listQ.data?.find((a) => a.id === annId) ?? null

  // 開いたら一度だけ既読を記録
  const marked = useRef(false)
  useEffect(() => {
    if (!marked.current && ann && readsQ.data && !readsQ.data.has(ann.id)) {
      marked.current = true
      readMut.mutate(ann.id)
    }
  }, [ann, readsQ.data, readMut])

  if (!me || !user) return null
  const kinds = kindsQ.data ?? []

  return (
    <section>
      <div className="eyebrow">掲示板 · お知らせ</div>
      <div className="page-h">
        <h1>お知らせ</h1>
        <Link to="/board" className="btn sm board-back">
          ← 掲示板一覧へ
        </Link>
      </div>

      {listQ.isPending && <p className="note">読み込み中…</p>}
      {listQ.error && (
        <p className="login-error" role="alert">
          {errText(listQ.error, 'お知らせの取得に失敗しました')}
        </p>
      )}

      {listQ.data && !ann && (
        <p className="note">このお知らせは存在しないか、閲覧権限がありません。</p>
      )}

      {ann && (
        <div className="card board-detail-card">
          <div className="board-item-top">
            <span className={`badge imp-${ann.importance}`}>
              {IMPORTANCE_LABEL[ann.importance]}
            </span>
            <b className="board-detail-title">{ann.title}</b>
          </div>
          <div className="board-meta">
            <span className="mono">{fmtDate(ann.created_at)}</span>
            <span>{ann.authorName ?? '管理者'}</span>
            <span className="board-scope">宛先: {targetLabel(ann, me, kinds)}</span>
          </div>
          <div className="board-body">{ann.body}</div>
        </div>
      )}
    </section>
  )
}
