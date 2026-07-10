-- SHIN勤怠 : 0008 シフト要件にポジション別必要数を追加（B案：ポジション別を主軸）
-- shift_requirements に need_by_position（jsonb）を足す。
-- 例 {"キッチン":2, "フロア":2, "洗い場":1}。need_count(全体) は今後この合計を保存する運用。
-- min_by_kind(雇用区分別最低) は補助制約として併存。
alter table public.shift_requirements
  add column if not exists need_by_position jsonb not null default '{}'::jsonb;
