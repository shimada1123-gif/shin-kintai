import type { PunchKind } from '@/lib/server/punch'

/**
 * 効果音ユーティリティ（Web Audio で合成。音声ファイル不要）。
 *
 * 実機（iOS Safari / Android Chrome）対応の要点:
 * - AudioContext は「最初のユーザー操作の中」で生成・resume する（それ以外では
 *   suspended のまま音が出ない）。initSoundUnlock が touchend / click /
 *   pointerdown / keydown を張り、最初のタップで解除する
 * - iOS は resume 後に無音バッファを1度再生する warm up が必要（既知の処置）
 * - QR経由(?token=)の自動打刻など「操作を伴わない再生要求」は保留キューに積み、
 *   直後の最初のタップで鳴らす（8秒で失効）。音が出せない間もバイブと
 *   大きな視覚表示は呼び出し側で必ず出す
 */

let ctx: AudioContext | null = null
let warmed = false
let pending: { fn: () => void; expiresAt: number } | null = null
let listenersActive = false

function getCtx(create: boolean): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (!ctx && create) {
    const AC =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return null
    ctx = new AC()
  }
  return ctx
}

/** iOS: resume 直後に無音の1サンプルを再生してオーディオ経路を開通させる */
function warmUp(c: AudioContext): void {
  if (warmed) return
  try {
    const buf = c.createBuffer(1, 1, 22050)
    const src = c.createBufferSource()
    src.buffer = buf
    src.connect(c.destination)
    src.start(0)
    warmed = true
  } catch {
    /* 失敗しても後続の再生自体は試みる */
  }
}

function flushPending(): void {
  const c = ctx
  if (!pending || !c || c.state !== 'running') return
  const p = pending
  pending = null
  if (Date.now() <= p.expiresAt) p.fn()
}

/** ユーザー操作の中から呼ぶこと。生成 → resume → warm up → 保留分の再生。 */
export function unlockAudio(): void {
  const c = getCtx(true)
  if (!c) return
  if (c.state === 'suspended') {
    void c
      .resume()
      .then(() => {
        warmUp(c)
        flushPending()
      })
      .catch(() => {})
  } else {
    warmUp(c)
    flushPending()
  }
}

function isRunning(): boolean {
  return !!ctx && ctx.state === 'running'
}

/** 最初のユーザー操作（touchend / click / pointerdown / keydown）で解除する */
export function initSoundUnlock(): void {
  if (typeof window === 'undefined' || listenersActive || isRunning()) return
  listenersActive = true
  const events = ['touchend', 'click', 'pointerdown', 'keydown'] as const
  const handler = () => {
    unlockAudio()
    // running になったら以後のリスナーは不要
    if (isRunning()) {
      events.forEach((ev) => window.removeEventListener(ev, handler))
      listenersActive = false
    }
  }
  events.forEach((ev) => window.addEventListener(ev, handler, { passive: true }))
}

/**
 * 再生できる状態なら即再生。suspended なら resume を試みつつ、
 * 直後のタップで鳴らす保留キューにも積む（自動打刻フロー対策）。
 */
function playOrDefer(fn: () => void): void {
  const c = getCtx(true)
  if (!c) return
  if (c.state === 'running') {
    fn()
    return
  }
  pending = { fn, expiresAt: Date.now() + 8000 }
  void c
    .resume()
    .then(() => {
      if (c.state === 'running') {
        warmUp(c)
        flushPending()
      }
    })
    .catch(() => {})
  initSoundUnlock()
}

/** 単音。at 秒後に dur 秒だけ鳴らす（エンベロープ付きでクリックノイズを避ける） */
function tone(
  freq: number,
  at: number,
  dur: number,
  type: OscillatorType = 'sine',
  peak = 0.18,
): void {
  const c = ctx
  if (!c || c.state !== 'running') return
  const t0 = c.currentTime + at
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = type
  osc.frequency.value = freq
  gain.gain.setValueAtTime(0.0001, t0)
  gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.02)
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
  osc.connect(gain).connect(c.destination)
  osc.start(t0)
  osc.stop(t0 + dur + 0.05)
}

/** 打刻成功: ピンポーン♪（出勤=明るい下降2音 / 退勤=少し低い落ち着いた2音） */
export function playPunchSuccess(kind?: PunchKind): void {
  playOrDefer(() => {
    if (kind === 'clock_out') {
      tone(1046.5, 0, 0.22) // C6
      tone(784.0, 0.16, 0.34) // G5
    } else {
      tone(1318.5, 0, 0.2) // E6
      tone(1046.5, 0.15, 0.38) // C6
    }
  })
}

/** 打刻失敗: ブブー（低い2音のブザー） */
export function playPunchError(): void {
  playOrDefer(() => {
    tone(196, 0, 0.18, 'square', 0.11) // G3
    tone(185, 0.22, 0.32, 'square', 0.11) // F#3
  })
}

/** 店舗端末: 種別ボタンの軽い操作音（ボタン押下=ユーザー操作の中で呼ばれる） */
export function playKindTone(kind: PunchKind): void {
  playOrDefer(() => {
    switch (kind) {
      case 'clock_in': // 上昇
        tone(523.25, 0, 0.12) // C5
        tone(784.0, 0.1, 0.18) // G5
        break
      case 'break_start': // 単音
        tone(659.25, 0, 0.16) // E5
        break
      case 'break_end': // 対の音
        tone(659.25, 0, 0.1) // E5
        tone(880.0, 0.11, 0.16) // A5
        break
      case 'clock_out': // 下降
        tone(784.0, 0, 0.12) // G5
        tone(523.25, 0.1, 0.18) // C5
        break
    }
  })
}

/** バイブレーション（未対応端末では何もしない） */
export function vibrate(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern)
  } catch {
    /* 非対応 */
  }
}
