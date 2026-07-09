import { useState } from 'react'
import { createFileRoute, Navigate } from '@tanstack/react-router'
import type { AuthError } from '@supabase/supabase-js'
import { getSupabase } from '@/lib/auth/supabase-client'
import { useAuth } from '@/lib/auth'

export const Route = createFileRoute('/login')({
  validateSearch: (s: Record<string, unknown>) => ({
    redirect: typeof s.redirect === 'string' && s.redirect ? s.redirect : undefined,
  }),
  component: LoginPage,
})

/**
 * ログイン後の戻り先。オープンリダイレクト防止のため、
 * サイト内の相対パス（/ で始まり // ではない）だけを許可する。
 */
function safeRedirect(target: string | undefined): string {
  if (target && target.startsWith('/') && !target.startsWith('//')) return target
  return '/'
}

/** Supabase の英語メッセージを、現場で意味の通る日本語にする */
function toJapanese(error: AuthError): string {
  switch (error.code) {
    case 'invalid_credentials':
      return 'メールまたはパスワードが違います。'
    case 'email_not_confirmed':
      return 'メールアドレスが未確認です。確認メールのリンクを開いてください。'
    case 'user_banned':
      return 'このアカウントは利用停止中です。管理者に連絡してください。'
    case 'over_request_rate_limit':
      return '試行回数が多すぎます。しばらく待ってから再度お試しください。'
    case 'validation_failed':
      return 'メールアドレスとパスワードを入力してください。'
    default:
      if (error.status === 0 || error.message.includes('fetch')) {
        return 'ネットワークに接続できません。通信環境を確認してください。'
      }
      return `ログインできませんでした（${error.message}）`
  }
}

function LoginPage() {
  const { session, loading: authLoading } = useAuth()
  const { redirect } = Route.useSearch()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  if (authLoading) return <CenteredNote>読み込み中…</CenteredNote>
  if (session) return <Navigate to={safeRedirect(redirect)} />

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const supabase = await getSupabase()
      const { error: authError } = await supabase.auth.signInWithPassword({ email, password })
      if (authError) setError(toJapanese(authError))
      // 成功時は onAuthStateChange が session を更新し、上の Navigate が発火する
    } catch {
      setError('予期しないエラーが発生しました。時間をおいて再度お試しください。')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={onSubmit}>
        <div className="login-brand">
          <div className="noren" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </div>
          <h1>
            SHIN<span>勤怠</span>
          </h1>
        </div>
        <p className="login-sub">スタッフ・管理者ログイン</p>

        {error && (
          <p className="login-error" role="alert">
            {error}
          </p>
        )}

        <label className="field">
          <span>メールアドレス</span>
          <input
            type="email"
            value={email}
            autoComplete="username"
            required
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>

        <label className="field">
          <span>パスワード</span>
          <input
            type="password"
            value={password}
            autoComplete="current-password"
            required
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        <button type="submit" className="btn-primary" disabled={submitting}>
          {submitting ? 'ログイン中…' : 'ログイン'}
        </button>
      </form>
    </div>
  )
}

function CenteredNote({ children }: { children: React.ReactNode }) {
  return <div className="centered-note">{children}</div>
}
