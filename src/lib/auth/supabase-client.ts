import type { supabase as SupabaseClient } from '@/lib/supabase'

/**
 * src/lib/supabase.ts は import 時に VITE_ env を検証して throw する。
 * SSR（Workers）では評価させたくないため、クライアントでのみ動的 import する。
 * 生成済みモジュールは ESM のキャッシュにより 1 度しか評価されない。
 */
export async function getSupabase(): Promise<typeof SupabaseClient> {
  const { supabase } = await import('@/lib/supabase')
  return supabase
}
