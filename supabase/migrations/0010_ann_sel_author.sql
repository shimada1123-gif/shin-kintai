-- SHIN勤怠 : 0010 ann_sel 張替（投稿者本人を直接式で可視化、INSERT ... RETURNING 対応）
-- 0009 の ann_sel は app_announcement_visible(id) のみ。この関数は announcements を
-- 再SELECTするため、INSERT ... RETURNING（insert().select()）の評価では自ステートメントの
-- 挿入行がスナップショット上見えず false になり、投稿保存が RLS で失敗する
-- （PostgreSQL は RETURNING 行に SELECT ポリシーを適用し、満たさない行はエラーにする）。
-- author = auth.uid() は行の値を直接見る式なので新規行でも成立する。
-- 「投稿者本人は常に可視」ルールのポリシー式レベルでの表現でもある。
--
-- 整合の要点:
--  - deleted_at is null を外側に置く: 削除済みは自分の投稿でも一覧に出さない（0009の挙動を維持）。
--    app_announcement_visible 内部の deleted_at 判定と二重になるが矛盾はしない
--  - author 分岐にも app_is_member を課す: テナントを外れた元投稿者に見せない（0009 と同じ厳しさ。
--    memberships は別テーブルなので RETURNING 評価時も正しく読める）
--  - 他のポリシー（anns_sel / annk_sel / annr_sel / ann_ins / ann_upd）は
--    app_announcement_visible / app_announcement_manage を直接参照しており ann_sel に依存しない＝影響なし

drop policy if exists ann_sel on public.announcements;
create policy ann_sel on public.announcements for select to authenticated
  using (
    deleted_at is null
    and (
      (author = auth.uid() and public.app_is_member(tenant_id))
      or public.app_announcement_visible(id)
    )
  );
