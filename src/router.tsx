import { createRouter } from '@tanstack/react-router'
import { createQueryClient } from '@/lib/auth'
import { routeTree } from './routeTree.gen'

export const getRouter = () => {
  const queryClient = createQueryClient()

  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: 'intent',
    scrollRestoration: true,
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
