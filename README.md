# SHIN勤怠

打刻・シフト・勤怠管理アプリ。TanStack Start + Supabase + Cloudflare Workers。

## スタック

| 領域 | 採用 |
| --- | --- |
| フレームワーク | TanStack Start (`@tanstack/react-start`) + TanStack Router (file-based) |
| ビルド | Vite 7 / React 19 / TypeScript |
| DB・認証 | Supabase (`@supabase/supabase-js`) |
| ホスティング | Cloudflare Workers (SSR / Edge) |

Next.js は使いません。環境変数は Vite 規約（`VITE_` 接頭辞）です。

## セットアップ

```bash
npm install
cp .env.example .env   # 値を各自で設定
npm run dev            # http://localhost:8080
```

`.env` に必要なキー（実値はコミットしないこと）:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

Supabase ダッシュボードの Project Settings → API から取得できます。

## スクリプト

| コマンド | 内容 |
| --- | --- |
| `npm run dev` | 開発サーバー（port 8080, strictPort） |
| `npm run build` | 本番ビルド |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run deploy` | typecheck → build → `wrangler deploy` |
| `npm run types:gen` | リモートDBから `src/lib/database.types.ts` を再生成 |

`npm run deploy` は typecheck と build を必ず通してから Workers へ出します。`wrangler deploy` を単体で叩かないでください。

## ディレクトリ

```
src/
├── lib/
│   ├── database.types.ts   # supabase gen types の出力（手で編集しない）
│   ├── supabase.ts         # createClient<Database> 唯一の初期化点
│   └── auth/               # AuthProvider / QueryClient
├── routes/                 # file-based routing
│   ├── __root.tsx
│   └── index.tsx
└── router.tsx
supabase/migrations/        # 0001_schema / 0002_rls / 0003_seed
```

Supabase クライアントは `src/lib/supabase.ts` の1箇所のみで生成します。他所で `createClient` を呼ばないでください。

```ts
import { supabase, type Tables } from '@/lib/supabase'

const { data } = await supabase.from('staff').select('*')
//    ^? Tables<'staff'>[]
```

## データベース

マイグレーションは `supabase/migrations/` にあり、リモート（`phwhhmqbmgcrdjqpjmsh`）へ適用済みです。

```bash
npx supabase migration list --linked   # 適用状況の確認
npx supabase db push                   # 未適用ぶんを反映（破壊的。実行前に必ず確認）
```

型を再生成した場合は `npm run typecheck` を通してからコミットしてください。
