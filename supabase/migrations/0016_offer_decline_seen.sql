-- 0016_offer_decline_seen.sql
-- 目的: 管理者が「新しい辞退（未確認）」に気づけるよう、辞退の管理者確認時刻を持つ。
-- 方針: additive な1列追加のみ。RLS 改修不要（既存 sor_write=shift_edit∧自店 が update を許可）。
--       未確認判定 = response='declined' ∧ mgr_seen_at is null。確認操作は blind update。

alter table public.shift_offer_recipients add column if not exists mgr_seen_at timestamptz;

-- 「新しい辞退」バッジ判定を速くするための部分インデックス（未確認辞退のみ）
create index if not exists idx_sor_unseen_declined
  on public.shift_offer_recipients (offer_id)
  where response = 'declined' and mgr_seen_at is null;
