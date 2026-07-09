import { createFileRoute, Navigate } from '@tanstack/react-router'
import { AppShell } from '@/components/AppShell'
import { useAuth } from '@/lib/auth'
import { MeProvider, useMe } from '@/lib/me-context'

export const Route = createFileRoute('/_authed')({
  component: AuthedLayout,
})

function AuthedLayout() {
  const { session, loading } = useAuth()

  // 初回セッション解決前にリダイレクトすると、リロードのたびに /login へ飛んでしまう
  if (loading) return <div className="centered-note">読み込み中…</div>
  if (!session) return <Navigate to="/login" />

  return (
    <MeProvider>
      <MeGate />
    </MeProvider>
  )
}

function MeGate() {
  const { me, loading, error } = useMe()

  if (loading) return <div className="centered-note">読み込み中…</div>
  if (error) {
    return (
      <div className="centered-note">
        <p className="login-error" role="alert">
          {error.message}
        </p>
      </div>
    )
  }
  if (!me) return <div className="centered-note">読み込み中…</div>

  return <AppShell />
}
