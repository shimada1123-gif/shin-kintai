-- 0013_shift_offers.sql
-- 目的: 仮登録＋オファー承諾（N人一斉招待→早い者勝ちで1人確定）。
-- 方針: 確定はoffer駆動（承諾時に初めてassignmentを生成）。承諾/拒否はメールリンク=トークン認証で
--       security definer経由（RETURNING×RLS回避）。排他はoffer行ロック＋条件付きUPDATE（advisory不要）。

create extension if not exists pgcrypto;  -- ★GATE確認1: 既に有効なら no-op。digest()に必要

-- ============ テーブル ============
create table public.shift_offers (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  store_id        uuid not null references public.stores(id) on delete cascade,
  work_date       date not null,
  position_id     uuid references public.positions(id) on delete set null,  -- null=ポジション不問
  start_min       int  not null,
  end_min         int  not null,
  weight_half     boolean not null default false,
  status          text not null default 'open'
                    check (status in ('open','filled','cancelled','expired')),
  winner_staff_id uuid references public.staff(id) on delete set null,
  deadline_at     timestamptz not null,          -- 作成時に指定（既定48hはアプリ側）
  note            text,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  filled_at       timestamptz,
  check (start_min >= 0 and end_min <= 1440 and end_min > start_min)
);

create table public.shift_offer_recipients (
  id           uuid primary key default gen_random_uuid(),
  offer_id     uuid not null references public.shift_offers(id) on delete cascade,
  staff_id     uuid not null references public.staff(id) on delete cascade,
  token_hash   text not null,                    -- sha256(生トークン)。生値はメールリンクのみ
  response     text not null default 'pending'
                 check (response in ('pending','accepted','declined','superseded')),
  email        text,                             -- 送信先スナップショット（Resendログ）
  sent_at      timestamptz,
  responded_at timestamptz,
  created_at   timestamptz not null default now(),
  unique (offer_id, staff_id),
  unique (token_hash)
);

create index idx_so_store_date on public.shift_offers(store_id, work_date);
create index idx_so_status     on public.shift_offers(status);
create index idx_sor_offer     on public.shift_offer_recipients(offer_id);

-- ============ RLS ============
alter table public.shift_offers           enable row level security;
alter table public.shift_offer_recipients enable row level security;

-- offer: 自スコープの管理者が閲覧、shift_edit∧自店 で作成/取消。承諾/拒否はdefiner経由(下記)
create policy so_sel on public.shift_offers for select to authenticated
  using (public.app_can_store(store_id));
create policy so_write on public.shift_offers for all to authenticated
  using (public.app_has_perm(tenant_id,'shift_edit') and public.app_can_store(store_id))
  with check (public.app_has_perm(tenant_id,'shift_edit') and public.app_can_store(store_id));

-- recipients: 同上（offer経由でスコープ判定）。staffには見せない（メールリンクで完結）
create policy sor_sel on public.shift_offer_recipients for select to authenticated
  using (exists (select 1 from public.shift_offers o
                 where o.id = offer_id and public.app_can_store(o.store_id)));
create policy sor_write on public.shift_offer_recipients for all to authenticated
  using (exists (select 1 from public.shift_offers o
                 where o.id = offer_id
                   and public.app_has_perm(o.tenant_id,'shift_edit')
                   and public.app_can_store(o.store_id)))
  with check (exists (select 1 from public.shift_offers o
                 where o.id = offer_id
                   and public.app_has_perm(o.tenant_id,'shift_edit')
                   and public.app_can_store(o.store_id)));

-- ============ definer: 承諾（早い者勝ち・原子的） ============
create or replace function public.app_offer_accept(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_hash text := encode(digest(p_token,'sha256'),'hex');
  v_rec  public.shift_offer_recipients%rowtype;
  v_off  public.shift_offers%rowtype;
  v_overlap boolean := false;
begin
  select * into v_rec from public.shift_offer_recipients where token_hash = v_hash;
  if not found then return jsonb_build_object('ok',false,'reason','invalid'); end if;

  select * into v_off from public.shift_offers where id = v_rec.offer_id for update;  -- 行ロック

  if v_off.status = 'filled' then
    if v_rec.response='pending' then
      update public.shift_offer_recipients set response='superseded', responded_at=now() where id=v_rec.id;
    end if;
    return jsonb_build_object('ok',false,'reason','already_filled');
  end if;
  if v_off.status in ('cancelled','expired') then
    return jsonb_build_object('ok',false,'reason',v_off.status);
  end if;
  if v_off.deadline_at < now() then
    update public.shift_offers set status='expired' where id=v_off.id and status='open';
    update public.shift_offer_recipients set response='superseded', responded_at=now()
      where offer_id=v_off.id and response='pending';
    return jsonb_build_object('ok',false,'reason','expired');
  end if;

  update public.shift_offers set status='filled', winner_staff_id=v_rec.staff_id, filled_at=now()
   where id=v_off.id and status='open';
  if not found then   -- レース負け
    update public.shift_offer_recipients set response='superseded', responded_at=now()
      where id=v_rec.id and response='pending';
    return jsonb_build_object('ok',false,'reason','already_filled');
  end if;

  select exists(
    select 1 from public.shift_assignments a
     where a.staff_id=v_rec.staff_id and a.store_id=v_off.store_id and a.work_date=v_off.work_date
       and a.start_min < v_off.end_min and a.end_min > v_off.start_min
  ) into v_overlap;

  -- ★GATE確認2: shift_assignments の実列に合わせる（tenant_id有無 / id default）
  insert into public.shift_assignments
    (tenant_id, staff_id, store_id, work_date, start_min, end_min, position_id, weight_half, status)
  values
    (v_off.tenant_id, v_rec.staff_id, v_off.store_id, v_off.work_date,
     v_off.start_min, v_off.end_min, v_off.position_id, v_off.weight_half, 'draft');

  update public.shift_offer_recipients set response='accepted', responded_at=now() where id=v_rec.id;
  update public.shift_offer_recipients set response='superseded', responded_at=now()
    where offer_id=v_off.id and id<>v_rec.id and response='pending';

  return jsonb_build_object('ok',true,'offer_id',v_off.id,'staff_id',v_rec.staff_id,
    'work_date',v_off.work_date,'start_min',v_off.start_min,'end_min',v_off.end_min,
    'overlap_warning',v_overlap);
end; $$;

-- ============ definer: 拒否（offerはopenのまま・管理者通知用に情報を返す） ============
create or replace function public.app_offer_decline(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_hash text := encode(digest(p_token,'sha256'),'hex');
  v_rec  public.shift_offer_recipients%rowtype;
  v_off  public.shift_offers%rowtype;
begin
  select * into v_rec from public.shift_offer_recipients where token_hash=v_hash;
  if not found then return jsonb_build_object('ok',false,'reason','invalid'); end if;
  select * into v_off from public.shift_offers where id=v_rec.offer_id;
  if v_rec.response='pending' then
    update public.shift_offer_recipients set response='declined', responded_at=now() where id=v_rec.id;
  end if;
  return jsonb_build_object('ok',true,'offer_id',v_off.id,'store_id',v_off.store_id,
    'work_date',v_off.work_date,'created_by',v_off.created_by,'staff_id',v_rec.staff_id);
end; $$;

-- ============ definer: 期限切れ掃除（cronから） ============
create or replace function public.app_offer_expire_due()
returns integer language plpgsql volatile security definer set search_path = public, extensions as $$
declare r record; n int := 0;
begin
  for r in select id from public.shift_offers where status='open' and deadline_at < now() loop
    update public.shift_offers set status='expired' where id=r.id and status='open';
    update public.shift_offer_recipients set response='superseded', responded_at=now()
      where offer_id=r.id and response='pending';
    n := n + 1;
  end loop;
  return n;
end; $$;

-- ============ 権限（Supabase既定grant潰し） ============
-- 承諾/拒否はメールリンク=未ログインから踏まれるので anon にも execute（トークン一致が唯一の鍵）
revoke all on function public.app_offer_accept(text)  from public;
revoke all on function public.app_offer_decline(text) from public;
revoke all on function public.app_offer_expire_due()  from public, anon;
grant execute on function public.app_offer_accept(text)  to anon, authenticated;
grant execute on function public.app_offer_decline(text) to anon, authenticated;
grant execute on function public.app_offer_expire_due()  to authenticated;  -- ★GATE確認3参照
