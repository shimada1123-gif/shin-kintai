/**
 * CSV 生成・ダウンロード（日本の実務対応）。
 * - RFC4180: 値にカンマ / ダブルクオート / 改行を含む場合はクオートし、" は "" に重ねる
 * - 改行は CRLF
 * - UTF-8 with BOM（Excel の文字化け防止。﻿ は UTF-8 で EF BB BF になる）
 */

export function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

/** 2次元配列 → CRLF 区切りの CSV 文字列 */
export function buildCsv(rows: string[][]): string {
  return rows.map((r) => r.map(csvEscape).join(',')).join('\r\n') + '\r\n'
}

/** BOM 付き UTF-8 で Blob を作り、a 要素でダウンロードさせる */
export function downloadCsv(filename: string, rows: string[][]): void {
  // '﻿' = BOM。UTF-8 では EF BB BF として先頭に付く
  const bom = String.fromCharCode(0xfeff)
  const blob = new Blob([bom + buildCsv(rows)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
