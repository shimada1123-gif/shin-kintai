-- 0029_staff_retire.sql
-- 目的: スタッフの退職アーカイブ（retired_at）＋一時停止（is_active 新設）＋履歴ゼロ限定の物理削除。
-- 状態は3軸（独立）:
--   status('active'/'inactive')  … 既存。ユーザー管理の無効化（ログイン/打刻）専用・本migrationでは無改変。
--   is_active(新設・既定true)     … 一時停止/再開。一覧には出るがシフト候補から外れる。
--   retired_at(新設・null=在籍)   … 退職＝アーカイブ。全画面から消える（過去データは全保全・物理削除しない）。
-- 単一ゲート: app_store_roster を create or replace（返却型・列は不変＝42P13なし・drop不要）。
--   roster に is_active/retired_at を足せば下流（スキル表・自動シフト候補・オファー候補・公休regulars・配置候補）が自動除外。
--   roster 以外の下流には retired_at を二重実装しない。
-- app_labor_cost は無改変（staff と join せず staff_assignments のみ＝退職者の過去人件費は不変＝履歴保全として正しい）。
-- 認可はすべて staff_master_edit（既存 staff_write と同キー・新perm新設なし）。
-- 順序: [DDL] 列追加 → [roster] replace → [RPC] 4関数＋grant。移行DMLなし・RLS変更なし
--   （retired_at/is_active は行単位ポリシー staff_sel/staff_write が自動被覆＝列指定ポリシーではない）。

-- ============ [DDL] 列追加 ============
alter table public.staff
  add column if not exists retired_at date,                          -- null=在籍 / 日付=退職
  add column if not exists is_active  boolean not null default true; -- true=稼働 / false=一時停止

-- 在籍者クエリ（一覧・roster）の高速化
create index if not exists idx_staff_active on public.staff(tenant_id) where retired_at is null;

-- ============ [roster] 退職・一時停止を単一ゲートで除外 ============
-- 0023 の本体・ガード(app_can_store)・返却列は不変。where に2条件を追加するだけ。
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
  is_regular          boolean
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
    and sa.is_active = true          -- 既存: その店の所属が有効
    and s.status     = 'active'      -- 既存: ユーザー管理での無効化を除外
    and s.is_active  = true          -- 追加(0029): 一時停止を除外
    and s.retired_at is null         -- 追加(0029): 退職を除外
    and ek.requires_clock = true
    and public.app_can_store(p_store_id)
$$;

revoke all on function public.app_store_roster(uuid) from public, anon;
grant execute on function public.app_store_roster(uuid) to authenticated;

-- ============ [RPC] SECURITY DEFINER 4関数 ============
-- 呼び出し者JWT前提（app_has_perm は auth.uid() ベース。service_role からは forbidden）。
-- 越境ガード: 対象 staff の tenant_id 一致を exists 検証（不一致/不存在は例外）。

-- 1) 退職（アーカイブ）。p_retired_at 省略時は当日
create or replace function public.app_retire_staff(
  p_tenant_id uuid, p_staff_id uuid, p_retired_at date
) returns void language plpgsql volatile security definer set search_path = public as $$
begin
  if not public.app_has_perm(p_tenant_id, 'staff_master_edit') then
    raise exception 'スタッフを編集する権限がありません（staff_master_edit が必要です）';
  end if;
  if not exists (
    select 1 from public.staff s where s.id = p_staff_id and s.tenant_id = p_tenant_id
  ) then
    raise exception '対象のスタッフが見つかりません';
  end if;

  update public.staff
     set retired_at = coalesce(p_retired_at, current_date)
   where id = p_staff_id and tenant_id = p_tenant_id;
end $$;

-- 2) 復職（在籍に戻す）
create or replace function public.app_reinstate_staff(p_tenant_id uuid, p_staff_id uuid)
returns void language plpgsql volatile security definer set search_path = public as $$
begin
  if not public.app_has_perm(p_tenant_id, 'staff_master_edit') then
    raise exception 'スタッフを編集する権限がありません（staff_master_edit が必要です）';
  end if;
  if not exists (
    select 1 from public.staff s where s.id = p_staff_id and s.tenant_id = p_tenant_id
  ) then
    raise exception '対象のスタッフが見つかりません';
  end if;

  update public.staff set retired_at = null
   where id = p_staff_id and tenant_id = p_tenant_id;
end $$;

-- 3) 一時停止 / 再開（status とは別軸）
create or replace function public.app_set_staff_active(
  p_tenant_id uuid, p_staff_id uuid, p_active boolean
) returns void language plpgsql volatile security definer set search_path = public as $$
begin
  if not public.app_has_perm(p_tenant_id, 'staff_master_edit') then
    raise exception 'スタッフを編集する権限がありません（staff_master_edit が必要です）';
  end if;
  if not exists (
    select 1 from public.staff s where s.id = p_staff_id and s.tenant_id = p_tenant_id
  ) then
    raise exception '対象のスタッフが見つかりません';
  end if;

  update public.staff set is_active = p_active
   where id = p_staff_id and tenant_id = p_tenant_id;
end $$;

-- 4) 物理削除（誤登録の掃除のみ）。履歴が1件でもあれば禁止＝退職を使わせる。
--    staff の子テーブルは on delete cascade のため、履歴があると履歴ごと消える。だから厳格ガードする。
--    ガード対象6テーブル（履歴）: shift_assignments / staff_skills / staff_day_off /
--      shift_availability / shift_offer_recipients / attendance
--    ガード対象外（マスタ付随・cascadeで一緒に消えるのが正）: staff_assignments / staff_tags
create or replace function public.app_delete_staff(p_tenant_id uuid, p_staff_id uuid)
returns void language plpgsql volatile security definer set search_path = public as $$
declare
  v_user uuid;
  v_hist int;
begin
  if not public.app_has_perm(p_tenant_id, 'staff_master_edit') then
    raise exception 'スタッフを編集する権限がありません（staff_master_edit が必要です）';
  end if;

  select s.user_id into v_user
    from public.staff s
   where s.id = p_staff_id and s.tenant_id = p_tenant_id;
  if not found then
    raise exception '対象のスタッフが見つかりません';
  end if;

  -- user_id ガード（孤児ログインを作らない）
  if v_user is not null then
    raise exception '先にユーザー管理で連携を解除してください';
  end if;

  -- 履歴ゼロガード（1件でもあれば削除禁止）
  select
    (select count(*) from public.shift_assignments      where staff_id = p_staff_id)
  + (select count(*) from public.staff_skills           where staff_id = p_staff_id)
  + (select count(*) from public.staff_day_off          where staff_id = p_staff_id)
  + (select count(*) from public.shift_availability     where staff_id = p_staff_id)
  + (select count(*) from public.shift_offer_recipients where staff_id = p_staff_id)
  + (select count(*) from public.attendance             where staff_id = p_staff_id)
  into v_hist;

  if v_hist > 0 then
    raise exception '配置履歴があるため削除できません。退職処理を使ってください';
  end if;

  delete from public.staff where id = p_staff_id and tenant_id = p_tenant_id;
end $$;

-- Supabase 既定 grant 潰し → authenticated のみ
revoke all on function public.app_retire_staff(uuid, uuid, date)        from public, anon;
revoke all on function public.app_reinstate_staff(uuid, uuid)           from public, anon;
revoke all on function public.app_set_staff_active(uuid, uuid, boolean) from public, anon;
revoke all on function public.app_delete_staff(uuid, uuid)              from public, anon;
grant execute on function public.app_retire_staff(uuid, uuid, date)        to authenticated;
grant execute on function public.app_reinstate_staff(uuid, uuid)           to authenticated;
grant execute on function public.app_set_staff_active(uuid, uuid, boolean) to authenticated;
grant execute on function public.app_delete_staff(uuid, uuid)              to authenticated;
