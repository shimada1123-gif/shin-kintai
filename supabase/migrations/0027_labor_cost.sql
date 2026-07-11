-- 0027_labor_cost.sql
-- 目的: 人件費概算の集計 definer 関数 app_labor_cost（C-2）。
-- 背景: sa_sel は wage_individual_view or 本人のみ＝店長(shift_edit)は賃金列を読めない。
--   集計はDB側で行い「集計値のみ」返す（0012 の賃金非露出先例・設計メモ§3-5）。
-- 確定仕様（5小決定）:
--   対象=保存済み shift_assignments のみ(draft+published)。未保存草案は集計しない（推論穴回避）。
--   weight_half 無視=実時間ベース。hourly のみ cost 算入（fixed/invoice/時給未設定は excluded_count に行数計上）。
--   深夜割増なし・交通費なし・人件費率なし（金額円＋分のみ）。
-- ★個別非露出: 戻りは work_date×status の集計6列のみ。staff_id/個別額/個別時給は返さない。
--   引数は store と期間のみ＝1人に絞れる引数を持たせない。
-- テーブル追加なし・RLS変更なし・移行DMLなし。

-- 認可: labor_cost_view ∧ app_can_store（いずれも auth.uid() ベース＝呼び出し者JWT必須。
--   service_role から呼ぶと tenant 導出後の perm 判定で例外になる）。
-- tenant は p_store_id → stores.tenant_id で導出（越境店舗IDは「店舗が見つかりません」で中断）。
-- 丸め規約（決定的）: 行ごとに (end_min - start_min) * hourly_wage / 60 の整数除算＝円未満切り捨て、を合算。
create or replace function public.app_labor_cost(p_store_id uuid, p_from date, p_to date)
returns table (
  work_date      date,
  status         text,
  total_min      integer,  -- hourly算入行の実時間合計（分）
  staff_count    integer,  -- hourly算入行の実人数（distinct staff）
  cost_yen       bigint,   -- hourly算入行の概算人件費（円・行単位切り捨ての合算）
  excluded_count integer   -- 集計対象外の行数（fixed/invoice/時給未設定/賃金行なし）
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tenant uuid;
begin
  select s.tenant_id into v_tenant from public.stores s where s.id = p_store_id;
  if v_tenant is null then
    raise exception '店舗が見つかりません';
  end if;
  if not public.app_has_perm(v_tenant, 'labor_cost_view') then
    raise exception '人件費を閲覧する権限がありません（labor_cost_view が必要です）';
  end if;
  if not public.app_can_store(p_store_id) then
    raise exception 'この店舗の人件費を閲覧する権限がありません';
  end if;

  return query
  select
    a.work_date,
    a.status,
    coalesce(
      sum(a.end_min - a.start_min)
        filter (where sa.wage_type = 'hourly' and sa.hourly_wage is not null),
      0
    )::integer as total_min,
    (count(distinct a.staff_id)
        filter (where sa.wage_type = 'hourly' and sa.hourly_wage is not null)
    )::integer as staff_count,
    coalesce(
      sum(((a.end_min - a.start_min) * sa.hourly_wage) / 60)
        filter (where sa.wage_type = 'hourly' and sa.hourly_wage is not null),
      0
    )::bigint as cost_yen,
    (count(*)
        filter (where sa.staff_id is null
                or sa.wage_type <> 'hourly'
                or sa.hourly_wage is null)
    )::integer as excluded_count
  from public.shift_assignments a
  left join public.staff_assignments sa
    on sa.staff_id = a.staff_id and sa.store_id = a.store_id  -- unique(staff_id,store_id)=1行に解決
  where a.store_id = p_store_id
    and a.work_date between p_from and p_to
  group by a.work_date, a.status
  order by a.work_date, a.status;
end $$;

-- Supabase 既定 grant 潰し → authenticated のみ
revoke all on function public.app_labor_cost(uuid, date, date) from public, anon;
grant execute on function public.app_labor_cost(uuid, date, date) to authenticated;
