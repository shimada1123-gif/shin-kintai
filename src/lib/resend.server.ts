// このモジュールはサーバー（Workers）専用。
// クライアントから import された時点でビルドが violation として落ちる。
import '@tanstack/react-start/server-only'

/**
 * Resend によるメール送信。RESEND_API_KEY を読むのはこのファイルだけ。
 * キーは VITE_ 接頭辞を持たない env（本番: wrangler secret / ローカル: .dev.vars）。
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails'
const FROM = 'SHIN勤怠 <no-reply@world-wave.net>'

export interface MailResult {
  ok: boolean
  error?: string
}

export async function sendMail(to: string, subject: string, text: string): Promise<MailResult> {
  const key = process.env.RESEND_API_KEY
  if (!key) {
    return { ok: false, error: 'RESEND_API_KEY が未設定です' }
  }
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FROM, to: [to], subject, text }),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      return { ok: false, error: `Resend ${res.status}: ${detail.slice(0, 300)}` }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '送信時にネットワークエラー' }
  }
}
