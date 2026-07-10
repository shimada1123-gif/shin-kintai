-- SHIN勤怠 : 0007 シフト機能（希望・要件・確定）
-- shift_availability: スタッフの希望（○=avail / △=partial+時間 / ×=off）
-- shift_requirements: 曜日区分別の必要人数テンプレート（店舗ごと）
-- shift_assignments: 確定シフト（下書き/確定、0.5換算フラグ）

-- ① スタッフのシフト希望（人×店×日 で1希望＝掛け持ち対応）
create table public.shift_availability (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  store_id     uuid not null references public.stores(id) on delete cascade,
  staff_id     uuid not null references public.staff(id) on delete cascade,
  work_date    date not null,
  kind         text not null default 'off' check (kind in ('avail','partial','off')),
  start_min    integer,
  end_min      integer,
  note         text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (staff_id, store_id, work_date)
);
create index idx_avail_tenant on public.shift_availability(tenant_id);
create index idx_avail_store_date on public.shift_availability(store_id, work_date);
create index idx_avail_staff on public.shift_availability(staff_id);

-- ② 曜日区分別の必要人数テンプレート（店舗ごと）
create table public.shift_requirements (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  store_id    uuid not null references public.stores(id) on delete cascade,
  day_type    text not null check (day_type in ('weekday','fri','sat','sun','holiday')),
  need_count  integer not null default 0,
  min_by_kind jsonb not null default '{}'::jsonb,
  memo        text,
  created_at  timestamptz not null default now(),
  unique (store_id, day_type)
);
create index idx_req_tenant on public.shift_requirements(tenant_id);
create index idx_req_store on public.shift_requirements(store_id);

-- ③ 確定シフト
create table public.shift_assignments (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  store_id     uuid not null references public.stores(id) on delete cascade,
  staff_id     uuid not null references public.staff(id) on delete cascade,
  work_date    date not null,
  start_min    integer not null,
  end_min      integer not null,
  position_id  uuid references public.positions(id) on delete set null,
  weight_half  boolean not null default false,
  status       text not null default 'draft' check (status in ('draft','published')),
  note         text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index idx_sa2_tenant on public.shift_assignments(tenant_id);
create index idx_sa2_store_date on public.shift_assignments(store_id, work_date);
create index idx_sa2_staff on public.shift_assignments(staff_id);

-- RLS 有効化
alter table public.shift_availability  enable row level security;
alter table public.shift_requirements  enable row level security;
alter table public.shift_assignments   enable row level security;

-- shift_availability: 本人は自分×自店の希望を読み書き。管理者(shift_edit+自店)も編集
create policy avail_sel on public.shift_availability for select to authenticated
  using (public.app_can_store(store_id) or public.app_staff_id(tenant_id) = staff_id);
create policy avail_ins on public.shift_availability for insert to authenticated
  with check (
    (public.app_staff_id(tenant_id) = staff_id and public.app_can_store(store_id))
    or (public.app_has_perm(tenant_id,'shift_edit') and public.app_can_store(store_id))
  );
create policy avail_upd on public.shift_availability for update to authenticated
  using (
    (public.app_staff_id(tenant_id) = staff_id and public.app_can_store(store_id))
    or (public.app_has_perm(tenant_id,'shift_edit') and public.app_can_store(store_id))
  )
  with check (
    (public.app_staff_id(tenant_id) = staff_id and public.app_can_store(store_id))
    or (public.app_has_perm(tenant_id,'shift_edit') and public.app_can_store(store_id))
  );
create policy avail_del on public.shift_availability for delete to authenticated
  using (
    (public.app_staff_id(tenant_id) = staff_id and public.app_can_store(store_id))
    or (public.app_has_perm(tenant_id,'shift_edit') and public.app_can_store(store_id))
  );

-- shift_requirements: メンバー閲覧、shift_edit+自店で編集
create policy req_sel on public.shift_requirements for select to authenticated
  using (public.app_is_member(tenant_id));
create policy req_write on public.shift_requirements for all to authenticated
  using (public.app_has_perm(tenant_id,'shift_edit') and public.app_can_store(store_id))
  with check (public.app_has_perm(tenant_id,'shift_edit') and public.app_can_store(store_id));

-- shift_assignments: 本人は自分の確定シフト閲覧。管理者(shift_edit+自店)で編集
create policy sa2_sel on public.shift_assignments for select to authenticated
  using (public.app_can_store(store_id) or public.app_staff_id(tenant_id) = staff_id);
create policy sa2_write on public.shift_assignments for all to authenticated
  using (public.app_has_perm(tenant_id,'shift_edit') and public.app_can_store(store_id))
  with check (public.app_has_perm(tenant_id,'shift_edit') and public.app_can_store(store_id));
