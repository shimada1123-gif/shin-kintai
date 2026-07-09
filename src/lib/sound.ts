import type { PunchKind } from '@/lib/server/punch'

/**
 * 効果音ユーティリティ（Web Audio で合成。音声ファイル不要）。
 * ブラウザの自動再生制限があるため、初回のユーザー操作で AudioContext を
 * resume する（initSoundUnlock を画面マウント時に呼んでおく）。
 */

let ctx: AudioContext | null = null
let unlocked = false

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (!ctx) {
    const AC =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return null
    ctx = new AC()
  }
  return ctx
}

export function unlockAudio(): void {
  const c = getCtx()
  if (c && c.state === 'suspended') void c.resume()
  unlocked = true
}

/** 初回の pointerdown / keydown で自動再生制限を解除する（1回だけ） */
export function initSoundUnlock(): void {
  if (typeof window === 'undefined' || unlocked) return
  const handler = () => unlockAudio()
  window.addEventListener('pointerdown', handler, { once: true })
  window.addEventListener('keydown', handler, { once: true })
}

/** 単音。at 秒後に dur 秒だけ鳴らす（エンベロープ付きでクリックノイズを避ける） */
function tone(
  freq: number,
  at: number,
  dur: number,
  type: OscillatorType = 'sine',
  peak = 0.18,
): void {
  const c = getCtx()
  if (!c) return
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
  unlockAudio()
  if (kind === 'clock_out') {
    tone(1046.5, 0, 0.22) // C6
    tone(784.0, 0.16, 0.34) // G5
  } else {
    tone(1318.5, 0, 0.2) // E6
    tone(1046.5, 0.15, 0.38) // C6
  }
}

/** 打刻失敗: ブブー（低い2音のブザー） */
export function playPunchError(): void {
  unlockAudio()
  tone(196, 0, 0.18, 'square', 0.11) // G3
  tone(185, 0.22, 0.32, 'square', 0.11) // F#3
}

/** 店舗端末: 種別ボタンの軽い操作音 */
export function playKindTone(kind: PunchKind): void {
  unlockAudio()
  switch (kind) {
    case 'clock_in': // 上昇
      tone(523.25, 0, 0.12) // C5
      tone(784.0, 0.1, 0.18) // G5
      break
    case 'break_start': // 単音
      tone(659.25, 0, 0.16) // E5
      break
    case 'break_end': // 対の音（開始と対になる2音）
      tone(659.25, 0, 0.1) // E5
      tone(880.0, 0.11, 0.16) // A5
      break
    case 'clock_out': // 下降
      tone(784.0, 0, 0.12) // G5
      tone(523.25, 0.1, 0.18) // C5
      break
  }
}

/** バイブレーション（未対応端末では何もしない） */
export function vibrate(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern)
  } catch {
    /* 非対応 */
  }
}
