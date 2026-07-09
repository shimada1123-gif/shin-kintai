/**
 * 住所 → 座標（国土地理院ジオコーディングAPI）。
 * - 無料・APIキー不要・日本住所向け
 * - Access-Control-Allow-Origin: * を実測確認済み → ブラウザから直接 fetch できる
 * - レスポンスは GeoJSON Feature の配列。geometry.coordinates は [経度, 緯度] の順
 */

export interface GeocodeResult {
  lat: number
  lng: number
  /** APIが解決した住所表記（例: 東京都渋谷区道玄坂二丁目１番） */
  label: string
}

interface GsiFeature {
  geometry?: { coordinates?: [number, number] }
  properties?: { title?: string }
}

/** 見つからなければ null。ネットワーク失敗は throw（呼び出し側で日本語化）。 */
export async function geocodeAddress(query: string): Promise<GeocodeResult | null> {
  const q = query.trim()
  if (!q) return null

  const res = await fetch(
    `https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(q)}`,
  )
  if (!res.ok) throw new Error(`ジオコーディングAPIがエラーを返しました（${res.status}）`)

  const features = (await res.json()) as GsiFeature[]
  const first = features?.[0]
  const coords = first?.geometry?.coordinates
  if (!coords || coords.length < 2) return null

  const [lng, lat] = coords
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null

  return { lat, lng, label: first.properties?.title ?? q }
}
