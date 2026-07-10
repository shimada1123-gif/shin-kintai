-- 0017_shift_notified.sql
-- 目的: シフト確定(published)と「スタッフへの通知(メール)」を分離する。
-- 方針: additive な notified_at 列のみ追加。既存の確定=published はそのまま。
--       通知時に notified_at をスタンプ。「published かつ notified_at is null」= 確定済み・未通知。
--       status 値域・publishWeek・fetchMyShifts・充足度カウント・RLS はすべて無変更。

alter table public.shift_assignments add column if not exists notified_at timestamptz;

-- 未通知の確定シフトを速く集めるための部分インデックス
create index if not exists idx_sa_unnotified_published
  on public.shift_assignments (store_id, work_date)
  where status = 'published' and notified_at is null;

-- 既存の published 行は分離前の確定データ＝通知の概念が無かった時代のもの。
-- 適用時点で「既通知」扱いにし、通知パネルには分離後の新しい確定だけを出す。
update public.shift_assignments set notified_at = now()
  where status = 'published' and notified_at is null;
