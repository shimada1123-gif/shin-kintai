import { useEffect, useRef, useState } from 'react'
import { createFileRoute, useSearch } from '@tanstack/react-router'
import QRCode from 'qrcode'
import { issueStoreToken } from '@/lib/server/punch'

export const Route = createFileRoute('/display/$storeId')({
  validateSearch: (search: Record<string, unknown>) => ({ sig: String(search.sig ?? '') }),
  component: DisplayPage,
})

const REFRESH_SEC = 30
const TTL_SEC = 60

function DisplayPage() {
  const { storeId } = Route.useParams()
  const { sig } = useSearch({ from: '/display/$storeId' })

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [storeName, setStoreName] = useState('')
  const [expiresAt, setExpiresAt] = useState<number | null>(null)
  const [remaining, setRemaining] = useState(TTL_SEC)
  const [error, setError] = useState<string | null>(null)

  // ~30秒ごとにトークンを取り直して描画する（失効は60秒なので必ず重なる）
  useEffect(() => {
    let cancelled = false

    const refresh = async () => {
      try {
        const res = await issueStoreToken({ data: { store_id: storeId, sig } })
        if (cancelled) return
        setStoreName(res.store_name)
        setExpiresAt(new Date(res.expires_at).getTime())
        setError(null)
        if (canvasRef.current) {
          // 生トークンではなく絶対URLを載せる。スマホの標準カメラで読んでも
          // /punch?token=... が開き、アプリ内の打刻ボタンに直行できる。
          const punchUrl = `${window.location.origin}/punch?token=${encodeURIComponent(res.token)}`
          await QRCode.toCanvas(canvasRef.current, punchUrl, {
            width: 220,
            margin: 0,
            color: { dark: '#1A2233', light: '#FFFFFF' },
          })
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'トークンを取得できませんでした。')
      }
    }

    void refresh()
    const id = setInterval(() => void refresh(), REFRESH_SEC * 1000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [storeId, sig])

  // 失効までのカウントダウン
  useEffect(() => {
    const id = setInterval(() => {
      if (!expiresAt) return
      const left = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000))
      setRemaining(left)
    }, 500)
    return () => clearInterval(id)
  }, [expiresAt])

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

        {error ? (
          <>
            <div className="display-store">表示できません</div>
            <p className="login-error" role="alert">
              {error}
            </p>
          </>
        ) : (
          <>
            <div className="display-store">{storeName || '読み込み中…'}</div>
            <div className="note">出勤・退勤はこのQRをスキャン</div>

            <div className="qrbox">
              <canvas ref={canvasRef} width={220} height={220} />
            </div>

            <div className="qrring">
              <span className="num">{remaining}</span>
              <div className="bar">
                <i style={{ width: `${pct}%` }} />
              </div>
            </div>

            <div className="note display-foot">
              トークンは{TTL_SEC}秒で失効（スクリーンショットの流用を防止）
            </div>
          </>
        )}
      </div>
    </div>
  )
}
