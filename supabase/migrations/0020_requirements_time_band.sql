-- 0020_requirements_time_band.sql
-- 目的: 必要人数(shift_requirements)を「曜日×時間帯」粒度で持てるようにする。
-- 方針: time_band_id を nullable で追加（null=時間帯を分けない/通し＝既存要件はそのまま生存）。
--       unique を nulls not distinct にすることで、null(通し)も1行に制約でき既存upsertを温存。
--       既存データは移行不要。後方互換で全店に時間帯を強制しない。

-- ① time_band_id 追加（nullable・帯は論理削除運用のため on delete restrict）
alter table public.shift_requirements
  add column if not exists time_band_id uuid references public.shift_time_bands(id) on delete restrict;

-- ② 既存 unique(store_id, day_type) を drop（実制約名: shift_requirements_store_id_day_type_key）
alter table public.shift_requirements
  drop constraint if exists shift_requirements_store_id_day_type_key;

-- ③ nulls not distinct の複合 unique に張替（PG15+）。null(通し)同士も同一扱い＝曜日ごと1行を維持。
--    time_band_id ありは (store,day_type,band) で1行。upsert の onConflict をこの3列に向ければ温存可。
alter table public.shift_requirements
  add constraint shift_requirements_store_day_band_key
  unique nulls not distinct (store_id, day_type, time_band_id);
