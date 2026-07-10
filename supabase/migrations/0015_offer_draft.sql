-- 0015_offer_draft.sql
-- 目的: オファーに「下書き(draft)」状態を追加し、作成即送信をやめて「下書きに溜める→一斉送信」を可能にする。
-- 変更点: shift_offers.status CHECK に 'draft' 追加 / app_offer_accept を status='open' のみ許可にガード。
-- 背景: 現 accept は filled/cancelled/expired/締切超過を除外列挙するだけで draft を素通りさせる。
--       下書きはリンク未送信なので実害は薄いが、安全のため open 以外は明示的に弾く。

-- ① status CHECK 貼り替え（draft 追加）。既存行は open/filled/cancelled/expired のみ＝影響なし。
--    順序: drop → add（既存値は新CHECKの範囲内なので add で落ちない。移行UPDATE不要）
alter table public.shift_offers drop constraint if exists shift_offers_status_check;
alter table public.shift_offers
  add constraint shift_offers_status_check
  check (status in ('draft','open','filled','cancelled','expired'));

-- ② app_offer_accept を「open のみ受付」にガード（draft/その他を弾く）
--    0014 の2引数版を踏襲。search_path も維持（digest 解決）。本体は status 判定に draft 除外を追加するのみ。
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

  -- open 以外は受け付けない（draft=未送信 / filled / cancelled / expired）
  if v_off.status = 'draft' then
    return jsonb_build_object('ok',false,'reason','invalid');  -- 未送信リンク=無効扱い
  end if;
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

-- grant は 0014 のまま（accept は anon+authenticated）。再宣言不要だが念のため明示。
revoke all on function public.app_offer_accept(text, text) from public;
grant execute on function public.app_offer_accept(text, text) to anon, authenticated;
