-- 0025_staff_skills.sql
-- 目的: スキル表 staff_skills（staff×position の可否・将来用level）。自動割付(C)の前提データ。
-- scope確定: tenant_id + staff_id + position_id のみ（store列は持たない）。
--   スキルは人×ポジションで店に従属しない。店整合は position.store_id と staff_assignments を
--   app_store_skills 関数側の結合で担保する。
-- 認可: 編集は staff_master_edit 続用（positions/employment_kinds/staff/0024 RPCと統一）。
-- 順序: [DDL] テーブル＋index → [RLS] positions型ミラー → [RPC] 2関数＋grant。
-- 新規テーブルのため drop→update→add の並べ替え不要。pgcrypto 不使用（search_path=public のみ）。

-- ============ [DDL] テーブル ============
create table public.staff_skills (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id)   on delete cascade,
  staff_id    uuid not null references public.staff(id)     on delete cascade,
  position_id uuid not null references public.positions(id) on delete cascade,
  can         boolean not null default true,
  level       smallint check (level is null or level between 1 and 5),  -- 将来用（今はUI非表示）
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (staff_id, position_id)
);
create index idx_staff_skills_tenant on public.staff_skills(tenant_id);
create index idx_staff_skills_staff  on public.staff_skills(staff_id);

-- ============ [RLS] positions型ミラー（0002 pos_sel/pos_write と同型） ============
-- 書込は原則 RPC(app_set_skill) に寄せる。行ポリシーは閲覧経路＋管理者直接操作の保険。
alter table public.staff_skills enable row level security;

create policy sks_sel on public.staff_skills for select to authenticated
  using (public.app_is_member(tenant_id));
create policy sks_write on public.staff_skills for all to authenticated
  using (public.app_has_perm(tenant_id,'staff_master_edit'))
  with check (public.app_has_perm(tenant_id,'staff_master_edit'));

-- ============ [RPC] SECURITY DEFINER 2関数 ============
-- 呼び出し者JWT前提（app_has_perm / app_can_store は auth.uid() ベース。service_role では forbidden）。

-- 1) スキル1セルの upsert。認可 → 越境ガード → on conflict 更新。戻り値=行id。
--    ★越境ガード: unique(staff_id,position_id) だけでは別テナント混入を型で防げないため、
--      staff / positions 双方の tenant_id = p_tenant_id を関数で検証する。
--    level の範囲(1..5 or null)は列CHECKに委譲。
create or replace function public.app_set_skill(
  p_tenant_id uuid, p_staff_id uuid, p_position_id uuid, p_can boolean, p_level smallint
) returns uuid language plpgsql volatile security definer set search_path = public as $$
declare
  v_id uuid;
begin
  if not public.app_has_perm(p_tenant_id, 'staff_master_edit') then
    raise exception 'スキルを編集する権限がありません（staff_master_edit が必要です）';
  end if;

  -- 越境ガード（不一致/不存在はどちらも例外）
  if not exists (
    select 1 from public.staff s
     where s.id = p_staff_id and s.tenant_id = p_tenant_id
  ) then
    raise exception 'スタッフがテナントに属していません';
  end if;
  if not exists (
    select 1 from public.positions p
     where p.id = p_position_id and p.tenant_id = p_tenant_id
  ) then
    raise exception 'ポジションがテナントに属していません';
  end if;

  insert into public.staff_skills (tenant_id, staff_id, position_id, can, level)
       values (p_tenant_id, p_staff_id, p_position_id, p_can, p_level)
  on conflict (staff_id, position_id)
  do update set can = excluded.can, level = excluded.level, updated_at = now()
  returning id into v_id;
  return v_id;
end $$;

-- 2) 店単位のスキル一覧（マトリクスのセル値供給）。app_can_store ガード（roster 0012/0023 同型）。
--    候補集合を関数側で限定:
--      staff     = その店ロースター（staff_assignments で store_id = p_store_id かつ is_active）
--      positions = その店の有効（store_id is null or = p_store_id）かつ is_active
--    上記 (staff × position) に対応する staff_skills 行のみ返す
--    （無効position・他店専用position・別テナントの行は出さない）。
--    join でなく exists で限定（staff_assignments 複数行時の重複行を出さない）。
create or replace function public.app_store_skills(p_store_id uuid)
returns table (
  staff_id    uuid,
  position_id uuid,
  can         boolean,
  level       smallint
)
language sql
stable
security definer
set search_path = public
as $$
  select sk.staff_id, sk.position_id, sk.can, sk.level
    from public.staff_skills sk
   where public.app_can_store(p_store_id)
     and exists (
       select 1 from public.staff_assignments sa
        where sa.staff_id = sk.staff_id
          and sa.store_id = p_store_id
          and sa.is_active = true
     )
     and exists (
       select 1 from public.positions p
        where p.id = sk.position_id
          and (p.store_id is null or p.store_id = p_store_id)
          and p.is_active = true
     )
$$;

-- Supabase 既定 grant 潰し → authenticated のみ
revoke all on function public.app_set_skill(uuid, uuid, uuid, boolean, smallint) from public, anon;
revoke all on function public.app_store_skills(uuid)                             from public, anon;
grant execute on function public.app_set_skill(uuid, uuid, uuid, boolean, smallint) to authenticated;
grant execute on function public.app_store_skills(uuid)                             to authenticated;
