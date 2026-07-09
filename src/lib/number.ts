/** 全角数字・記号を半角へ。IME 経由の入力を数値として解釈できるようにする。 */
export function normalizeNumeric(input: string): string {
  return input
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[．。]/g, '.')
    .replace(/[，、,]/g, '')
    .replace(/[－ー−―]/g, '-')
    .replace(/\s/g, '')
    .trim()
}

/** 空欄は 0 ではなく null。整数として解釈できなければ null。 */
export function parseIntOrNull(input: string): number | null {
  const s = normalizeNumeric(input)
  if (s === '') return null
  const n = Number(s)
  if (!Number.isFinite(n)) return null
  return Math.trunc(n)
}

/** 小数を許す版（座標など） */
export function parseFloatOrNull(input: string): number | null {
  const s = normalizeNumeric(input)
  if (s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** DB の integer カラムへ送る直前の正規化。null はそのまま null。 */
export function toInteger(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  return Math.trunc(value)
}

/** null を 0 として扱いたいカラム（commute_amount は not null default 0） */
export function toIntegerOrZero(value: number | null | undefined): number {
  return toInteger(value) ?? 0
}
