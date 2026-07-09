import { useCallback, useEffect, useRef, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import jsQR from 'jsqr'
import { errText } from '@/lib/errors'
import { useMe } from '@/lib/me-context'
import { myAttendanceToday, punch, type PunchKind } from '@/lib/server/punch'
import { initSoundUnlock, playPunchError, playPunchSuccess, vibrate } from '@/lib/sound'

export const Route = createFileRoute('/_authed/punch')({
  // 据置QRは /punch?token=... のURLを載せている。標準カメラで読んだ場合はここで受ける。
  validateSearch: (s: Record<string, unknown>) => ({
    token: typeof s.token === 'string' && s.token ? s.token : undefined,
  }),
  component: PunchPage,
})

const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })

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

/**
 * モデルB: 種別はQR（トークン）が持つ。スタッフは読むだけで、
 * トークン取得 → GPS取得 → 即 punch。ボタンで種別を選ぶことはない。
 */
function PunchPage() {
  const { me } = useMe()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { token: tokenFromUrl } = Route.useSearch()
  const [manual, setManual] = useState('')
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [result, setResult] = useState<{
    ok: boolean
    text: string
    kind?: PunchKind
    at?: string
    store?: string
    gps?: string
  } | null>(null)
  const [punching, setPunching] = useState(false)
  const [soundOn, setSoundOn] = useState(true)
  // 同じトークンで二度 punch を発火させないためのガード
  const firedRef = useRef<string | null>(null)
  const soundOnRef = useRef(soundOn)
  soundOnRef.current = soundOn

  // 自動再生制限の解除（初回のタップ/キー入力で AudioContext を有効化）
  useEffect(() => initSoundUnlock(), [])

  const todayQ = useQuery({ queryKey: ['my_attendance_today'], queryFn: () => myAttendanceToday() })

  const doPunch = useMutation({
    mutationFn: async (token: string) => {
      const pos = await getPosition()
      return punch({ data: { token, gps_lat: pos?.lat ?? null, gps_lng: pos?.lng ?? null } })
    },
    onSuccess: (r) => {
      setResult({
        ok: true,
        text: r.message,
        kind: r.kind,
        at: r.at,
        store: r.store_name,
        gps: gpsLabel(r.gps_status),
      })
      if (soundOnRef.current) playPunchSuccess(r.kind)
      vibrate(50)
      void qc.invalidateQueries({ queryKey: ['my_attendance_today'] })
    },
    onError: (e) => {
      setResult({ ok: false, text: errText(e, '打刻できませんでした') })
      if (soundOnRef.current) playPunchError()
      vibrate([120, 60, 120])
    },
    onSettled: () => setPunching(false),
  })

  const fire = useCallback(
    (token: string | null) => {
      if (!token || firedRef.current === token) return
      firedRef.current = token
      setResult(null)
      setPunching(true)
      doPunch.mutate(token)
    },
    [doPunch],
  )

  // URL経由のトークンは即発火し、履歴からは消す（トークンは60秒で失効・1回で消費）
  useEffect(() => {
    if (tokenFromUrl) {
      fire(tokenFromUrl)
      void navigate({ to: '/punch', search: { token: undefined }, replace: true })
    }
  }, [tokenFromUrl, fire, navigate])

  const handleDetect = useCallback(
    (data: string) => {
      setScanning(false)
      const t = extractToken(data)
      if (!t) {
        setScanError('QRコードを解釈できませんでした。店舗端末のQRを読み取ってください。')
        return
      }
      setScanError(null)
      fire(t)
    },
    [fire],
  )

  const handleScanError = useCallback((m: string) => {
    setScanError(m)
    setScanning(false)
  }, [])

  if (!me) return null

  return (
    <section>
      <div className="eyebrow">SCAN & PUNCH</div>
      <div className="page-h">
        <h1>打刻</h1>
        <span className="desc">店舗端末のQRを読むだけ。種別はQRが持っています。</span>
        <button
          className="btn sm sound-toggle"
          aria-label={soundOn ? '効果音をオフにする' : '効果音をオンにする'}
          onClick={() => setSoundOn((v) => !v)}
        >
          {soundOn ? '🔊 音あり' : '🔇 音なし'}
        </button>
      </div>

      <div className="cols">
        <div className="card punch-card">
          {punching && (
            <div className="punch-result pending" role="status">
              <div className="big-mark">…</div>
              <div className="result-msg">打刻しています</div>
            </div>
          )}

          {result && (
            <div className={`punch-result ${result.ok ? 'ok' : 'ng'}`} role="alert">
              <div className="big-mark">{result.ok ? '✓' : '×'}</div>
              <div className="result-msg">{result.text}</div>
              {result.ok && (
                <div className="result-meta">
                  <span className="mono">{result.at ? hhmm(result.at) : ''}</span>
                  {result.store && <span> · {result.store}</span>}
                  {result.gps && <span className="result-gps">{result.gps}</span>}
                </div>
              )}
              <div className="scan-hint">次の打刻は、店舗端末で新しいQRを出してもらってください。</div>
              <button
                className="btn sm"
                onClick={() => {
                  setResult(null)
                  setScanError(null)
                  // 同じQRを読み直したときも（使用済みエラーを）再表示できるようにする
                  firedRef.current = null
                }}
              >
                もう一度スキャンする
              </button>
            </div>
          )}

          {!punching && !result && (
            <>
              <QrScanner active={scanning} onDetect={handleDetect} onError={handleScanError} />

              {!scanning && (
                <button className="btn pri" onClick={() => setScanning(true)}>
                  カメラでQRをスキャン
                </button>
              )}

              {scanError && <p className="note scan-warn">{scanError}</p>}

              <div className="scan-hint">
                位置情報は打刻の瞬間のみ取得し、常時追跡はしません。
                <br />
                圏外・取得できない場合も打刻は通り「位置未確認」として記録されます。
              </div>

              <div className="manual-token">
                <div className="eyebrow">MANUAL</div>
                <p className="note">カメラが使えないときは、店舗端末のトークンを貼り付けてください。</p>
                <div className="inline-add">
                  <input
                    value={manual}
                    placeholder="トークン または URL"
                    onChange={(e) => setManual(e.target.value)}
                  />
                  <button
                    className="btn sm"
                    disabled={!manual.trim()}
                    onClick={() => {
                      fire(extractToken(manual))
                      setManual('')
                    }}
                  >
                    打刻
                  </button>
                </div>
              </div>
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
