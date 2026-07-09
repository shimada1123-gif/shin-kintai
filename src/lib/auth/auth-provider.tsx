import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { getSupabase } from './supabase-client'

interface AuthState {
  session: Session | null
  user: User | null
  /** 初回セッション解決が終わるまで true。ここで画面を出し分ける。 */
  loading: boolean
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthState>({
  session: null,
  user: null,
  loading: true,
  signOut: async () => {},
})

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<Omit<AuthState, 'signOut'>>({
    session: null,
    user: null,
    loading: true,
  })

  useEffect(() => {
    let active = true
    // getSession() が解決するまで false。onAuthStateChange の
    // INITIAL_SESSION / 復元 SIGNED_IN の二重発火で loading を落とさないためのガード。
    let initialResolved = false
    let unsubscribe: (() => void) | undefined

    void getSupabase().then((supabase) => {
      if (!active) return

      // コールバック内で supabase の非同期 API を呼ぶとデッドロックしうる。state 更新のみ。
      const { data } = supabase.auth.onAuthStateChange((_event, session) => {
        if (!active) return
        setState({
          session,
          user: session?.user ?? null,
          loading: !initialResolved,
        })
      })
      unsubscribe = () => data.subscription.unsubscribe()

      void supabase.auth.getSession().then(({ data: { session } }) => {
        if (!active) return
        initialResolved = true
        setState({ session, user: session?.user ?? null, loading: false })
      })
    })

    return () => {
      active = false
      unsubscribe?.()
    }
  }, [])

  const signOut = useCallback(async () => {
    const supabase = await getSupabase()
    await supabase.auth.signOut()
  }, [])

  return <AuthContext.Provider value={{ ...state, signOut }}>{children}</AuthContext.Provider>
}

export function useAuth() {
  return useContext(AuthContext)
}
