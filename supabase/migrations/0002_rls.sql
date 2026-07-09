-- SHIN勤怠 Phase 1 : RLS helper functions + policies
-- 方針: テナント分離を全テーブルで強制。スコープ（自店/自エリア）と権限は関数で判定。
-- owner は常にフル。個人賃金(staff_assignments)は wage_individual_view を持つ者+本人のみ。

-- ============ ヘルパー関数（security definer） ============
create or replace function public.app_role(tid uuid)
returns text language sql stable security definer set search_path = public as $$
  select role from public.memberships
  where tenant_id = tid and user_id = auth.uid() limit 1;
$$;

create or replace function public.app_is_member(tid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.memberships
                 where tenant_id = tid and user_id = auth.uid());
$$;

create or replace function public.app_staff_id(tid uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select staff_id from public.memberships
  where tenant_id = tid and user_id = auth.uid() limit 1;
$$;

create or replace function public.app_has_perm(tid uuid, perm text)
returns boolean language sql stable security definer set search_path = public as $$
  select case
    when public.app_role(tid) = 'owner' then true
    else coalesce(
      (select allowed from public.role_permissions
       where tenant_id = tid and role = public.app_role(tid) and permission_key = perm),
      false)
  end;
$$;

-- 現在ユーザーが対象店舗を見る/操作できるか（owner=全店 / area=自エリア / manager,staff=自店）
create or replace function public.app_can_store(sid uuid)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare r text; tid uuid; a uuid; s uuid; st_area uuid;
begin
  select tenant_id, area_id into tid, st_area from public.stores where id = sid;
  if tid is null then return false; end if;
  select role, scope_area_id, scope_store_id into r, a, s
    from public.memberships where tenant_id = tid and user_id = auth.uid() limit 1;
  if r is null then return false; end if;
  if r = 'owner' then return true; end if;
  if r = 'area_manager' then return st_area is not null and st_area = a; end if;
  if r = 'store_manager' then return s = sid; end if;
  if r = 'staff' then
    return s = sid or exists (
      select 1 from public.staff_assignments sa
      join public.memberships m on m.staff_id = sa.staff_id
      where sa.store_id = sid and m.user_id = auth.uid() and m.tenant_id = tid);
  end if;
  return false;
end; $$;

grant execute on function
  public.app_role(uuid), public.app_is_member(uuid), public.app_staff_id(uuid),
  public.app_has_perm(uuid, text), public.app_can_store(uuid)
to authenticated;

-- ============ RLS 有効化 ============
alter table public.tenants                enable row level security;
alter table public.areas                  enable row level security;
alter table public.stores                 enable row level security;
alter table public.employment_kinds       enable row level security;
alter table public.positions              enable row level security;
alter table public.staff                  enable row level security;
alter table public.staff_assignments      enable row level security;
alter table public.staff_tags             enable row level security;
alter table public.memberships            enable row level security;
alter table public.role_permissions       enable row level security;
alter table public.qr_tokens              enable row level security;
alter table public.attendance             enable row level security;
alter table public.attendance_breaks      enable row level security;
alter table public.attendance_corrections enable row level security;
alter table public.holidays               enable row level security;
alter table public.access_logs            enable row level security;

-- ============ ポリシー ============
-- tenants : メンバーは自組織を閲覧。作成/変更は owner（作成は通常 service_role の signup フロー）
create policy tenants_sel on public.tenants for select to authenticated
  using (public.app_is_member(id));
create policy tenants_upd on public.tenants for update to authenticated
  using (public.app_role(id) = 'owner') with check (public.app_role(id) = 'owner');

-- areas : メンバー閲覧 / owner 管理
create policy areas_sel on public.areas for select to authenticated
  using (public.app_is_member(tenant_id));
create policy areas_all on public.areas for all to authenticated
  using (public.app_role(tenant_id) = 'owner') with check (public.app_role(tenant_id) = 'owner');

-- stores : スコープ内を閲覧 / owner 管理
create policy stores_sel on public.stores for select to authenticated
  using (public.app_can_store(id));
create policy stores_all on public.stores for all to authenticated
  using (public.app_role(tenant_id) = 'owner') with check (public.app_role(tenant_id) = 'owner');

-- employment_kinds / positions : メンバー閲覧 / staff_master_edit 権限で編集
create policy ek_sel on public.employment_kinds for select to authenticated
  using (public.app_is_member(tenant_id));
create policy ek_write on public.employment_kinds for all to authenticated
  using (public.app_has_perm(tenant_id,'staff_master_edit'))
  with check (public.app_has_perm(tenant_id,'staff_master_edit'));

create policy pos_sel on public.positions for select to authenticated
  using (public.app_is_member(tenant_id));
create policy pos_write on public.positions for all to authenticated
  using (public.app_has_perm(tenant_id,'staff_master_edit'))
  with check (public.app_has_perm(tenant_id,'staff_master_edit'));

-- staff : 氏名はロスター用にメンバー全員が閲覧（賃金は staff_assignments 側で制御）
create policy staff_sel on public.staff for select to authenticated
  using (public.app_is_member(tenant_id));
create policy staff_write on public.staff for all to authenticated
  using (public.app_has_perm(tenant_id,'staff_master_edit'))
  with check (public.app_has_perm(tenant_id,'staff_master_edit'));

-- staff_assignments : 賃金を含むため wage_individual_view 保持者 or 本人のみ閲覧
create policy sa_sel on public.staff_assignments for select to authenticated
  using (
    public.app_is_member(tenant_id) and (
      public.app_has_perm(tenant_id,'wage_individual_view')
      or public.app_staff_id(tenant_id) = staff_id
    )
  );
create policy sa_write on public.staff_assignments for all to authenticated
  using (public.app_has_perm(tenant_id,'staff_master_edit'))
  with check (public.app_has_perm(tenant_id,'staff_master_edit'));

-- staff_tags : メンバー閲覧（新人等はロスター/シフトで必要）/ 編集は staff_master_edit
create policy tags_sel on public.staff_tags for select to authenticated
  using (public.app_is_member(tenant_id));
create policy tags_write on public.staff_tags for all to authenticated
  using (public.app_has_perm(tenant_id,'staff_master_edit'))
  with check (public.app_has_perm(tenant_id,'staff_master_edit'));

-- memberships : owner は全件、本人は自分の行。管理は owner のみ
create policy mem_sel on public.memberships for select to authenticated
  using (public.app_role(tenant_id) = 'owner' or user_id = auth.uid());
create policy mem_write on public.memberships for all to authenticated
  using (public.app_role(tenant_id) = 'owner') with check (public.app_role(tenant_id) = 'owner');

-- role_permissions : メンバー閲覧（自分の権限判定に必要）/ 変更は owner のみ
create policy rp_sel on public.role_permissions for select to authenticated
  using (public.app_is_member(tenant_id));
create policy rp_write on public.role_permissions for all to authenticated
  using (public.app_role(tenant_id) = 'owner') with check (public.app_role(tenant_id) = 'owner');

-- qr_tokens : 対象店舗を見られる者のみ閲覧。発行は service_role（edge）想定＝clientのinsertポリシーなし
create policy qr_sel on public.qr_tokens for select to authenticated
  using (public.app_can_store(store_id));

-- attendance : 自店（管理者）or 本人が閲覧。打刻は本人が作成、自分のopen行を更新。補正承認者は更新可
create policy att_sel on public.attendance for select to authenticated
  using (public.app_can_store(store_id) or public.app_staff_id(tenant_id) = staff_id);
create policy att_ins on public.attendance for insert to authenticated
  with check (public.app_staff_id(tenant_id) = staff_id);
create policy att_upd on public.attendance for update to authenticated
  using (
    public.app_staff_id(tenant_id) = staff_id
    or (public.app_has_perm(tenant_id,'correction_approve') and public.app_can_store(store_id))
  )
  with check (
    public.app_staff_id(tenant_id) = staff_id
    or (public.app_has_perm(tenant_id,'correction_approve') and public.app_can_store(store_id))
  );

-- attendance_breaks : 親 attendance が閲覧可能なら閲覧。本人が自分の勤怠に休憩を追加/更新
create policy brk_sel on public.attendance_breaks for select to authenticated
  using (exists (
    select 1 from public.attendance a where a.id = attendance_id
    and (public.app_can_store(a.store_id) or public.app_staff_id(a.tenant_id) = a.staff_id)));
create policy brk_write on public.attendance_breaks for all to authenticated
  using (exists (
    select 1 from public.attendance a where a.id = attendance_id
    and (public.app_staff_id(a.tenant_id) = a.staff_id
         or (public.app_has_perm(a.tenant_id,'correction_approve') and public.app_can_store(a.store_id)))))
  with check (exists (
    select 1 from public.attendance a where a.id = attendance_id
    and (public.app_staff_id(a.tenant_id) = a.staff_id
         or (public.app_has_perm(a.tenant_id,'correction_approve') and public.app_can_store(a.store_id)))));

-- attendance_corrections : メンバーが自店/本人分を閲覧。申請は本人、承認/更新は correction_approve
create policy corr_sel on public.attendance_corrections for select to authenticated
  using (exists (
    select 1 from public.attendance a where a.id = attendance_id
    and (public.app_can_store(a.store_id) or public.app_staff_id(a.tenant_id) = a.staff_id)));
create policy corr_ins on public.attendance_corrections for insert to authenticated
  with check (public.app_is_member(tenant_id) and requested_by = auth.uid());
create policy corr_upd on public.attendance_corrections for update to authenticated
  using (public.app_has_perm(tenant_id,'correction_approve'))
  with check (public.app_has_perm(tenant_id,'correction_approve'));

-- holidays : 全ログインユーザーが参照（共通参照表）。書込は service_role のみ
create policy hol_sel on public.holidays for select to authenticated using (true);

-- access_logs : owner のみ閲覧。ログはメンバーが自分の action を追記
create policy log_sel on public.access_logs for select to authenticated
  using (public.app_role(tenant_id) = 'owner');
create policy log_ins on public.access_logs for insert to authenticated
  with check (public.app_is_member(tenant_id) and user_id = auth.uid());
