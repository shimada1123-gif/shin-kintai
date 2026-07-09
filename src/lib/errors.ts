import type { PostgrestError } from '@supabase/supabase-js'

/**
 * RLS が最終防壁。弾かれたときも利用者に意味の通る日本語を出す。
 * PostgREST は RLS 違反を 42501、または「new row violates row-level security policy」で返す。
 */
export function pgErrorToJa(e: PostgrestError | Error | null | undefined, fallback = '処理に失敗しました'): string {
  if (!e) return fallback
  const message = e.message ?? ''
  const code = 'code' in e ? e.code : undefined

  if (code === '42501' || /row-level security/i.test(message)) {
    return '権限がありません。この操作にはスタッフ・店舗マスタの編集権限（staff_master_edit）が必要です。'
  }
  if (code === '23505') return 'すでに同じ内容が登録されています。'
  if (code === '23503') return '関連するデータが見つかりません。店舗や区分の指定を確認してください。'
  if (code === '23514') return '入力値が許容範囲外です。'
  if (code === '23502') return '必須項目が入力されていません。'
  if (/Failed to fetch|NetworkError/i.test(message)) {
    return 'ネットワークに接続できません。通信環境を確認してください。'
  }
  return `${fallback}（${message}）`
}

export function errText(e: unknown, fallback = '処理に失敗しました'): string {
  if (e instanceof Error) return pgErrorToJa(e, fallback)
  return fallback
}
