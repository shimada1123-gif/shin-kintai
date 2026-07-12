-- 0030_meal_records.sql
-- 目的: 賄い（まかない）記録・集計。フェーズ1＝記録＋店長の未申告チェック＋月次集計まで（給与天引きは別途）。
-- マスタ: stores.settings.meal_pricing = { free: bool, breakfast: int, lunch: int, dinner: int }（案1・専用テーブルなし）。
-- 記録: meal_records（スタッフ×勤務日×区分）。price_snapshot に記録時点の単価を焼く（履歴保全＝
--   後でマスタ単価を変えても過去の賄い代は動かない。人件費/退職アーカイブと同じ思想）。
-- 認可（既存パターン踏襲・新perm新設なし）:
--   本人  = app_staff_id(tenant_id) = staff_id（memberships の user_id=auth.uid() から解決）
--   管理者 = app_has_perm(tenant_id,'shift_edit') and app_can_store(store_id)
--   ※ shift_availability(0007) の本人＋管理者ポリシーと同型（insert/update/delete を分割）。
-- 勤務日限定: shift_assignments に (staff_id, store_id, work_date) の配置がある日のみ記録可（RPC でガード）。
--   status は問わない（draft の週でも先に付けられる・確定前後で挙動が変わらない方が事故が少ない）。
-- 順序: [DDL] → [RLS] → [RPC] 2関数＋grant。移行DMLなし・既存テーブル/RLS の変更なし。

-- ============ [DDL] ============
create table public.meal_records (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  store_id        uuid not null references public.stores(id)  on delete cascade,
  staff_id        uuid not null references public.staff(id)   on delete cascade,
  work_date       date not null,
  meal_type       text not null check (meal_type in ('breakfast','lunch','dinner')),
  price_snapshot  int  not null default 0,   -- 記録時点の単価（無料店・無料設定は 0）
  entered_by      text not null check (entered_by in ('self','manager')),
  entered_by_user uuid,                      -- 監査用（auth.uid()）
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (staff_id, work_date, meal_type)    -- 同日同区分は1件
);
create index idx_meal_store_date on public.meal_records(store_id, work_date);
create index idx_meal_staff      on public.meal_records(staff_id);

-- ============ [RLS] shift_availability(0007) と同型 ============
alter table public.meal_records enable row level security;

-- 閲覧: 自店の管理者スコープ or 本人（他スタッフの賄いはスタッフには見えない）
create policy meal_sel on public.meal_records for select to authenticated
  using (
    public.app_can_store(store_id)
    or public.app_staff_id(tenant_id) = staff_id
  );

-- 書込: 本人（自分×自店のみ） or 管理者（shift_edit ∧ 自店）。avail_ins/upd/del と同一式。
create policy meal_ins on public.meal_records for insert to authenticated
  with check (
    (public.app_staff_id(tenant_id) = staff_id and public.app_can_store(store_id))
    or (public.app_has_perm(tenant_id,'shift_edit') and public.app_can_store(store_id))
  );
create policy meal_upd on public.meal_records for update to authenticated
  using (
    (public.app_staff_id(tenant_id) = staff_id and public.app_can_store(store_id))
    or (public.app_has_perm(tenant_id,'shift_edit') and public.app_can_store(store_id))
  )
  with check (
    (public.app_staff_id(tenant_id) = staff_id and public.app_can_store(store_id))
    or (public.app_has_perm(tenant_id,'shift_edit') and public.app_can_store(store_id))
  );
create policy meal_del on public.meal_records for delete to authenticated
  using (
    (public.app_staff_id(tenant_id) = staff_id and public.app_can_store(store_id))
    or (public.app_has_perm(tenant_id,'shift_edit') and public.app_can_store(store_id))
  );

-- ============ [RPC] ============
-- 呼び出し者JWT前提（app_staff_id / app_has_perm / app_can_store は auth.uid() ベース）。

-- 1) 賄いの記録/取消。p_present=true→upsert（単価を焼く）、false→delete（食べてない＝記録なし）。
--    entered_by は呼び出し者が本人なら 'self'、管理者なら 'manager'（クライアント申告に依存しない）。
create or replace function public.app_upsert_meal(
  p_store_id   uuid,
  p_staff_id   uuid,
  p_work_date  date,
  p_meal_type  text,
  p_present    boolean
) returns uuid language plpgsql volatile security definer set search_path = public as $$
declare
  v_tenant  uuid;
  v_self    uuid;
  v_is_mgr  boolean;
  v_by      text;
  v_price   int;
  v_pricing jsonb;
  v_id      uuid;
begin
  if p_meal_type not in ('breakfast','lunch','dinner') then
    raise exception '賄いの区分が不正です';
  end if;

  select s.tenant_id, s.settings -> 'meal_pricing'
    into v_tenant, v_pricing
    from public.stores s
   where s.id = p_store_id;
  if v_tenant is null then
    raise exception '店舗が見つかりません';
  end if;

  -- 認可: 本人 or 管理者（どちらでもなければ拒否）
  v_self   := public.app_staff_id(v_tenant);
  v_is_mgr := public.app_has_perm(v_tenant, 'shift_edit') and public.app_can_store(p_store_id);
  if v_self is not null and v_self = p_staff_id and public.app_can_store(p_store_id) then
    v_by := 'self';
  elsif v_is_mgr then
    v_by := 'manager';
  else
    raise exception '賄いを登録する権限がありません';
  end if;

  -- 勤務日ガード（配置のある日だけ。status は問わない）
  if not exists (
    select 1 from public.shift_assignments a
     where a.staff_id  = p_staff_id
       and a.store_id  = p_store_id
       and a.work_date = p_work_date
  ) then
    raise exception 'この日は勤務の予定がないため賄いを登録できません';
  end if;

  if p_present is not true then
    delete from public.meal_records
     where staff_id = p_staff_id and work_date = p_work_date and meal_type = p_meal_type;
    return null;
  end if;

  -- 単価の焼き込み（無料設定・未設定は 0）
  if v_pricing is null or coalesce((v_pricing ->> 'free')::boolean, false) then
    v_price := 0;
  else
    v_price := coalesce((v_pricing ->> p_meal_type)::int, 0);
  end if;
  if v_price < 0 then
    v_price := 0;
  end if;

  insert into public.meal_records (
    tenant_id, store_id, staff_id, work_date, meal_type,
    price_snapshot, entered_by, entered_by_user
  ) values (
    v_tenant, p_store_id, p_staff_id, p_work_date, p_meal_type,
    v_price, v_by, auth.uid()
  )
  on conflict (staff_id, work_date, meal_type)
  do update set
    store_id        = excluded.store_id,
    price_snapshot  = excluded.price_snapshot,
    entered_by      = excluded.entered_by,
    entered_by_user = excluded.entered_by_user,
    updated_at      = now()
  returning id into v_id;

  return v_id;
end $$;

-- 2) 月次集計。管理者（shift_edit ∧ 自店）= その店の全員 / 本人 = 自分の行のみ。
--    どちらでもなければ例外。他スタッフの個別額が本人に出ることはない。
create or replace function public.app_meal_summary(
  p_store_id uuid, p_from date, p_to date
) returns table (
  staff_id   uuid,
  total_yen  bigint,
  meal_count integer
) language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_self   uuid;
  v_is_mgr boolean;
begin
  select s.tenant_id into v_tenant from public.stores s where s.id = p_store_id;
  if v_tenant is null then
    raise exception '店舗が見つかりません';
  end if;

  v_self   := public.app_staff_id(v_tenant);
  v_is_mgr := public.app_has_perm(v_tenant, 'shift_edit') and public.app_can_store(p_store_id);
  if not v_is_mgr and v_self is null then
    raise exception '賄い集計を閲覧する権限がありません';
  end if;

  return query
  select
    m.staff_id,
    coalesce(sum(m.price_snapshot), 0)::bigint as total_yen,
    count(*)::integer                          as meal_count
  from public.meal_records m
   where m.store_id  = p_store_id
     and m.work_date between p_from and p_to
     and (v_is_mgr or m.staff_id = v_self)   -- 管理者=全員 / 本人=自分のみ
   group by m.staff_id
   order by m.staff_id;
end $$;

-- Supabase 既定 grant 潰し → authenticated のみ
revoke all on function public.app_upsert_meal(uuid, uuid, date, text, boolean) from public, anon;
revoke all on function public.app_meal_summary(uuid, date, date)               from public, anon;
grant execute on function public.app_upsert_meal(uuid, uuid, date, text, boolean) to authenticated;
grant execute on function public.app_meal_summary(uuid, date, date)               to authenticated;
