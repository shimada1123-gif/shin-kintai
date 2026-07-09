-- SHIN勤怠 Phase 1 : schema
-- tenancy / staff / rbac / attendance / holidays / audit
-- 実行は Supabase が Healthy になってから（db push）。まずはファイルのみ。

create extension if not exists pgcrypto;

-- ============ 組織・店舗 ============
create table public.tenants (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  settings   jsonb not null default '{}'::jsonb,   -- 割増率・GPSポリシー等
  created_at timestamptz not null default now()
);

create table public.areas (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  name       text not null,
  created_at timestamptz not null default now()
);
create index idx_areas_tenant on public.areas(tenant_id);

create table public.stores (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  area_id           uuid references public.areas(id) on delete set null,
  name              text not null,
  lat               double precision,
  lng               double precision,
  geofence_radius_m integer not null default 80,
  timezone          text not null default 'Asia/Tokyo',
  gps_policy        text not null default 'flag' check (gps_policy in ('flag','block')),
  settings          jsonb not null default '{}'::jsonb,   -- 営業時間等
  created_at        timestamptz not null default now()
);
create index idx_stores_tenant on public.stores(tenant_id);
create index idx_stores_area   on public.stores(area_id);

-- ============ 人・区分・所属 ============
create table public.employment_kinds (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  label           text not null,                 -- 社員/パート/アルバイト/業務委託…（自由）
  is_hourly       boolean not null default true,
  requires_clock  boolean not null default true, -- 業務委託=false
  applies_premium boolean not null default true, -- 業務委託=false（割増対象外）
  created_at      timestamptz not null default now()
);
create index idx_ek_tenant on public.employment_kinds(tenant_id);

create table public.positions (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  store_id   uuid references public.stores(id) on delete cascade,  -- null=店共通
  name       text not null,                       -- キッチン/フロア/洗い場…
  created_at timestamptz not null default now()
);
create index idx_positions_tenant on public.positions(tenant_id);

create table public.staff (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  full_name  text not null,
  phone      text,
  email      text,
  user_id    uuid references auth.users(id) on delete set null,  -- 打刻用ログイン紐付け
  status     text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now()
);
create index idx_staff_tenant on public.staff(tenant_id);
create index idx_staff_user   on public.staff(user_id);

create table public.staff_assignments (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  staff_id            uuid not null references public.staff(id) on delete cascade,
  store_id            uuid not null references public.stores(id) on delete cascade,
  employment_kind_id  uuid references public.employment_kinds(id) on delete set null,
  position_default_id uuid references public.positions(id) on delete set null,
  wage_type           text not null default 'hourly' check (wage_type in ('hourly','fixed','invoice')),
  hourly_wage         integer,
  monthly_fixed       integer,
  commute_type        text not null default 'none' check (commute_type in ('none','daily','monthly')),
  commute_amount      integer not null default 0,
  is_newbie           boolean not null default false,
  is_trainer          boolean not null default false,
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  unique (staff_id, store_id)
);
create index idx_sa_tenant on public.staff_assignments(tenant_id);
create index idx_sa_store  on public.staff_assignments(store_id);
create index idx_sa_staff  on public.staff_assignments(staff_id);

create table public.staff_tags (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  staff_id   uuid not null references public.staff(id) on delete cascade,
  tag        text not null,
  created_at timestamptz not null default now(),
  unique (staff_id, tag)
);
create index idx_tags_tenant on public.staff_tags(tenant_id);

-- ============ RBAC ============
create table public.memberships (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  user_id        uuid not null references auth.users(id) on delete cascade,
  role           text not null check (role in ('owner','area_manager','store_manager','staff')),
  scope_area_id  uuid references public.areas(id) on delete cascade,
  scope_store_id uuid references public.stores(id) on delete cascade,
  staff_id       uuid references public.staff(id) on delete set null,  -- 本人スタッフ紐付け
  created_at     timestamptz not null default now(),
  unique (tenant_id, user_id)
);
create index idx_mem_user   on public.memberships(user_id);
create index idx_mem_tenant on public.memberships(tenant_id);

-- owner は常時フル権限のため role_permissions には含めない
create table public.role_permissions (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  role           text not null check (role in ('area_manager','store_manager','staff')),
  permission_key text not null,
  allowed        boolean not null default false,
  unique (tenant_id, role, permission_key)
);
create index idx_rp_tenant on public.role_permissions(tenant_id);

-- ============ 打刻 ============
create table public.qr_tokens (
  id         uuid primary key default gen_random_uuid(),
  store_id   uuid not null references public.stores(id) on delete cascade,
  token      text not null,
  issued_at  timestamptz not null default now(),
  expires_at timestamptz not null                -- 60秒失効
);
create index idx_qr_store on public.qr_tokens(store_id);
create index idx_qr_token on public.qr_tokens(token);

create table public.attendance (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  staff_id     uuid not null references public.staff(id) on delete cascade,
  store_id     uuid not null references public.stores(id) on delete cascade,
  clock_in_at  timestamptz not null default now(),
  clock_out_at timestamptz,
  source       text not null default 'qr',
  gps_lat      double precision,
  gps_lng      double precision,
  gps_status   text not null default 'unverified' check (gps_status in ('ok','unverified','out')),
  created_at   timestamptz not null default now()
);
create index idx_att_tenant on public.attendance(tenant_id);
create index idx_att_store  on public.attendance(store_id);
create index idx_att_staff  on public.attendance(staff_id);

create table public.attendance_breaks (
  id             uuid primary key default gen_random_uuid(),
  attendance_id  uuid not null references public.attendance(id) on delete cascade,
  break_start_at timestamptz not null default now(),
  break_end_at   timestamptz
);
create index idx_brk_att on public.attendance_breaks(attendance_id);

create table public.attendance_corrections (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  attendance_id uuid not null references public.attendance(id) on delete cascade,
  requested_by  uuid references auth.users(id) on delete set null,
  target_field  text not null,           -- clock_in_at / clock_out_at / break_end_at ...
  old_value     text,
  new_value     text,
  reason        text,
  status        text not null default 'pending' check (status in ('pending','approved','rejected')),
  approved_by   uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index idx_corr_tenant on public.attendance_corrections(tenant_id);
create index idx_corr_att    on public.attendance_corrections(attendance_id);

-- ============ 祝日・監査 ============
create table public.holidays (       -- 日本の祝日（全テナント共通の参照表）
  holiday_date date primary key,
  name         text not null
);

create table public.access_logs (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid references public.tenants(id) on delete cascade,
  user_id    uuid references auth.users(id) on delete set null,
  action     text not null,
  target     text,
  created_at timestamptz not null default now()
);
create index idx_log_tenant on public.access_logs(tenant_id);
