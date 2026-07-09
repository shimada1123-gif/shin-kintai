-- SHIN勤怠 Phase 1 : 0005 ワンタイムQR（種別付き・使い捨て）
-- モデルB: 店舗端末が種別ボタンを押して1枚だけQR発行、スタッフは読むだけ。
-- 1トークン=1打刻。punch成功時に used_at を立てて消費し、2人目以降は弾く。

-- 種別（どの打刻用に発行されたQRか）
alter table public.qr_tokens
  add column if not exists kind text
  check (kind in ('clock_in','break_start','break_end','clock_out'));

-- 消費時刻（NULL=未使用）。1トークン1回の使い捨てを表す。
alter table public.qr_tokens
  add column if not exists used_at timestamptz;

-- 消費したのが誰か（監査用・任意）
alter table public.qr_tokens
  add column if not exists used_by uuid references public.staff(id) on delete set null;

-- 未使用トークンをtokenで一意に引く（punch時の atomic 消費に使う）。
create index if not exists idx_qr_token_unused
  on public.qr_tokens (token) where used_at is null;

-- 期限切れ/使用済みの掃除を速くする補助インデックス
create index if not exists idx_qr_expires on public.qr_tokens (expires_at);
