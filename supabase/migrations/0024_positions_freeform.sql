-- 0024_positions_freeform.sql
-- 目的: ポジション自由化（店ごとに追加/改名/並替/無効化/色）＋ need_by_position の名前キー→position_id キー移行。
-- scope決定（オーナー確定=残す案）: 既存の共通ポジション(store_id=null)は非破壊で維持。
--   店の表示 = (store_id IS NULL OR store_id = :store) を sort_order 昇順。共通行の編集は全店反映。
-- 物理削除は禁止＝無効化(is_active=false)のみ。書込認可は既存 staff_master_edit を続用（新perm新設なし）。
-- 順序: [DDL] 列追加→sort_orderバックフィル → [DML] need_by_position id化（ガード付き） → [RPC] 3関数＋grant。

-- ============ [DDL] 列追加 ============
alter table public.positions
  add column if not exists sort_order int not null default 0,
  add column if not exists is_active  boolean not null default true,
  add column if not exists color      text;

-- sort_order バックフィル（テナント単位 created_at 昇順で採番）
with ranked as (
  select id, row_number() over (partition by tenant_id order by created_at, id) as rn
  from public.positions
)
update public.positions p
   set sort_order = r.rn
  from ranked r
 where p.id = r.id;

-- ============ [DML] need_by_position 名前キー→position_id キー移行 ============
-- 対象: shift_requirements のみ。tenant/store は同テーブルの not null 列から直接取得（導出join不要・0007で確認済み）。
-- ガード: 1キーでも未解決なら RAISE EXCEPTION（サイレントdrop禁止）。移行前後でキー数一致を検証。
-- 既に uuid 形式のキーはそのまま通す（再実行しても安全＝冪等）。
do $mig$
declare
  r          record;
  new_need   jsonb;
  k          text;
  v          jsonb;
  pid        uuid;
  cnt_before int;
  cnt_after  int;
begin
  for r in
    select id, tenant_id, store_id, need_by_position
      from public.shift_requirements
     where need_by_position <> '{}'::jsonb
  loop
    new_need   := '{}'::jsonb;
    cnt_before := (select count(*) from jsonb_object_keys(r.need_by_position));

    for k, v in select * from jsonb_each(r.need_by_position)
    loop
      if k ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        -- 既に id キー
        new_need := new_need || jsonb_build_object(k, v);
        continue;
      end if;
      -- 名前→id 解決（同名衝突は店専用優先: store_id NULLS LAST）
      select p.id into pid
        from public.positions p
       where p.tenant_id = r.tenant_id
         and p.name = k
         and (p.store_id is null or p.store_id = r.store_id)
       order by p.store_id nulls last
       limit 1;
      if pid is null then
        raise exception 'need_by_position のキー "%"（shift_requirements.id=%）を position_id に解決できません', k, r.id;
      end if;
      new_need := new_need || jsonb_build_object(pid::text, v);
    end loop;

    cnt_after := (select count(*) from jsonb_object_keys(new_need));
    if cnt_before <> cnt_after then
      raise exception 'need_by_position のキー数が移行前後で不一致（shift_requirements.id=%）: % -> %',
        r.id, cnt_before, cnt_after;
    end if;

    update public.shift_requirements set need_by_position = new_need where id = r.id;
  end loop;
end $mig$;

-- ============ [RPC] SECURITY DEFINER 3関数 ============
-- 呼び出し者JWT前提（app_has_perm は auth.uid() ベース。service_role から呼ぶと forbidden になる）。
-- 認可はすべて app_has_perm(p_tenant_id,'staff_master_edit')。

-- 追加/更新。p_id=null で新規（sort_order=テナント max+1）、指定で name/color 更新。
-- store_id（スコープ）は変更不可。対象行の tenant 一致を検証（越境防止）。戻り値=対象 id。
create or replace function public.app_upsert_position(
  p_tenant_id uuid, p_store_id uuid, p_id uuid, p_name text, p_color text
) returns uuid language plpgsql volatile security definer set search_path = public as $$
declare
  v_id   uuid;
  v_next int;
begin
  if not public.app_has_perm(p_tenant_id, 'staff_master_edit') then
    raise exception 'ポジションを編集する権限がありません（staff_master_edit が必要です）';
  end if;
  if p_name is null or btrim(p_name) = '' then
    raise exception 'ポジション名を入力してください';
  end if;

  if p_id is null then
    -- 新規。店舗指定時はテナント所属を検証（越境防止）
    if p_store_id is not null and not exists (
      select 1 from public.stores s where s.id = p_store_id and s.tenant_id = p_tenant_id
    ) then
      raise exception '店舗がテナントに属していません';
    end if;
    select coalesce(max(sort_order), 0) + 1 into v_next
      from public.positions where tenant_id = p_tenant_id;
    insert into public.positions (tenant_id, store_id, name, color, sort_order)
      values (p_tenant_id, p_store_id, btrim(p_name), p_color, v_next)
      returning id into v_id;
    return v_id;
  else
    update public.positions
       set name = btrim(p_name), color = p_color   -- store_id は書き換えない（スコープ不変）
     where id = p_id and tenant_id = p_tenant_id;
    if not found then
      raise exception '対象のポジションが見つかりません';
    end if;
    return p_id;
  end if;
end $$;

-- 並べ替え。配列順で sort_order 再採番。全 id の tenant 所属を検証。
create or replace function public.app_reorder_positions(p_tenant_id uuid, p_ids uuid[])
returns void language plpgsql volatile security definer set search_path = public as $$
declare v_bad int;
begin
  if not public.app_has_perm(p_tenant_id, 'staff_master_edit') then
    raise exception 'ポジションを編集する権限がありません（staff_master_edit が必要です）';
  end if;
  select count(*) into v_bad
    from unnest(p_ids) as u(id)
    left join public.positions p on p.id = u.id and p.tenant_id = p_tenant_id
   where p.id is null;
  if v_bad > 0 then
    raise exception 'テナントに属さないポジションIDが含まれています';
  end if;
  update public.positions p
     set sort_order = x.ord
    from (select u.id, u.ord from unnest(p_ids) with ordinality as u(id, ord)) x
   where p.id = x.id and p.tenant_id = p_tenant_id;
end $$;

-- 無効化/復活。無効化時は「操作元の店の表示（共通∪当該店）」の有効数が0にならないよう0件ガード。
create or replace function public.app_set_position_active(
  p_tenant_id uuid, p_store_id uuid, p_id uuid, p_active boolean
) returns void language plpgsql volatile security definer set search_path = public as $$
declare v_remaining int;
begin
  if not public.app_has_perm(p_tenant_id, 'staff_master_edit') then
    raise exception 'ポジションを編集する権限がありません（staff_master_edit が必要です）';
  end if;
  if not exists (
    select 1 from public.positions where id = p_id and tenant_id = p_tenant_id
  ) then
    raise exception '対象のポジションが見つかりません';
  end if;

  if p_active = false then
    select count(*) into v_remaining
      from public.positions p
     where p.tenant_id = p_tenant_id
       and (p.store_id is null or p.store_id = p_store_id)
       and p.is_active = true
       and p.id <> p_id;
    if v_remaining = 0 then
      raise exception '有効なポジションを最低1つ残してください';
    end if;
  end if;

  update public.positions set is_active = p_active
   where id = p_id and tenant_id = p_tenant_id;
end $$;

-- Supabase 既定 grant 潰し → authenticated のみ
revoke all on function public.app_upsert_position(uuid, uuid, uuid, text, text) from public, anon;
revoke all on function public.app_reorder_positions(uuid, uuid[])               from public, anon;
revoke all on function public.app_set_position_active(uuid, uuid, uuid, boolean) from public, anon;
grant execute on function public.app_upsert_position(uuid, uuid, uuid, text, text) to authenticated;
grant execute on function public.app_reorder_positions(uuid, uuid[])               to authenticated;
grant execute on function public.app_set_position_active(uuid, uuid, uuid, boolean) to authenticated;

-- RLS 変更なし: pos_sel（app_is_member）/ pos_write（staff_master_edit）は行単位ポリシーのため
-- 新列 sort_order/is_active/color も自動的に被覆される（列指定ポリシーではない）。
