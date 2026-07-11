-- 0026_requirement_overrides.sql
-- 目的: 必要人数の日付上書き shift_requirement_overrides。曜日区分テンプレ(shift_requirements)の
--   "上に重ねる" 例外日レイヤ。テンプレは無改変。
-- 解決順(確定): ovr[date,band] → ovr[date,通し(null)] → tpl[day_type,band] → tpl[day_type,通し] → 定休0(UI層)。
--   override 行が見つかった枠は行単位で丸ごと採用(ポジション別キーのマージはしない)。
-- need_by_position は position_id キーのみ(0024踏襲・名前キー禁止)。
-- 認可: shift_edit 続用・RLSはreq型ミラー・書込はクライアント直接upsert
--   (onConflict 'store_id,work_date,time_band_id'。definer RPC は作らない)。
-- 順序: [DDL] テーブル＋index → [RLS]。新規テーブル・移行DMLなし・制約張替なし・関数なし。

-- ============ [DDL] テーブル ============
-- shift_requirements とカラム構成を極力ミラー(day_type → work_date に置換)。
create table public.shift_requirement_overrides (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  store_id         uuid not null references public.stores(id)  on delete cascade,
  work_date        date not null,
  time_band_id     uuid references public.shift_time_bands(id) on delete restrict,  -- nullable=通し
  need_count       int not null default 0,
  need_by_position jsonb not null default '{}'::jsonb,  -- id キーのみ(0024踏襲)
  min_by_kind      jsonb not null default '{}'::jsonb,
  memo             text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- 0020 と同型: null(通し)同士も同一扱い＝日付ごと1行を一意化。upsert onConflict をこの3列に向ける
  unique nulls not distinct (store_id, work_date, time_band_id)
);
create index idx_sro_store_date on public.shift_requirement_overrides(store_id, work_date);
create index idx_sro_tenant     on public.shift_requirement_overrides(tenant_id);

-- ============ [RLS] req型ミラー(0007 req_sel/req_write と同型) ============
alter table public.shift_requirement_overrides enable row level security;

create policy ovr_sel on public.shift_requirement_overrides for select to authenticated
  using (public.app_is_member(tenant_id));
create policy ovr_write on public.shift_requirement_overrides for all to authenticated
  using (public.app_has_perm(tenant_id,'shift_edit') and public.app_can_store(store_id))
  with check (public.app_has_perm(tenant_id,'shift_edit') and public.app_can_store(store_id));
