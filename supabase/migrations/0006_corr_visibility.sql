-- SHIN勤怠 : 0006 補正履歴のスタッフ可視性を運用トグル化（RLSで強制）
-- tenants.settings.staff_see_corrections が false のとき、スタッフは自分の補正履歴も見られない。
-- 既定（キー未設定 or true）は「見せる」。管理者(correction_approve/自店)は常に閲覧可。

-- settings を読むヘルパー（既定 true）
create or replace function public.app_staff_see_corr(tid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    (select (settings->>'staff_see_corrections')::boolean from public.tenants where id = tid),
    true);
$$;
grant execute on function public.app_staff_see_corr(uuid) to authenticated;

-- corr_sel を張り替え：
--  管理者(correction_approve かつ 自店) は常に閲覧可
--  本人分は staff_see_corrections が false でないときのみ閲覧可
drop policy if exists corr_sel on public.attendance_corrections;
create policy corr_sel on public.attendance_corrections for select to authenticated
  using (
    exists (
      select 1 from public.attendance a
      where a.id = attendance_id
      and (
        (public.app_has_perm(a.tenant_id,'correction_approve') and public.app_can_store(a.store_id))
        or (
          public.app_staff_id(a.tenant_id) = a.staff_id
          and public.app_staff_see_corr(a.tenant_id)
        )
      )
    )
  );
