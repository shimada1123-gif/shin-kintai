import { useCallback, useEffect, useRef, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import jsQR from 'jsqr'
import { errText } from '@/lib/errors'
import { useMe } from '@/lib/me-context'
import { myAttendanceToday, punch, type PunchKind } from '@/lib/server/punch'

export const Route = createFileRoute('/_authed/punch')({
  // 据置QRは /punch?token=... のURLを載せている。標準カメラで読んだ場合はここで受ける。
  validateSearch: (s: Record<string, unknown>) => ({
    token: typeof s.token === 'string' && s.token ? s.token : undefined,
  }),
  component: PunchPage,
})

/**
 * QRペイロードからトークンを取り出す。
 * 新形式（/punch?token=... のURL）と旧形式（生トークン）の両方を受ける。
 */
function extractToken(data: string): string | null {
  const s = data.trim()
  if (!s) return null
  try {
    const url = new URL(s)
    return url.searchParams.get('token')
  } catch {
    // URLではない = 生トークンとして扱う
    return s
  }
}

const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })

/** 打刻の瞬間だけ位置を取る。常時追跡はしない。 */
function getPosition(): Promise<{ lat: number; lng: number } | null> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return Promise.resolve(null)
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve(null), // 拒否・失敗は「未取得」としてサーバーに判断させる
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 },
    )
  })
}

function PunchPage() {
  const { me } = useMe()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { token: tokenFromUrl } = Route.useSearch()
  const [token, setToken] = useState<string | null>(tokenFromUrl ?? null)
  const [manual, setManual] = useState('')
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [result, setResult] = useState<{ ok: boolean; text: string; gps?: string } | null>(null)

  // URL経由で受けたトークンは state に取り込んだら履歴から消す
  // （履歴・共有リンクに残さない。トークン自体は60秒で失効する）
  useEffect(() => {
    if (tokenFromUrl) {
      setToken(tokenFromUrl)
      void navigate({ to: '/punch', search: { token: undefined }, replace: true })
    }
  }, [tokenFromUrl, navigate])

  // スキャナに渡すコールバックは安定させる。インライン関数だと親の再レンダリング
  // ごとに useEffect が走り、カメラが停止→再取得を繰り返してしまう。
  const handleDetect = useCallback((data: string) => {
    const t = extractToken(data)
    if (!t) {
      setScanError('QRコードを解釈できませんでした。店舗の画面を読み取ってください。')
      setScanning(false)
      return
    }
    setToken(t)
    setScanning(false)
    setScanError(null)
  }, [])

  const handleScanError = useCallback((m: string) => {
    setScanError(m)
    setScanning(false)
  }, [])

  const todayQ = useQuery({ queryKey: ['my_attendance_today'], queryFn: () => myAttendanceToday() })

  const doPunch = useMutation({
    mutationFn: async (kind: PunchKind) => {
      const pos = await getPosition()
      return punch({
        data: { token: token!, kind, gps_lat: pos?.lat ?? null, gps_lng: pos?.lng ?? null },
      })
    },
    onSuccess: (r) => {
      setResult({ ok: true, text: r.message, gps: gpsLabel(r.gps_status) })
      void qc.invalidateQueries({ queryKey: ['my_attendance_today'] })
    },
    onError: (e) => setResult({ ok: false, text: errText(e, '打刻できませんでした') }),
  })

  if (!me) return null

  const open = todayQ.data?.find((a) => !a.clock_out_at)
  const onBreak = open?.breaks.some((b) => !b.break_end_at) ?? false

  return (
    <section>
      <div className="eyebrow">SCAN & PUNCH</div>
      <div className="page-h">
        <h1>打刻</h1>
        <span className="desc">店のQRをスキャンして出勤・退勤。</span>
      </div>

      <div className="cols">
        <div className="card punch-card">
          {!token ? (
            <>
              <QrScanner active={scanning} onDetect={handleDetect} onError={handleScanError} />

              {!scanning && (
                <button className="btn pri" onClick={() => setScanning(true)}>
                  カメラでQRをスキャン
                </button>
              )}

              {scanError && <p className="note scan-warn">{scanError}</p>}

              <div className="manual-token">
                <div className="eyebrow">MANUAL</div>
                <p className="note">カメラが使えないときは、店舗画面のトークンを貼り付けてください。</p>
                <div className="inline-add">
                  <input
                    value={manual}
                    placeholder="トークン"
                    onChange={(e) => setManual(e.target.value)}
                  />
                  <button
                    className="btn sm"
                    disabled={!manual.trim()}
                    onClick={() => setToken(extractToken(manual))}
                  >
                    使う
                  </button>
                </div>
              </div>
            </>
          ) : (
            <>
              <p className="note scanned">QRを読み取りました ✓</p>

              {result && (
                <p className={result.ok ? 'punch-ok' : 'login-error'} role="alert">
                  {result.text}
                  {result.gps && <span className="punch-gps">{result.gps}</span>}
                </p>
              )}

              <div className="punchbtns">
                <button
                  className="pbtn inb"
                  disabled={doPunch.isPending || !!open}
                  onClick={() => doPunch.mutate('clock_in')}
                >
                  出勤
                </button>
                <button
                  className="pbtn brkb"
                  disabled={doPunch.isPending || !open}
                  onClick={() => doPunch.mutate(onBreak ? 'break_end' : 'break_start')}
                >
                  {onBreak ? '休憩 終了' : '休憩 開始'}
                </button>
                <button
                  className="pbtn outb"
                  disabled={doPunch.isPending || !open}
                  onClick={() => doPunch.mutate('clock_out')}
                >
                  退勤
                </button>
              </div>

              <div className="scan-hint">
                位置情報は打刻の瞬間のみ取得し、常時追跡はしません。
                <br />
                圏外・取得できない場合も打刻は通り「位置未確認」として記録されます。
              </div>

              <button
                className="btn sm retake"
                onClick={() => {
                  setToken(null)
                  setResult(null)
                }}
              >
                別のQRを読み取る
              </button>
            </>
          )}
        </div>

        <div className="card col-side-single">
          <div className="card-title">今日のあなた</div>
          {todayQ.isPending && <p className="note">読み込み中…</p>}
          {todayQ.error && (
            <p className="login-error" role="alert">
              {errText(todayQ.error, '勤怠を取得できませんでした')}
            </p>
          )}
          {todayQ.data && todayQ.data.length === 0 && <p className="note">本日の打刻はありません。</p>}
          {todayQ.data?.map((a) => (
            <table key={a.id}>
              <tbody>
                <tr>
                  <td>状態</td>
                  <td>
                    {a.clock_out_at ? (
                      <span className="st st-out">
                        <span className="dot" />
                        退勤済み
                      </span>
                    ) : a.breaks.some((b) => !b.break_end_at) ? (
                      <span className="st st-br">
                        <span className="dot" />
                        休憩中
                      </span>
                    ) : (
                      <span className="st st-in">
                        <span className="dot" />
                        出勤中
                      </span>
                    )}
                  </td>
                </tr>
                <tr>
                  <td>店舗</td>
                  <td>{a.store_name}</td>
                </tr>
                <tr>
                  <td>出勤</td>
                  <td className="mono">{hhmm(a.clock_in_at)}</td>
                </tr>
                {a.clock_out_at && (
                  <tr>
                    <td>退勤</td>
                    <td className="mono">{hhmm(a.clock_out_at)}</td>
                  </tr>
                )}
                {a.breaks.map((b) => (
                  <tr key={b.id}>
                    <td>休憩</td>
                    <td className="mono">
                      {hhmm(b.break_start_at)}〜{b.break_end_at ? hhmm(b.break_end_at) : ''}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td>位置</td>
                  <td>{gpsLabel(a.gps_status)}</td>
                </tr>
              </tbody>
            </table>
          ))}
        </div>
      </div>
    </section>
  )
}

function gpsLabel(status: string): string {
  if (status === 'ok') return '圏内'
  if (status === 'out') return '圏外'
  return '位置未確認'
}

/* ------------------------- カメラスキャン ------------------------- */

function QrScanner({
  active,
  onDetect,
  onError,
}: {
  active: boolean
  onDetect: (token: string) => void
  onError: (message: string) => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number>(0)

  const stop = useCallback((stream: MediaStream | null) => {
    cancelAnimationFrame(rafRef.current)
    stream?.getTracks().forEach((t) => t.stop())
  }, [])

  useEffect(() => {
    if (!active) return
    let stream: MediaStream | null = null
    let cancelled = false

    const tick = () => {
      const video = videoRef.current
      const canvas = canvasRef.current
      if (!video || !canvas || video.readyState !== video.HAVE_ENOUGH_DATA) {
        rafRef.current = requestAnimationFrame(tick)
        return
      }
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) return
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })
      if (code?.data) {
        stop(stream)
        onDetect(code.data)
        return
      }
      rafRef.current = requestAnimationFrame(tick)
    }

    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        })
        if (cancelled) return stop(stream)
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play()
          rafRef.current = requestAnimationFrame(tick)
        }
      } catch {
        onError('カメラを使用できません。下の入力欄にトークンを貼り付けてください。')
      }
    })()

    return () => {
      cancelled = true
      stop(stream)
    }
  }, [active, onDetect, onError, stop])

  if (!active) return null

  return (
    <div className="scanner">
      <video ref={videoRef} playsInline muted />
      <canvas ref={canvasRef} hidden />
      <div className="scanner-frame" aria-hidden="true" />
    </div>
  )
}
