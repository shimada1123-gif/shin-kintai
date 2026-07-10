-- SHIN勤怠 : 0011 掲示板の論理削除を security definer 関数に変更
-- 原因: PostgREST の UPDATE は Prefer: return=minimal でも内部的に RETURNING 付き CTE を生成し、
-- 更新後の行に SELECT ポリシーが適用される。削除 UPDATE の更新後行は deleted_at IS NOT NULL となり、
-- ann_sel（0010: deleted_at is null ∧ …）を満たさず 42501 になる（クライアントが .select() を
-- 付けなくても回避できない）。
-- 対処: ポリシー（ann_sel / ann_upd）は一切変更せず（削除済み=全員不可視・復元不可を維持）、
-- 削除だけ権限チェック内蔵の definer 関数で行い、RLS の RETURNING 評価を経由しないようにする。
-- 権限判定は app_announcement_manage（owner / 投稿者本人 / announce_post∧対象店舗）と同一。
-- app_announcement_manage は deleted_at / app_announcement_visible に依存しない（0009 定義のまま）。
-- 戻り値: true=削除成功 / false=存在しない・他テナント・すでに削除済み・権限なし
-- 編集（deleted_at を触らない update）は更新後も ann_sel を満たすため従来どおりで問題なし。

create or replace function public.app_announcement_delete(aid uuid)
returns boolean language plpgsql volatile security definer set search_path = public as $$
declare del timestamptz;
begin
  select deleted_at into del from public.announcements where id = aid;
  if not found then return false; end if;                          -- 存在しない
  if del is not null then return false; end if;                    -- すでに削除済み（復元・二重削除不可）
  if not public.app_announcement_manage(aid) then return false; end if;  -- 権限なし
  update public.announcements
     set deleted_at = now(), deleted_by = auth.uid()
   where id = aid and deleted_at is null;
  return true;
end; $$;

grant execute on function public.app_announcement_delete(uuid) to authenticated;
