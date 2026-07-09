import { createStart } from '@tanstack/react-start'
import { getSupabase } from '@/lib/auth/supabase-client'

/**
 * Server Function 呼び出しに、現在のセッションのアクセストークンを載せる。
 * サーバー側はこの Bearer を検証して「誰が呼んだか」を確定する。
 */
export const startInstance = createStart(() => ({
  serverFns: {
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers ?? {})
      if (typeof window !== 'undefined' && !headers.has('authorization')) {
        const supabase = await getSupabase()
        const { data } = await supabase.auth.getSession()
        const token = data.session?.access_token
        if (token) headers.set('authorization', `Bearer ${token}`)
      }
      return fetch(input, { ...init, headers })
    },
  },
}))
