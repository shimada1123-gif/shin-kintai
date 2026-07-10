-- 0021_relax_band_end.sql
-- 目的: 営業時間帯の終了上限を翌2:00→翌6:00に緩和（深夜営業の店に対応）。
-- 背景: 焼き鳥/居酒屋等で翌3〜5時まで営業する店があり、翌2:00(1560)では不足。
--       翌6:00(1800)=モーニング開始と接する自然な上限に緩める。

alter table public.shift_time_bands drop constraint if exists shift_time_bands_check;  -- 実名確認済み（end_min側CHECK。start_min側は shift_time_bands_start_min_check）
alter table public.shift_time_bands
  add constraint shift_time_bands_end_check
  check (end_min > start_min and end_min <= 1800);
