-- 0014_offer_two_stage.sql
-- 目的: オファー承諾を「早い者勝ち即確定」から「複数人が申請(applied,コメント可)→管理者がOK(confirm)で確定」に変更。
-- 変更点: recipients.comment 追加 / response CHECK 貼り替え / app_offer_accept 改修(申請のみ) / app_offer_confirm 新設(排他+確定)。
-- 排他は承諾時ではなく confirm 時に移す（offer行ロック＋条件付きUPDATE）。

-- ① コメント列
alter table public.shift_offer_recipients add column if not exists comment text;

-- ② response CHECK 貼り替え（accepted 廃止 → applied / confirmed 新設）
--    既存データに 'accepted' が無い前提（本番未使用）。念のため移行も入れる。
--    順序: drop → update → add。旧CHECK下では 'applied' へのUPDATEが違反になり、
--    新CHECKの追加は既存 'accepted' 行の検証で落ちるため、制約が無い間に移行する。
alter table public.shift_offer_recipients drop constraint if exists shift_offer_recipients_response_check;
update public.shift_offer_recipients set response='applied' where response='accepted';
alter table public.shift_offer_recipients
  add constraint shift_offer_recipients_response_check
  check (response in ('pending','applied','declined','confirmed','superseded'));

-- ③ app_offer_accept 改修: 旧シグネチャを drop してから2引数版を作成
drop function if exists public.app_offer_accept(text);

create or replace function public.app_offer_accept(p_token text, p_comment text)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_hash text := encode(digest(p_token,'sha256'),'hex');
  v_rec  public.shift_offer_recipients%rowtype;
  v_off  public.shift_offers%rowtype;
begin
  select * into v_rec from public.shift_offer_recipients where token_hash = v_hash;
  if not found then return jsonb_build_object('ok',false,'reason','invalid'); end if;

  select * into v_off from public.shift_offers where id = v_rec.offer_id;

  if v_off.status = 'filled' then
    return jsonb_build_object('ok',false,'reason','already_filled');
  end if;
  if v_off.status in ('cancelled','expired') then
    return jsonb_build_object('ok',false,'reason',v_off.status);
  end if;
  if v_off.deadline_at < now() then
    update public.shift_offers set status='expired' where id=v_off.id and status='open';
    return jsonb_build_object('ok',false,'reason','expired');
  end if;

  -- 申請にする（複数人が applied で共存できる。排他しない。assignmentは作らない）
  -- declined から再応募も許容。confirmed 済み本人は据え置き。
  if v_rec.response = 'confirmed' then
    return jsonb_build_object('ok',true,'reason','already_confirmed',
      'offer_id',v_off.id,'work_date',v_off.work_date,
      'start_min',v_off.start_min,'end_min',v_off.end_min);
  end if;

  update public.shift_offer_recipients
     set response='applied',
         comment=nullif(btrim(coalesce(p_comment,'')),''),
         responded_at=now()
   where id=v_rec.id;

  return jsonb_build_object('ok',true,'reason','applied',
    'offer_id',v_off.id,'work_date',v_off.work_date,
    'start_min',v_off.start_min,'end_min',v_off.end_min);
end; $$;

-- ④ app_offer_confirm 新設: 管理者が applicant を1人確定（ここで排他＋assignment生成）
create or replace function public.app_offer_confirm(p_recipient_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_rec public.shift_offer_recipients%rowtype;
  v_off public.shift_offers%rowtype;
  v_overlap boolean := false;
begin
  select * into v_rec from public.shift_offer_recipients where id = p_recipient_id;
  if not found then return jsonb_build_object('ok',false,'reason','invalid'); end if;

  select * into v_off from public.shift_offers where id = v_rec.offer_id for update;  -- 排他ロック

  -- 呼び出し者の権限チェック（definerだが入口で shift_edit∧自店 を強制）
  if not (public.app_has_perm(v_off.tenant_id,'shift_edit') and public.app_can_store(v_off.store_id)) then
    return jsonb_build_object('ok',false,'reason','forbidden');
  end if;

  if v_off.status = 'filled' then
    return jsonb_build_object('ok',false,'reason','already_filled');
  end if;
  if v_off.status in ('cancelled','expired') then
    return jsonb_build_object('ok',false,'reason',v_off.status);
  end if;
  if v_rec.response not in ('applied','pending') then
    return jsonb_build_object('ok',false,'reason','not_applicable');  -- declined/superseded等は確定不可
  end if;

  -- 原子的に確定
  update public.shift_offers set status='filled', winner_staff_id=v_rec.staff_id, filled_at=now()
   where id=v_off.id and status='open';
  if not found then
    return jsonb_build_object('ok',false,'reason','already_filled');
  end if;

  -- 重複検知（警告のみ）
  select exists(
    select 1 from public.shift_assignments a
     where a.staff_id=v_rec.staff_id and a.store_id=v_off.store_id and a.work_date=v_off.work_date
       and a.start_min < v_off.end_min and a.end_min > v_off.start_min
  ) into v_overlap;

  insert into public.shift_assignments
    (tenant_id, staff_id, store_id, work_date, start_min, end_min, position_id, weight_half, status)
  values
    (v_off.tenant_id, v_rec.staff_id, v_off.store_id, v_off.work_date,
     v_off.start_min, v_off.end_min, v_off.position_id, v_off.weight_half, 'draft');

  update public.shift_offer_recipients set response='confirmed', responded_at=now() where id=v_rec.id;
  -- 他の applied/pending は「埋まりました」へ
  update public.shift_offer_recipients set response='superseded', responded_at=now()
    where offer_id=v_off.id and id<>v_rec.id and response in ('applied','pending');

  return jsonb_build_object('ok',true,'offer_id',v_off.id,'staff_id',v_rec.staff_id,
    'work_date',v_off.work_date,'start_min',v_off.start_min,'end_min',v_off.end_min,
    'overlap_warning',v_overlap);
end; $$;

-- ⑤ 権限: accept は anon（メールリンク）、confirm は authenticated のみ（管理者操作・関数内で権限判定）
revoke all on function public.app_offer_accept(text, text) from public;
revoke all on function public.app_offer_confirm(uuid)      from public, anon;
grant execute on function public.app_offer_accept(text, text) to anon, authenticated;
grant execute on function public.app_offer_confirm(uuid)      to authenticated;
