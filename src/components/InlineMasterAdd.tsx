import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { errText } from '@/lib/errors'
import { createEmploymentKind, createPosition } from '@/lib/queries/master'

/**
 * セレクトの隣で employment_kinds / positions をその場で追加する。
 * 通常セッション（RLS 経由）で書き込むため、staff_master_edit を持たなければ
 * ポリシーに弾かれ、日本語のエラーが出る。
 */

interface BaseProps {
  tenantId: string
  /** 追加した行の id。呼び出し側でセレクトに選択させる。 */
  onCreated: (id: string) => void
  onCancel: () => void
}

function useCreateAndSelect(
  queryKey: string[],
  onCreated: (id: string) => void,
  fallbackMsg: string,
  setError: (m: string | null) => void,
) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (fn: () => Promise<string>) => {
      const id = await fn()
      // 一覧を取り直してから選択する（セレクトに選択肢が無い状態を作らない）
      await qc.invalidateQueries({ queryKey })
      return id
    },
    onSuccess: onCreated,
    onError: (e) => setError(errText(e, fallbackMsg)),
  })
}

/* --------------------------- 雇用区分 --------------------------- */

export function AddEmploymentKind({ tenantId, onCreated, onCancel }: BaseProps) {
  const [label, setLabel] = useState('')
  const [contractor, setContractor] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const create = useCreateAndSelect(
    ['master', 'kinds'],
    onCreated,
    '区分の追加に失敗しました',
    setError,
  )

  const submit = () => {
    const name = label.trim()
    if (!name) return
    setError(null)
    create.mutate(() =>
      createEmploymentKind(tenantId, name, {
        is_hourly: !contractor,
        requires_clock: !contractor,
        applies_premium: !contractor,
      }),
    )
  }

  return (
    <div className="inline-new">
      {error && (
        <p className="login-error" role="alert">
          {error}
        </p>
      )}
      <div className="inline-new-row">
        <input
          autoFocus
          value={label}
          placeholder="例）社員 / 業務委託"
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            }
            if (e.key === 'Escape') onCancel()
          }}
        />
        <button type="button" className="btn sm pri" disabled={!label.trim() || create.isPending} onClick={submit}>
          {create.isPending ? '追加中…' : '追加'}
        </button>
        <button type="button" className="btn sm" onClick={onCancel}>
          取消
        </button>
      </div>
      <label className="tgl inline-new-opt">
        <span className={`cbx2${contractor ? ' on' : ''}`} onClick={() => setContractor((v) => !v)} />
        業務委託（打刻・割増の対象外）
      </label>
    </div>
  )
}

/* -------------------------- ポジション -------------------------- */

export function AddPosition({
  tenantId,
  storeId,
  storeName,
  onCreated,
  onCancel,
}: BaseProps & { storeId: string; storeName: string }) {
  const [name, setName] = useState('')
  const [shared, setShared] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const create = useCreateAndSelect(
    ['master', 'positions'],
    onCreated,
    'ポジションの追加に失敗しました',
    setError,
  )

  const submit = () => {
    const v = name.trim()
    if (!v) return
    setError(null)
    create.mutate(() => createPosition(tenantId, v, shared ? null : storeId))
  }

  return (
    <div className="inline-new">
      {error && (
        <p className="login-error" role="alert">
          {error}
        </p>
      )}
      <div className="inline-new-row">
        <input
          autoFocus
          value={name}
          placeholder="例）キッチン / フロア"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            }
            if (e.key === 'Escape') onCancel()
          }}
        />
        <button type="button" className="btn sm pri" disabled={!name.trim() || create.isPending} onClick={submit}>
          {create.isPending ? '追加中…' : '追加'}
        </button>
        <button type="button" className="btn sm" onClick={onCancel}>
          取消
        </button>
      </div>
      <label className="tgl inline-new-opt">
        <span className={`cbx2${shared ? ' on' : ''}`} onClick={() => setShared((v) => !v)} />
        全店共通にする（オフなら {storeName} 専用）
      </label>
    </div>
  )
}
