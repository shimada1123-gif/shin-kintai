-- 0022_staff_day_off.sql
-- 目的: 社員の公休（管理者が入れる確定的な休み）を持つ専用テーブルと、社員判定フラグ。
-- 用途: 統合グリッドで社員の休みを可視化＋自動シフトのゲート判定（社員全員が公休設定済みか）。
-- 方針: shift_availability(希望○△×)とは別テーブル（公休は確定・管理者設定で性質が異なる）。
--       社員判定は employment_kinds.is_regular（ラベル一致は店の命名で外れるため列で持つ）。

-- ① 社員判定フラグ（employment_kinds）
alter table public.employment_kinds add column if not exists is_regular boolean not null default false;

-- ② 社員の公休テーブル
create table public.staff_day_off (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  staff_id    uuid not null references public.staff(id) on delete cascade,
  store_id    uuid not null references public.stores(id) on delete cascade,
  work_date   date not null,
  kind        text not null default 'public'
                check (kind in ('public','paid','other')),  -- 公休/有給/その他
  note        text,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (staff_id, store_id, work_date)   -- 同一スタッフ・店・日は1件
);

create index idx_sdo_store_date on public.staff_day_off(store_id, work_date);
create index idx_sdo_staff on public.staff_day_off(staff_id);

alter table public.staff_day_off enable row level security;

-- RLS: 閲覧=メンバー（グリッド/マイシフトで見る）、編集=shift_edit∧自店（管理者が公休を入れる）
-- 本人も自分の公休は見える（app_staff_id 一致）
create policy sdo_sel on public.staff_day_off for select to authenticated
  using (
    public.app_is_member(tenant_id) and (
      public.app_can_store(store_id)
      or public.app_staff_id(tenant_id) = staff_id
    )
  );
create policy sdo_write on public.staff_day_off for all to authenticated
  using (public.app_has_perm(tenant_id,'shift_edit') and public.app_can_store(store_id))
  with check (public.app_has_perm(tenant_id,'shift_edit') and public.app_can_store(store_id));

-- ③ 既存の「社員」区分に is_regular=true を初期設定（label一致での初期化。以後はUIで管理）
update public.employment_kinds set is_regular = true where label in ('社員','正社員');
