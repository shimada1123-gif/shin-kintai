// サーバー（Workers）専用。クライアントから import された時点でビルドが落ちる。
import '@tanstack/react-start/server-only'

/**
 * 据置QR表示ページの署名鍵。VITE_ 接頭辞を持たない env から読むため
 * クライアントバンドルには載らない。ローカルは .dev.vars、本番は wrangler secret。
 */
function getSecret(): string {
  const secret = process.env.QR_DISPLAY_SECRET
  if (!secret) {
    throw new Error(
      'QR_DISPLAY_SECRET が未設定です。ローカルは .dev.vars、本番は wrangler secret で設定してください。',
    )
  }
  return secret
}

const encoder = new TextEncoder()

function toBase64Url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** HMAC-SHA256(QR_DISPLAY_SECRET, storeId) を base64url で返す */
export async function signStoreId(storeId: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(getSecret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(storeId))
  return toBase64Url(new Uint8Array(mac))
}

/**
 * 署名の検証。比較は定数時間で行い、早期 return による
 * タイミングリークを避ける（署名の総当たりを助けない）。
 */
export async function verifyStoreSig(storeId: string, sig: string): Promise<boolean> {
  const expected = await signStoreId(storeId)
  return timingSafeEqual(expected, sig)
}

/** 文字列長も含めて定数時間で比較する */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a)
  const bb = encoder.encode(b)

  // 長さが違っても比較そのものは同じ回数だけ回す
  const len = Math.max(ab.length, bb.length)
  let diff = ab.length ^ bb.length
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0)
  }
  return diff === 0
}

/** QRに載せるワンタイムトークン（32バイトの乱数） */
export function generateToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return toBase64Url(bytes)
}
