import { createRootRouteWithContext, HeadContent, Link, Scripts } from '@tanstack/react-router'
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { AuthProvider } from '@/lib/auth'
import appCss from '../styles.css?url'

interface RouterContext {
  queryClient: QueryClient
}

function NotFound() {
  return (
    <main style={{ padding: '2rem', textAlign: 'center' }}>
      <h1>404</h1>
      <p>ページが見つかりません。</p>
      <Link to="/">トップへ</Link>
    </main>
  )
}

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
      { title: 'SHIN勤怠' },
      { name: 'description', content: 'SHIN勤怠 — 打刻・シフト・勤怠管理' },
    ],
    links: [
      { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
      { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossOrigin: 'anonymous' },
      {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=Zen+Kaku+Gothic+New:wght@400;500;700;900&family=Space+Mono:wght@400;700&display=swap',
      },
      { rel: 'stylesheet', href: appCss },
    ],
  }),
  notFoundComponent: NotFound,
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  const { queryClient } = Route.useRouteContext()

  return (
    <html lang="ja">
      <head>
        <HeadContent />
      </head>
      <body>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>{children}</AuthProvider>
        </QueryClientProvider>
        <Scripts />
      </body>
    </html>
  )
}
