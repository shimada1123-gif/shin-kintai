-- 0023_roster_is_regular.sql
-- 目的: app_store_roster(0012) の返却に is_regular を追加し、社員だけを絞れるようにする。
-- 用途: 社員の公休カレンダーで「その店の社員(is_regular=true)」を出す。
-- 方針: create or replace で列を1つ足すだけ。既存の呼び出し(＋スタッフ追加/オファー候補)は
--       追加列を無視すれば後方互換。0012 の本体・ガード(app_can_store)・grant は不変。

drop function if exists public.app_store_roster(uuid);

create or replace function public.app_store_roster(p_store_id uuid)
returns table (
  staff_id            uuid,
  full_name           text,
  employment_kind_id  uuid,
  kind_label          text,
  requires_clock      boolean,
  position_default_id uuid,
  is_newbie           boolean,
  is_trainer          boolean,
  is_regular          boolean          -- 追加: 社員区分か（employment_kinds.is_regular）
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
    ek.label            as kind_label,
    ek.requires_clock,
    sa.position_default_id,
    sa.is_newbie,
    sa.is_trainer,
    ek.is_regular
  from public.staff_assignments sa
  join public.staff s             on s.id  = sa.staff_id
  join public.employment_kinds ek on ek.id = sa.employment_kind_id
  where sa.store_id = p_store_id
    and sa.is_active = true
    and s.status     = 'active'
    and ek.requires_clock = true
    and public.app_can_store(p_store_id)
$$;

-- grant は 0012 のまま（authenticated）。返却列変更のため念のため再明示。
revoke all on function public.app_store_roster(uuid) from public, anon;
grant execute on function public.app_store_roster(uuid) to authenticated;
