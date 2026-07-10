-- 0018_my_offers.sql
-- 目的: スタッフ本人が「自分へのオファー（申請中/確定/結果）」をアプリで確認できるようにする。
-- 方針: security definer 関数で本人の recipients×offers を join し、本人に必要な列だけ返す。
--       token_hash / winner_staff_id / created_by / email など機微・他人情報は構造的に返さない。
--       RLS(sor_sel/so_sel)は無変更（管理者スコープのまま）。0012 app_store_roster と同型。

create or replace function public.app_my_offers()
returns table (
  offer_id       uuid,
  work_date      date,
  start_min      int,
  end_min        int,
  position_name  text,
  offer_status   text,
  my_response    text,
  my_comment     text,
  deadline_at    timestamptz,
  responded_at   timestamptz,
  is_my_win      boolean          -- 自分が確定者か（winner_staff_id を露出せず boolean 化）
)
language sql
stable
security definer
set search_path = public
as $$
  select
    o.id                              as offer_id,
    o.work_date,
    o.start_min,
    o.end_min,
    p.name                            as position_name,   -- 不問(null)は null のまま
    o.status                          as offer_status,
    r.response                        as my_response,
    r.comment                         as my_comment,
    o.deadline_at,
    r.responded_at,
    (o.winner_staff_id = r.staff_id)  as is_my_win
  from public.shift_offer_recipients r
  join public.shift_offers o           on o.id = r.offer_id
  left join public.positions p         on p.id = o.position_id
  where r.staff_id = public.app_staff_id(o.tenant_id)   -- 各offerのテナントで本人のstaff_idに一致する行のみ
    and o.status <> 'draft'                             -- 未送信の下書きは本人に見せない
  order by o.work_date, o.start_min
$$;

-- 本人閲覧用。anon 不要（ログイン済みスタッフのみ）
revoke all on function public.app_my_offers() from public, anon;
grant execute on function public.app_my_offers() to authenticated;
