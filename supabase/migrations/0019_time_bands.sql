-- 0019_time_bands.sql
-- 目的: 店舗が営業の時間帯（モーニング/ランチ/ディナー/深夜 等）を自由定義できる時間帯マスタ。
-- 用途: 必要人数(shift_requirements)を曜日×時間帯の粒度で持つ布石＋グリッドの過不足バンドの軸。
-- 方針: positions/employment_kinds と同じRLS（メンバー閲覧 / staff_master_edit 編集）。
--       深夜跨ぎ（例 23:00〜翌2:00 = 1380〜1560）を許容するため end_min の上限を 1560 とする。

create table public.shift_time_bands (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  store_id    uuid not null references public.stores(id) on delete cascade,
  name        text not null,                 -- 店が自由に命名（モーニング/ランチ/ディナー/深夜…）
  start_min   int  not null,
  end_min     int  not null,
  sort_order  int  not null default 0,        -- 表示順（朝→夜）
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  check (start_min >= 0 and start_min < 1440),
  check (end_min > start_min and end_min <= 1560)  -- 翌2:00(1560)まで＝深夜跨ぎ許容
);

create index idx_stb_store on public.shift_time_bands(store_id, sort_order);

alter table public.shift_time_bands enable row level security;

-- 閲覧: メンバー全員（グリッド/必要人数/シフトで参照）。編集: staff_master_edit（positions と同一方針）
create policy stb_sel on public.shift_time_bands for select to authenticated
  using (public.app_is_member(tenant_id));
create policy stb_write on public.shift_time_bands for all to authenticated
  using (public.app_has_perm(tenant_id,'staff_master_edit'))
  with check (public.app_has_perm(tenant_id,'staff_master_edit'));
