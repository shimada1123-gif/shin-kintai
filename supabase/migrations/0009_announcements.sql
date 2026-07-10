-- SHIN勤怠 : 0009 掲示板（お知らせ）
-- announcements: 本文（scope_type で対象を指定、論理削除）
-- announcement_stores / announcement_kinds: 対象範囲の join テーブル（FKで店舗/区分削除に自動追従）
-- announcement_reads: 既読（本人のみ記録、投稿者・管理者は既読数閲覧）
-- email_deliveries: メール配信の器（フェーズβ用・今はクライアントから一切触れない）
-- 可視性・投稿権限は RLS で強制（announce_post 新キー、owner は常時フル）
-- 論理削除後は閲覧・編集・復元とも不可（監査は service_role のみ）

-- ============ ① テーブル ============
create table public.announcements (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  author      uuid references auth.users(id) on delete set null,  -- 表示名は staff.user_id 経由、無ければ「管理者」
  title       text not null,
  body        text not null,
  importance  text not null default 'normal'
              check (importance in ('normal','important','urgent')),
  scope_type  text not null default 'all'
              check (scope_type in ('all','stores','kinds','stores_and_kinds')),
  deleted_at  timestamptz,                                        -- 論理削除
  deleted_by  uuid references auth.users(id) on delete set null,  -- 誰が消したか（監査）
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index idx_ann_tenant_created
  on public.announcements(tenant_id, created_at desc) where deleted_at is null;

-- 対象店舗（store 削除で自動的に対象から消える）
create table public.announcement_stores (
  id              uuid primary key default gen_random_uuid(),
  announcement_id uuid not null references public.announcements(id) on delete cascade,
  store_id        uuid not null references public.stores(id) on delete cascade,
  unique (announcement_id, store_id)
);
create index idx_anns_store on public.announcement_stores(store_id);

-- 対象雇用区分（employment_kinds を FK 参照。区分削除にも追従）
create table public.announcement_kinds (
  id                 uuid primary key default gen_random_uuid(),
  announcement_id    uuid not null references public.announcements(id) on delete cascade,
  employment_kind_id uuid not null references public.employment_kinds(id) on delete cascade,
  unique (announcement_id, employment_kind_id)
);
create index idx_annk_kind on public.announcement_kinds(employment_kind_id);

-- 既読
create table public.announcement_reads (
  id              uuid primary key default gen_random_uuid(),
  announcement_id uuid not null references public.announcements(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  read_at         timestamptz not null default now(),
  unique (announcement_id, user_id)
);
create index idx_annr_user on public.announcement_reads(user_id);

-- メール配信の器（フェーズβ。書き込みは service_role のみの想定）
create table public.email_deliveries (
  id              uuid primary key default gen_random_uuid(),
  announcement_id uuid not null references public.announcements(id) on delete cascade,
  user_id         uuid references auth.users(id) on delete set null,
  email           text not null,
  status          text not null default 'pending'
                  check (status in ('pending','sent','failed')),
  sent_at         timestamptz,
  error           text,
  created_at      timestamptz not null default now()
);
create index idx_annd_ann on public.email_deliveries(announcement_id);

-- ============ ② 可視性ヘルパー（security definer） ============
-- 'all'              → メンバー全員
-- 'stores'           → 所属店舗が対象に含まれる（本人）OR 対象店舗を app_can_store（管理者）
-- 'kinds'            → 所属(有効)の雇用区分が対象に含まれる
-- 'stores_and_kinds' → 店舗一致 ∧ 区分一致（本人）。管理者は対象店舗いずれかを app_can_store なら可
-- 共通: owner は常時フル / 投稿者本人は常に可視 / 論理削除済みは全員不可視
create or replace function public.app_announcement_visible(aid uuid)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  tid uuid; stype text; a_author uuid; del timestamptz; my_staff uuid;
  store_ok boolean; kind_ok boolean; mgr_ok boolean;
begin
  select tenant_id, scope_type, author, deleted_at
    into tid, stype, a_author, del
    from public.announcements where id = aid;
  if tid is null then return false; end if;
  if del is not null then return false; end if;
  if not public.app_is_member(tid) then return false; end if;
  if public.app_role(tid) = 'owner' then return true; end if;
  if a_author is not null and a_author = auth.uid() then return true; end if;
  if stype = 'all' then return true; end if;

  my_staff := public.app_staff_id(tid);

  store_ok := exists (
    select 1 from public.announcement_stores t
    join public.staff_assignments sa
      on sa.store_id = t.store_id and sa.staff_id = my_staff and sa.is_active
    where t.announcement_id = aid);

  kind_ok := exists (
    select 1 from public.announcement_kinds t
    join public.staff_assignments sa
      on sa.employment_kind_id = t.employment_kind_id and sa.staff_id = my_staff and sa.is_active
    where t.announcement_id = aid);

  mgr_ok := exists (
    select 1 from public.announcement_stores t
    where t.announcement_id = aid and public.app_can_store(t.store_id));

  if stype = 'stores' then return store_ok or mgr_ok; end if;
  if stype = 'kinds' then return kind_ok; end if;
  if stype = 'stores_and_kinds' then return (store_ok and kind_ok) or mgr_ok; end if;
  return false;
end; $$;

-- 編集・削除（論理削除）の可否: owner / 投稿者本人 / announce_post ∧ 対象店舗いずれかの管理者
create or replace function public.app_announcement_manage(aid uuid)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare tid uuid; a_author uuid;
begin
  select tenant_id, author into tid, a_author
    from public.announcements where id = aid;
  if tid is null then return false; end if;
  if not public.app_is_member(tid) then return false; end if;
  if public.app_role(tid) = 'owner' then return true; end if;
  if a_author is not null and a_author = auth.uid() then return true; end if;
  return public.app_has_perm(tid,'announce_post') and exists (
    select 1 from public.announcement_stores t
    where t.announcement_id = aid and public.app_can_store(t.store_id));
end; $$;

grant execute on function
  public.app_announcement_visible(uuid), public.app_announcement_manage(uuid)
to authenticated;

-- ============ ③ RLS ============
alter table public.announcements       enable row level security;
alter table public.announcement_stores enable row level security;
alter table public.announcement_kinds  enable row level security;
alter table public.announcement_reads  enable row level security;
alter table public.email_deliveries    enable row level security;
-- email_deliveries はポリシー無し＝クライアントから読み書き不可（service_role 専用）

-- announcements: 閲覧はヘルパー。投稿は announce_post（author=自分を強制、削除済みでの新規は不可）。
-- 全体('all')・区分のみ('kinds')は店舗スコープを越えるため owner のみ。店舗系スコープは管理者も可
-- （対象店舗の縛りは announcement_stores 側で app_can_store を強制）。
create policy ann_sel on public.announcements for select to authenticated
  using (public.app_announcement_visible(id));
create policy ann_ins on public.announcements for insert to authenticated
  with check (
    public.app_has_perm(tenant_id,'announce_post')
    and author = auth.uid()
    and deleted_at is null
    and (scope_type in ('stores','stores_and_kinds') or public.app_role(tenant_id) = 'owner')
  );
-- 更新＝本文編集 + 論理削除（deleted_at/deleted_by セット）。物理 delete ポリシーは作らない＝拒否。
-- using に deleted_at is null: 削除済み行は編集も復元も不可（クライアントからの復元手段なし）
create policy ann_upd on public.announcements for update to authenticated
  using (public.app_announcement_manage(id) and deleted_at is null)
  with check (public.app_announcement_manage(id) and public.app_is_member(tenant_id));

-- announcement_stores: 追加は「親を管理できる ∧ その店舗を app_can_store ∧ テナント一致」
create policy anns_sel on public.announcement_stores for select to authenticated
  using (public.app_announcement_visible(announcement_id)
         or public.app_announcement_manage(announcement_id));
create policy anns_ins on public.announcement_stores for insert to authenticated
  with check (
    public.app_can_store(store_id)
    and public.app_announcement_manage(announcement_id)
    and exists (
      select 1 from public.announcements a, public.stores s
      where a.id = announcement_id and s.id = store_id and s.tenant_id = a.tenant_id)
  );
create policy anns_del on public.announcement_stores for delete to authenticated
  using (public.app_can_store(store_id) and public.app_announcement_manage(announcement_id));

-- announcement_kinds: 追加は「親を管理できる ∧ テナント一致」（区分はテナント共通マスタ）
create policy annk_sel on public.announcement_kinds for select to authenticated
  using (public.app_announcement_visible(announcement_id)
         or public.app_announcement_manage(announcement_id));
create policy annk_ins on public.announcement_kinds for insert to authenticated
  with check (
    public.app_announcement_manage(announcement_id)
    and exists (
      select 1 from public.announcements a, public.employment_kinds k
      where a.id = announcement_id and k.id = employment_kind_id and k.tenant_id = a.tenant_id)
  );
create policy annk_del on public.announcement_kinds for delete to authenticated
  using (public.app_announcement_manage(announcement_id));

-- announcement_reads: 既読は本人のみ記録（可視な投稿に限る）。閲覧は本人 or 投稿者・管理者（既読数集計用）
create policy annr_sel on public.announcement_reads for select to authenticated
  using (user_id = auth.uid() or public.app_announcement_manage(announcement_id));
create policy annr_ins on public.announcement_reads for insert to authenticated
  with check (user_id = auth.uid() and public.app_announcement_visible(announcement_id));

-- ============ ④ 権限キー announce_post（0004 と同じ2経路パターン） ============
-- (a) 既存テナントへ配布（area/store_manager 既定ON・staff OFF。owner は行を持たず常時フル）
insert into public.role_permissions (tenant_id, role, permission_key, allowed)
select t.id, x.r, 'announce_post', x.a
from public.tenants t
cross join (values ('area_manager', true), ('store_manager', true), ('staff', false)) as x(r, a)
on conflict (tenant_id, role, permission_key) do nothing;

-- (b) 新規テナント用 seed を更新（24キー → announce_post×3 を足して計27キー）
create or replace function public.seed_role_permissions(tid uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.role_permissions (tenant_id, role, permission_key, allowed) values
    (tid,'area_manager','roster_view_today',   true),
    (tid,'area_manager','correction_approve',  true),
    (tid,'area_manager','shift_edit',          true),
    (tid,'area_manager','labor_cost_view',     true),
    (tid,'area_manager','wage_individual_view',true),
    (tid,'area_manager','payslip_view',        true),
    (tid,'area_manager','staff_master_edit',   true),
    (tid,'area_manager','demo_manage',         false),
    (tid,'area_manager','announce_post',       true),
    (tid,'store_manager','roster_view_today',   true),
    (tid,'store_manager','correction_approve',  true),
    (tid,'store_manager','shift_edit',          true),
    (tid,'store_manager','labor_cost_view',     true),
    (tid,'store_manager','wage_individual_view',false),
    (tid,'store_manager','payslip_view',        false),
    (tid,'store_manager','staff_master_edit',   false),
    (tid,'store_manager','demo_manage',         false),
    (tid,'store_manager','announce_post',       true),
    (tid,'staff','roster_view_today',   true),
    (tid,'staff','correction_approve',  false),
    (tid,'staff','shift_edit',          false),
    (tid,'staff','labor_cost_view',     false),
    (tid,'staff','wage_individual_view',false),
    (tid,'staff','payslip_view',        false),
    (tid,'staff','staff_master_edit',   false),
    (tid,'staff','demo_manage',         false),
    (tid,'staff','announce_post',       false)
  on conflict (tenant_id, role, permission_key) do nothing;
end; $$;
