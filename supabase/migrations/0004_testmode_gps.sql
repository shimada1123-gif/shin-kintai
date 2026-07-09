-- SHIN勤怠 Phase 1 : 0004 test-mode & GPS policy （セキュリティ強化版）
-- (1) attendance.is_demo（デモ/テスト打刻フラグ）
-- (2) stores.gps_policy を off / flag / block の3値に拡張
-- (3) デモ行を RLS レベルで隔離：owner かつ tenant.settings.test_mode=true のときのみ
--     作成・閲覧・削除できる。それ以外の役割/状況では is_demo=true 行は一切見えない・作れない。
--     （アプリのクエリ条件が外れても DB が弾く二層防御）
-- 実行は ファイル配置 → GATE確認 → db push の順。

-- ============ (1) デモフラグ ============
alter table public.attendance
  add column if not exists is_demo boolean not null default false;

create index if not exists idx_att_demo
  on public.attendance (tenant_id) where is_demo;

-- ============ (2) GPSポリシー 3値化 ============
-- 0001 のインライン CHECK は自動生成名 stores_gps_policy_check。if exists で安全に張替。
alter table public.stores drop constraint if exists stores_gps_policy_check;
alter table public.stores
  add constraint stores_gps_policy_check
  check (gps_policy in ('off','flag','block'));

-- ============ (3) デモ隔離のためのヘルパー & RLS ============
-- tenant.settings.test_mode を読む（security definer）
create or replace function public.app_tenant_test_mode(tid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select (settings->>'test_mode')::boolean from public.tenants where id = tid), false);
$$;
grant execute on function public.app_tenant_test_mode(uuid) to authenticated;

-- role_permissions に demo_manage を許容（CHECKは role のみ・key は自由文字列なので制約変更不要）
-- 既存テナントにも demo_manage を投入（既定は誰にも付与しない＝owner は app_has_perm で常に true）。
insert into public.role_permissions (tenant_id, role, permission_key, allowed)
select id, r, 'demo_manage', false
from public.tenants, (values ('area_manager'),('store_manager'),('staff')) as x(r)
on conflict (tenant_id, role, permission_key) do nothing;

-- 既存の attendance ポリシーを、デモ隔離を織り込んだ形に張り替える
drop policy if exists att_sel on public.attendance;
drop policy if exists att_ins on public.attendance;
drop policy if exists att_upd on public.attendance;

-- 閲覧：本番行は従来スコープ。デモ行は demo_manage 権限かつ test_mode=ON のときだけ。
create policy att_sel on public.attendance for select to authenticated
  using (
    case when is_demo then
      public.app_has_perm(tenant_id,'demo_manage') and public.app_tenant_test_mode(tenant_id)
    else
      public.app_can_store(store_id) or public.app_staff_id(tenant_id) = staff_id
    end
  );

-- 作成：デモ行は demo_manage かつ test_mode=ON。本番行は本人打刻（従来どおり）。
create policy att_ins on public.attendance for insert to authenticated
  with check (
    case when is_demo then
      public.app_has_perm(tenant_id,'demo_manage') and public.app_tenant_test_mode(tenant_id)
    else
      public.app_staff_id(tenant_id) = staff_id
    end
  );

-- 更新：デモ行は demo_manage。本番行は本人 or 補正承認者（従来どおり）。
create policy att_upd on public.attendance for update to authenticated
  using (
    case when is_demo then
      public.app_has_perm(tenant_id,'demo_manage') and public.app_tenant_test_mode(tenant_id)
    else
      public.app_staff_id(tenant_id) = staff_id
      or (public.app_has_perm(tenant_id,'correction_approve') and public.app_can_store(store_id))
    end
  )
  with check (
    case when is_demo then
      public.app_has_perm(tenant_id,'demo_manage') and public.app_tenant_test_mode(tenant_id)
    else
      public.app_staff_id(tenant_id) = staff_id
      or (public.app_has_perm(tenant_id,'correction_approve') and public.app_can_store(store_id))
    end
  );

-- 削除：デモ行のみ削除可（demo_manage かつ test_mode=ON）。本番行は delete ポリシー無し＝拒否のまま。
drop policy if exists att_del_demo on public.attendance;
create policy att_del_demo on public.attendance for delete to authenticated
  using (
    is_demo and public.app_has_perm(tenant_id,'demo_manage') and public.app_tenant_test_mode(tenant_id)
  );

-- ============ (4) 新規テナントにも demo_manage を配るよう seed 関数を更新 ============
-- create or replace で冪等。既存の21キー(3ロール×7)に demo_manage×3 を足して計24キー。
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
    (tid,'store_manager','roster_view_today',   true),
    (tid,'store_manager','correction_approve',  true),
    (tid,'store_manager','shift_edit',          true),
    (tid,'store_manager','labor_cost_view',     true),
    (tid,'store_manager','wage_individual_view',false),
    (tid,'store_manager','payslip_view',        false),
    (tid,'store_manager','staff_master_edit',   false),
    (tid,'store_manager','demo_manage',         false),
    (tid,'staff','roster_view_today',   true),
    (tid,'staff','correction_approve',  false),
    (tid,'staff','shift_edit',          false),
    (tid,'staff','labor_cost_view',     false),
    (tid,'staff','wage_individual_view',false),
    (tid,'staff','payslip_view',        false),
    (tid,'staff','staff_master_edit',   false),
    (tid,'staff','demo_manage',         false)
  on conflict (tenant_id, role, permission_key) do nothing;
end; $$;
