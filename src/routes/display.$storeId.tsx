import { useEffect, useRef, useState } from 'react'
import { createFileRoute, useSearch } from '@tanstack/react-router'
import QRCode from 'qrcode'
import { issuePunchToken, type PunchKind } from '@/lib/server/punch'

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

/**
 * モデルB: 種別ボタンを押すたびに1枚だけワンタイムQRを発行する。
 * ポーリングはしない。1回読まれたら無効。次の人はもう一度ボタンを押す。
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

  const issue = async (kind: PunchKind) => {
    setIssuing(true)
    setError(null)
    try {
      const res = await issuePunchToken({ data: { store_id: storeId, kind, sig } })
      setStoreName(res.store_name)
      const expiresAt = new Date(res.expires_at).getTime()
      setCurrent({ kind: res.kind, expiresAt })
      setRemaining(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)))
      // canvas は current がセットされてから描画される（次フレームで ref が付く）
      requestAnimationFrame(() => {
        if (canvasRef.current) {
          const punchUrl = `${window.location.origin}/punch?token=${encodeURIComponent(res.token)}`
          void QRCode.toCanvas(canvasRef.current, punchUrl, {
            width: 220,
            margin: 0,
            color: { dark: '#1A2233', light: '#FFFFFF' },
          })
        }
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'QRを発行できませんでした。')
      setCurrent(null)
    } finally {
      setIssuing(false)
    }
  }

  // 失効カウントダウン（表示のみ。再発行はしない）
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
      <div className="display-card card">
        <div className="noren" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </div>

        <div className="display-store">{storeName || '打刻QR発行'}</div>

        {error && (
          <p className="login-error" role="alert">
            {error}
          </p>
        )}

        {!current ? (
          <>
            <div className="note">打刻の種類を選ぶと、1回だけ使えるQRを表示します</div>
            <div className="punchbtns display-kinds">
              {(Object.keys(KIND_LABEL) as PunchKind[]).map((k) => (
                <button
                  key={k}
                  className={`pbtn ${KIND_CLASS[k]}`}
                  disabled={issuing}
                  onClick={() => void issue(k)}
                >
                  {issuing ? '発行中…' : KIND_LABEL[k]}
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="display-kind-tag">{KIND_LABEL[current.kind]} 用QR</div>

            <div className={`qrbox${expired ? ' qr-expired' : ''}`}>
              <canvas ref={canvasRef} width={220} height={220} />
              {expired && <div className="qr-expired-overlay">期限切れ</div>}
            </div>

            <div className="qrring">
              <span className="num">{remaining}</span>
              <div className="bar">
                <i style={{ width: `${pct}%` }} />
              </div>
            </div>

            <div className="note display-foot">
              1回読まれたら無効になります。次の人はもう一度ボタンを押してください。
            </div>

            <button className="btn pri reissue" disabled={issuing} onClick={() => setCurrent(null)}>
              新しいQRを出す
            </button>
          </>
        )}
      </div>
    </div>
  )
}
