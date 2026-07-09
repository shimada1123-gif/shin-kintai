-- SHIN勤怠 Phase 1 : seed
-- role_permissions の初期プリセット（控えめ起点、オーナーは行を持たず常時フル）
-- テナント作成時に自動投入するトリガー付き。祝日は2026年分を投入。

-- ============ 権限プリセット ============
create or replace function public.seed_role_permissions(tid uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.role_permissions (tenant_id, role, permission_key, allowed) values
    -- エリアマネージャー
    (tid,'area_manager','roster_view_today',   true),
    (tid,'area_manager','correction_approve',  true),
    (tid,'area_manager','shift_edit',          true),
    (tid,'area_manager','labor_cost_view',     true),
    (tid,'area_manager','wage_individual_view',true),
    (tid,'area_manager','payslip_view',        true),
    (tid,'area_manager','staff_master_edit',   true),
    -- 店長（個人賃金・他人の明細・マスタ編集は既定OFF）
    (tid,'store_manager','roster_view_today',   true),
    (tid,'store_manager','correction_approve',  true),
    (tid,'store_manager','shift_edit',          true),
    (tid,'store_manager','labor_cost_view',     true),
    (tid,'store_manager','wage_individual_view',false),
    (tid,'store_manager','payslip_view',        false),
    (tid,'store_manager','staff_master_edit',   false),
    -- スタッフ（今日のシフト表のみ）
    (tid,'staff','roster_view_today',   true),
    (tid,'staff','correction_approve',  false),
    (tid,'staff','shift_edit',          false),
    (tid,'staff','labor_cost_view',     false),
    (tid,'staff','wage_individual_view',false),
    (tid,'staff','payslip_view',        false),
    (tid,'staff','staff_master_edit',   false)
  on conflict (tenant_id, role, permission_key) do nothing;
end; $$;

-- テナント作成時に自動でプリセット投入
create or replace function public.on_tenant_created()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.seed_role_permissions(new.id);
  return new;
end; $$;

drop trigger if exists trg_tenant_created on public.tenants;
create trigger trg_tenant_created
  after insert on public.tenants
  for each row execute function public.on_tenant_created();

-- ============ 2026年 日本の祝日 ============
insert into public.holidays (holiday_date, name) values
  ('2026-01-01','元日'),
  ('2026-01-12','成人の日'),
  ('2026-02-11','建国記念の日'),
  ('2026-02-23','天皇誕生日'),
  ('2026-03-20','春分の日'),
  ('2026-04-29','昭和の日'),
  ('2026-05-03','憲法記念日'),
  ('2026-05-04','みどりの日'),
  ('2026-05-05','こどもの日'),
  ('2026-05-06','振替休日'),
  ('2026-07-20','海の日'),
  ('2026-08-11','山の日'),
  ('2026-09-21','敬老の日'),
  ('2026-09-22','国民の休日'),
  ('2026-09-23','秋分の日'),
  ('2026-10-12','スポーツの日'),
  ('2026-11-03','文化の日'),
  ('2026-11-23','勤労感謝の日')
on conflict (holiday_date) do nothing;
