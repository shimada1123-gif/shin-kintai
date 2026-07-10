-- 0012_roster_definer.sql
-- 目的: 「＋スタッフを追加」候補ロースターを「賃金列なし」で返す security definer 関数。
-- 背景: staff_assignments の sa_sel は wage_individual_view or 本人でのみ SELECT 可のため、
--       個人賃金閲覧権限を持たない店長では候補が空になる。氏名・区分・打刻要否のみ返す関数で回避する。
-- 露出範囲: 氏名(staff_selで既に全メンバー可)・区分ラベル(ek_selで可)・所属linkage/新人/トレーナー/既定ポジ。
--           賃金(wage_type/hourly_wage/monthly_fixed/commute_*)は一切返さない。

create or replace function public.app_store_roster(p_store_id uuid)
returns table (
  staff_id            uuid,
  full_name           text,
  employment_kind_id  uuid,
  kind_label          text,
  requires_clock      boolean,
  position_default_id uuid,
  is_newbie           boolean,
  is_trainer          boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    sa.staff_id,
    s.full_name,
    sa.employment_kind_id,
    ek.label          as kind_label,
    ek.requires_clock,
    sa.position_default_id,
    sa.is_newbie,
    sa.is_trainer
  from public.staff_assignments sa
  join public.staff s             on s.id  = sa.staff_id
  join public.employment_kinds ek on ek.id = sa.employment_kind_id
  where sa.store_id      = p_store_id
    and sa.is_active     = true         -- 所属が有効
    and s.status         = 'active'     -- 在籍
    and ek.requires_clock = true        -- 業務委託(requires_clock=false)を除外
    and public.app_can_store(p_store_id) -- 呼び出し者がその店を見られること(テナント跨ぎ/スコープ外を遮断)
$$;

-- Supabase既定でpublic/anonにexecuteが付く問題を明示的に潰す
revoke all on function public.app_store_roster(uuid) from public, anon;
grant execute on function public.app_store_roster(uuid) to authenticated;
