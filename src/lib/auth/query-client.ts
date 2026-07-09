import { QueryClient } from '@tanstack/react-query'

/**
 * networkMode: 'always'
 * Workers/SSR 環境では navigator.onLine が当てにならず、既定の 'online' だと
 * クエリが paused のまま進まないことがある。常に発火させる。
 */
export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        networkMode: 'always',
        retry: 1,
        staleTime: 30_000,
        refetchOnWindowFocus: false,
      },
      mutations: {
        networkMode: 'always',
      },
    },
  })
}
