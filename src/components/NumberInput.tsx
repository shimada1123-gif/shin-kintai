import { useEffect, useState } from 'react'
import { normalizeNumeric, parseFloatOrNull, parseIntOrNull } from '@/lib/number'

interface Props {
  value: number | null
  onChange: (value: number | null) => void
  min?: number
  placeholder?: string
  id?: string
  className?: string
  /** 座標のように小数を許す場合 */
  decimal?: boolean
  'aria-label'?: string
}

/**
 * 数値入力。
 * - 空欄は 0 ではなく null（「未入力」を 0 と区別する）
 * - 先頭ゼロを残さない（"05" と打っても表示は "5"）
 * - 全角数字・全角ピリオド・カンマを受け付ける
 */
export function NumberInput({
  value,
  onChange,
  min,
  placeholder,
  id,
  className,
  decimal = false,
  ...rest
}: Props) {
  const [text, setText] = useState(value === null ? '' : String(value))

  // 外部から値が差し替わったとき（別の所属を編集した等）に表示を追随させる。
  // 入力中の "1." のような中間状態は壊さない。
  useEffect(() => {
    const current = decimal ? parseFloatOrNull(text) : parseIntOrNull(text)
    if (current !== value) setText(value === null ? '' : String(value))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  const handle = (raw: string) => {
    const normalized = normalizeNumeric(raw)

    if (normalized === '') {
      setText('')
      onChange(null)
      return
    }

    // 小数入力の途中（"1." や "-"）はそのまま保持し、確定値は送らない
    if (decimal && /^-?\d*\.?\d*$/.test(normalized) && /[.]$|^-$/.test(normalized)) {
      setText(normalized)
      return
    }

    const parsed = decimal ? parseFloatOrNull(normalized) : parseIntOrNull(normalized)
    if (parsed === null) return // 数字以外は無視して直前の表示を維持

    // 正規化した値を表示に反映する = 先頭ゼロが残らない
    setText(String(parsed))
    onChange(parsed)
  }

  return (
    <input
      {...rest}
      id={id}
      className={className}
      type="number"
      inputMode={decimal ? 'decimal' : 'numeric'}
      min={min}
      step={decimal ? 'any' : 1}
      placeholder={placeholder}
      value={text}
      onChange={(e) => handle(e.target.value)}
    />
  )
}
