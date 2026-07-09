import { useEffect, useRef, useState } from 'react'
import { createFileRoute, useSearch } from '@tanstack/react-router'
import QRCode from 'qrcode'
import { issuePunchToken, type PunchKind } from '@/lib/server/punch'
import { initSoundUnlock, playKindTone } from '@/lib/sound'

export const Route = createFileRoute('/display/$storeId')({
  validateSearch: (search: Record<string, unknown>) => ({ sig: String(search.sig ?? '') }),
  component: DisplayPage,
})

const TTL_SEC = 60

const KIND_LABEL: Record<PunchKind, string> = {
  clock_in: '出勤',
  break_start: '休憩 開始',
  break_end: '休憩 終了',
  clock_out: '退勤',
}

const KIND_CLASS: Record<PunchKind, string> = {
  clock_in: 'inb',
  break_start: 'brkb',
  break_end: 'brkb',
  clock_out: 'outb',
}

const KIND_SUB: Record<PunchKind, string> = {
  clock_in: 'CLOCK IN',
  break_start: 'BREAK',
  break_end: 'RESUME',
  clock_out: 'CLOCK OUT',
}

/**
 * モデルB（レジ横の据置端末で開きっぱなしにする1画面）。
 * 上部の種別ボタンは常時表示。押すたびに前のQRを破棄して
 * その種別のワンタイムQRを1枚だけ下部に表示する。
 */
function DisplayPage() {
  const { storeId } = Route.useParams()
  const { sig } = useSearch({ from: '/display/$storeId' })

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [storeName, setStoreName] = useState('')
  const [current, setCurrent] = useState<{ kind: PunchKind; expiresAt: number } | null>(null)
  const [remaining, setRemaining] = useState(TTL_SEC)
  const [issuing, setIssuing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 据置端末は常時音あり（初回タップで自動再生制限を解除）
  useEffect(() => initSoundUnlock(), [])

  // ボタン押下 = 前のQRを破棄して新しいワンタイムQRに差し替える
  const issue = async (kind: PunchKind) => {
    playKindTone(kind)
    setIssuing(true)
    setError(null)
    try {
      const res = await issuePunchToken({ data: { store_id: storeId, kind, sig } })
      setStoreName(res.store_name)
      const expiresAt = new Date(res.expires_at).getTime()
      setCurrent({ kind: res.kind, expiresAt })
      setRemaining(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)))
      // canvas は常時マウントなので直接描画できる
      if (canvasRef.current) {
        const punchUrl = `${window.location.origin}/punch?token=${encodeURIComponent(res.token)}`
        await QRCode.toCanvas(canvasRef.current, punchUrl, {
          width: 220,
          margin: 0,
          color: { dark: '#1A2233', light: '#FFFFFF' },
        })
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'QRを発行できませんでした。')
      setCurrent(null)
    } finally {
      setIssuing(false)
    }
  }

  // 失効カウントダウン（表示のみ。自動再発行はしない）
  useEffect(() => {
    if (!current) return
    const id = setInterval(() => {
      setRemaining(Math.max(0, Math.ceil((current.expiresAt - Date.now()) / 1000)))
    }, 500)
    return () => clearInterval(id)
  }, [current])

  const expired = current !== null && remaining <= 0
  const pct = Math.min(100, (remaining / TTL_SEC) * 100)

  return (
    <div className="display-page">
      <div className="display-card card display-wide">
        <div className="display-head">
          <div className="noren" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </div>
          <div className="display-store">{storeName || '打刻QR発行'}</div>
        </div>

        {/* 上部: 種別ボタン（常時表示・タッチ大きめ・選択中をハイライト） */}
        <div className="kind-grid">
          {(Object.keys(KIND_LABEL) as PunchKind[]).map((k) => (
            <button
              key={k}
              className={`pbtn kind-btn ${KIND_CLASS[k]}${current?.kind === k ? ' is-current' : ''}`}
              disabled={issuing}
              onClick={() => void issue(k)}
            >
              <span className="kind-main">{KIND_LABEL[k]}</span>
              <span className="kind-sub">{KIND_SUB[k]}</span>
            </button>
          ))}
        </div>

        {error && (
          <p className="login-error" role="alert">
            {error}
          </p>
        )}

        {/* 下部: QRエリア（ボタンを押すたびに差し替わる） */}
        <div className="qr-area">
          <div className={`qrbox${expired ? ' qr-expired' : ''}${current ? '' : ' qr-empty'}`}>
            <canvas ref={canvasRef} width={220} height={220} />
            {!current && <div className="qr-placeholder">上のボタンを押すと{'\n'}QRが表示されます</div>}
            {expired && (
              <div className="qr-expired-overlay">
                期限切れ
                <span className="qr-expired-sub">もう一度ボタンを押してください</span>
              </div>
            )}
          </div>

          {current && (
            <>
              <div className="display-kind-tag">{KIND_LABEL[current.kind]} 用QR</div>
              <div className="qrring">
                <span className="num">{remaining}</span>
                <div className="bar">
                  <i style={{ width: `${pct}%` }} />
                </div>
              </div>
            </>
          )}

          <div className="note display-foot">
            1回読まれたら無効になります。次の人は該当ボタンをもう一度押してください。
          </div>
        </div>
      </div>
    </div>
  )
}
