import { useEffect, useRef, useState } from 'react'
import { respondOffer, type OfferAction, type OfferOutcome } from '@/lib/server/offer'
import { minToHHMM } from '@/lib/queries/shifts'

/**
 * オファーの着地ページ（認証不要・スマホ1画面）。二段階承認モデル（0014）:
 * - accept: 確認画面（任意コメント入力）→「承諾する」で申請(applied)。確定は管理者の承認後
 * - decline: 踏んだら即 decline 実行（コメント不要）
 * - 生トークンは即座に URL から除去（履歴・共有経由の漏えい防止。値は props 保持で安全）
 * - 二度踏みは definer 側の状態で吸収（applied 再送=上書き / confirmed 済み=already_confirmed）
 */

type Phase =
  | { kind: 'form' }
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'done'; did: OfferAction; outcome: OfferOutcome }

interface ViewModel {
  ok: boolean
  title: string
  detail?: string
  note?: string
}

function fmtDate(ymd: string): string {
  return new Date(`${ymd}T00:00:00`).toLocaleDateString('ja-JP', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  })
}

function detailOf(o: OfferOutcome): string | undefined {
  return o.workDate && o.startMin !== null && o.endMin !== null
    ? `${fmtDate(o.workDate)} ${minToHHMM(o.startMin)}〜${minToHHMM(o.endMin)}`
    : undefined
}

function toView(did: OfferAction, o: OfferOutcome): ViewModel {
  if (o.ok) {
    if (did === 'decline') {
      return { ok: true, title: '不参加として受け付けました' }
    }
    if (o.reason === 'already_confirmed') {
      return { ok: true, title: 'すでに確定済みです', detail: detailOf(o) }
    }
    // reason === 'applied'（申請受付。確定は店舗の承認後）
    return {
      ok: true,
      title: '申請を受け付けました。確定したら店舗から改めて連絡します',
      detail: detailOf(o),
    }
  }
  switch (o.reason) {
    case 'already_filled':
      return { ok: false, title: 'このシフトは既に他の方で決まりました' }
    case 'expired':
      return { ok: false, title: '募集期限が過ぎています' }
    case 'cancelled':
      return { ok: false, title: 'この募集は取り消されました' }
    case 'invalid':
      return { ok: false, title: 'リンクが無効か、既に使用済みです' }
    case 'missing':
      return { ok: false, title: 'リンクが不正です' }
    default:
      return { ok: false, title: '処理に失敗しました。時間をおいて再度お試しください。' }
  }
}

const MISSING: OfferOutcome = {
  ok: false,
  reason: 'missing',
  workDate: null,
  startMin: null,
  endMin: null,
  overlapWarning: false,
}

export function OfferLanding({ action, token }: { action: OfferAction; token: string | undefined }) {
  // 初回レンダーの token を固定保持する。history.replaceState で URL の ?t= を消すと
  // TanStack Router の search 再評価で props の token が undefined 化するため、
  // マウント後に押される承諾ボタンは props ではなくこちらを使う（useState 初期値は不変）
  const [heldToken] = useState(token)
  const [phase, setPhase] = useState<Phase>(
    action === 'accept' && heldToken ? { kind: 'form' } : { kind: 'loading' },
  )
  const [comment, setComment] = useState('')
  const fired = useRef(false)

  const run = (act: OfferAction, cmt?: string) => {
    setPhase({ kind: 'loading' })
    respondOffer({ data: { action: act, token: heldToken!, comment: cmt } })
      .then((outcome) => setPhase({ kind: 'done', did: act, outcome }))
      .catch(() => setPhase({ kind: 'error' }))
  }

  useEffect(() => {
    // 生トークンを URL から除去（値は heldToken に退避済みなので消して安全）
    if (window.location.search) {
      window.history.replaceState(null, '', window.location.pathname)
    }
    if (fired.current) return
    fired.current = true

    if (!heldToken) {
      setPhase({ kind: 'done', did: action, outcome: MISSING })
      return
    }
    // decline は従来どおり踏んだら即実行。accept は確認画面（form）で承諾ボタン待ち
    if (action === 'decline') {
      run('decline')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const view: ViewModel | null =
    phase.kind === 'done'
      ? toView(phase.did, phase.outcome)
      : phase.kind === 'error'
        ? { ok: false, title: '処理に失敗しました。時間をおいて再度お試しください。' }
        : null

  return (
    <div className="offer-page">
      <div className="offer-card">
        <div className="offer-brand">
          <span className="offer-eyebrow">SHIN勤怠 · シフト募集</span>
        </div>

        {phase.kind === 'form' && (
          <>
            <h1 className="offer-title">シフトのお願いが届いています</h1>
            <p className="offer-lead">
              下のボタンで承諾すると<b>申請</b>として受け付けます（確定は店舗の承認後です）。
              条件の相談があればコメントに書き添えてください。
            </p>
            <textarea
              className="offer-comment"
              rows={3}
              value={comment}
              placeholder="例：22:30上がりで良ければ など（任意）"
              onChange={(e) => setComment(e.target.value)}
            />
            <button className="offer-accept-btn" onClick={() => run('accept', comment)}>
              この条件で承諾する
            </button>
            <button className="offer-decline-link" onClick={() => run('decline')}>
              辞退する
            </button>
          </>
        )}

        {phase.kind === 'loading' && (
          <>
            <div className="offer-icon wait" aria-hidden="true">
              …
            </div>
            <h1 className="offer-title">確認しています…</h1>
          </>
        )}

        {view && (
          <>
            <div className={`offer-icon ${view.ok ? 'ok' : 'ng'}`} aria-hidden="true">
              {view.ok ? '✓' : '×'}
            </div>
            <h1 className="offer-title">{view.title}</h1>
            {view.detail && <p className="offer-detail mono">{view.detail}</p>}
            {view.note && <p className="offer-note">{view.note}</p>}
            <p className="offer-foot">このページは閉じて構いません。</p>
          </>
        )}
      </div>
    </div>
  )
}
