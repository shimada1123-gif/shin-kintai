import { useEffect, useState } from 'react'

/** 入力のデバウンス（検索ボックス用）。ms 経過後に値が確定する。 */
export function useDebounced<T>(value: T, ms = 300): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return debounced
}
