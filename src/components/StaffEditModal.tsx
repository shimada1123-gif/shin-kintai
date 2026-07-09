import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AddEmploymentKind, AddPosition } from '@/components/InlineMasterAdd'
import { NumberInput } from '@/components/NumberInput'
import { errText } from '@/lib/errors'
import { useMe } from '@/lib/me-context'
import { usePermissions } from '@/lib/perm'
import {
  saveStaff,
  type AssignmentDraft,
  type EmploymentKind,
  type Position,
  type StaffWithDetails,
  type Store,
} from '@/lib/queries/master'

const QUICK_TAGS = ['社員', 'パート', 'アルバイト', '業務委託', '新人']
const NEWBIE_TAG = '新人'

function emptyAssignment(tenantId: string, staffId: string, storeId: string): AssignmentDraft {
  return {
    tenant_id: tenantId,
    staff_id: staffId,
    store_id: storeId,
    employment_kind_id: null,
    position_default_id: null,
    wage_type: 'hourly',
    hourly_wage: null,
    monthly_fixed: null,
    commute_type: 'none',
    commute_amount: null,
    is_newbie: false,
    is_trainer: false,
    is_active: true,
  }
}

export function StaffEditModal({
  staff,
  stores,
  kinds,
  positions,
  onClose,
}: {
  staff: StaffWithDetails
  stores: Store[]
  kinds: EmploymentKind[]
  positions: Position[]
  onClose: () => void
}) {
  const { me } = useMe()
  const perms = usePermissions()
  const qc = useQueryClient()

  // どの所属ブロックでインライン追加を開いているか（同時に1つだけ）
  const [addingKindFor, setAddingKindFor] = useState<number | null>(null)
  const [addingPosFor, setAddingPosFor] = useState<number | null>(null)

  const [fullName, setFullName] = useState(staff.full_name)
  const [tags, setTags] = useState<string[]>(staff.tags)
  const [newTag, setNewTag] = useState('')
  const [assignments, setAssignments] = useState<AssignmentDraft[]>(staff.assignments)
  const [removedIds, setRemovedIds] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  // Esc で閉じる。インライン追加を開いている間は、そちらを先に閉じる。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (addingKindFor !== null || addingPosFor !== null) {
        setAddingKindFor(null)
        setAddingPosFor(null)
        return
      }
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, addingKindFor, addingPosFor])

  const save = useMutation({
    mutationFn: () =>
      saveStaff({
        tenantId: me!.tenantId,
        staffId: staff.id,
        fullName,
        tags,
        originalTags: staff.tags,
        assignments,
        removedAssignmentIds: removedIds,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['master', 'staff'] })
      onClose()
    },
    onError: (e) => setError(errText(e, '保存に失敗しました')),
  })

  if (!me) return null

  // インライン追加は RLS の staff_master_edit が前提。持たない役割にはボタンを出さない。
  const canEdit = perms.has('staff_master_edit')

  /* 「新人」タグと is_newbie は連動させる */
  const setNewbieEverywhere = (on: boolean) =>
    setAssignments((prev) => prev.map((a) => ({ ...a, is_newbie: on })))

  const addTag = (t: string) => {
    const v = t.trim()
    if (!v || tags.includes(v)) return
    setTags([...tags, v])
    if (v === NEWBIE_TAG) setNewbieEverywhere(true)
  }

  const delTag = (t: string) => {
    setTags(tags.filter((x) => x !== t))
    if (t === NEWBIE_TAG) setNewbieEverywhere(false)
  }

  const patchAssignment = (idx: number, patch: Partial<AssignmentDraft>) =>
    setAssignments((prev) => {
      const next = prev.map((a, i) => (i === idx ? { ...a, ...patch } : a))
      // どこか1つでも新人なら「新人」タグを立てる
      if ('is_newbie' in patch) {
        const anyNewbie = next.some((a) => a.is_newbie)
        setTags((t) =>
          anyNewbie
            ? t.includes(NEWBIE_TAG)
              ? t
              : [...t, NEWBIE_TAG]
            : t.filter((x) => x !== NEWBIE_TAG),
        )
      }
      return next
    })

  const removeAssignment = (idx: number) => {
    const target = assignments[idx]
    if (target.id) setRemovedIds([...removedIds, target.id])
    setAssignments(assignments.filter((_, i) => i !== idx))
  }

  const unusedStores = stores.filter((s) => !assignments.some((a) => a.store_id === s.id))

  return (
    <div className="modal show" onClick={onClose} role="dialog" aria-modal="true">
      <div className="mcard mcard-wide" onClick={(e) => e.stopPropagation()}>
        <div className="mh">{staff.full_name} を編集</div>

        {error && (
          <p className="login-error" role="alert">
            {error}
          </p>
        )}

        <div className="fld">
          <label htmlFor="staff-name">氏名</label>
          <input
            id="staff-name"
            className="ri"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
          />
        </div>

        <div className="fld">
          <label>区分タグ（付け外し自由）</label>
          <div className="tagwrap">
            {tags.map((t) => (
              <span key={t} className="tagchip">
                {t}
                <span className="x" onClick={() => delTag(t)} role="button" aria-label={`${t} を削除`}>
                  ×
                </span>
              </span>
            ))}
            <span className="tagadd">
              <input
                value={newTag}
                placeholder="タグ追加"
                onChange={(e) => setNewTag(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addTag(newTag)
                    setNewTag('')
                  }
                }}
              />
              <button
                type="button"
                onClick={() => {
                  addTag(newTag)
                  setNewTag('')
                }}
              >
                ＋
              </button>
            </span>
          </div>
          <div className="note tagsug-row">
            よく使う：
            {QUICK_TAGS.map((t) => (
              <span key={t} className="tagsug" onClick={() => addTag(t)}>
                ＋{t}
              </span>
            ))}
          </div>
        </div>

        <div className="fld">
          <label>所属店舗（店舗ごとに区分・給与・交通費を設定）</label>

          {assignments.length === 0 && <p className="note">所属店舗がありません。</p>}

          {assignments.map((a, idx) => {
            const store = stores.find((s) => s.id === a.store_id)
            const contractor = a.wage_type === 'invoice'
            const storePositions = positions.filter(
              (p) => p.store_id === null || p.store_id === a.store_id,
            )

            return (
              <div key={a.id ?? `new-${idx}`} className="asg">
                <div className="asg-head">
                  <b>{store?.name ?? '(不明な店舗)'}</b>
                  <button type="button" className="btn sm" onClick={() => removeAssignment(idx)}>
                    所属を外す
                  </button>
                </div>

                <div className="asg-grid">
                  <div className="field">
                    <span>雇用区分</span>
                    {addingKindFor === idx ? (
                      <AddEmploymentKind
                        tenantId={me.tenantId}
                        onCreated={(id) => {
                          patchAssignment(idx, { employment_kind_id: id })
                          setAddingKindFor(null)
                        }}
                        onCancel={() => setAddingKindFor(null)}
                      />
                    ) : (
                      <div className="select-with-add">
                        <select
                          aria-label="雇用区分"
                          value={a.employment_kind_id ?? ''}
                          onChange={(e) =>
                            patchAssignment(idx, { employment_kind_id: e.target.value || null })
                          }
                        >
                          <option value="">未設定</option>
                          {kinds.map((k) => (
                            <option key={k.id} value={k.id}>
                              {k.label}
                            </option>
                          ))}
                        </select>
                        {canEdit && (
                          <button
                            type="button"
                            className="btn sm add-new"
                            onClick={() => setAddingKindFor(idx)}
                          >
                            ＋新規
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="field">
                    <span>既定ポジション</span>
                    {addingPosFor === idx ? (
                      <AddPosition
                        tenantId={me.tenantId}
                        storeId={a.store_id}
                        storeName={store?.name ?? 'この店舗'}
                        onCreated={(id) => {
                          patchAssignment(idx, { position_default_id: id })
                          setAddingPosFor(null)
                        }}
                        onCancel={() => setAddingPosFor(null)}
                      />
                    ) : (
                      <div className="select-with-add">
                        <select
                          aria-label="既定ポジション"
                          value={a.position_default_id ?? ''}
                          onChange={(e) =>
                            patchAssignment(idx, { position_default_id: e.target.value || null })
                          }
                        >
                          <option value="">未設定</option>
                          {storePositions.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                        {canEdit && (
                          <button
                            type="button"
                            className="btn sm add-new"
                            onClick={() => setAddingPosFor(idx)}
                          >
                            ＋新規
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                <div className="tgl-row">
                  <label className="tgl">
                    <span
                      className={`cbx2${a.is_newbie ? ' on' : ''}`}
                      onClick={() => patchAssignment(idx, { is_newbie: !a.is_newbie })}
                    />
                    新人（要指導・0.5換算）
                  </label>
                  <label className="tgl">
                    <span
                      className={`cbx2${a.is_trainer ? ' on' : ''}`}
                      onClick={() => patchAssignment(idx, { is_trainer: !a.is_trainer })}
                    />
                    指導可（トレーナー）
                  </label>
                </div>

                <div className="wtype">
                  {(['hourly', 'fixed', 'invoice'] as const).map((w) => (
                    <label key={w} className="rd">
                      <input
                        type="radio"
                        name={`wt-${idx}`}
                        checked={a.wage_type === w}
                        onChange={() => patchAssignment(idx, { wage_type: w })}
                      />
                      {w === 'hourly' ? '時給' : w === 'fixed' ? '固定給' : '請求（委託）'}
                    </label>
                  ))}
                </div>

                {contractor ? (
                  <div className="note">稼働自己申告・請求書ベース（打刻/割増なし）</div>
                ) : (
                  <div className="amtrow">
                    <NumberInput
                      min={0}
                      placeholder="未設定"
                      aria-label={a.wage_type === 'hourly' ? '時給' : '固定給'}
                      value={a.wage_type === 'hourly' ? a.hourly_wage : a.monthly_fixed}
                      onChange={(v) =>
                        patchAssignment(
                          idx,
                          a.wage_type === 'hourly' ? { hourly_wage: v } : { monthly_fixed: v },
                        )
                      }
                    />
                    <span className="unit">{a.wage_type === 'hourly' ? '円 / 時' : '円 / 月'}</span>
                  </div>
                )}

                <div className="asg-grid commute">
                  <label className="field">
                    <span>交通費</span>
                    <select
                      value={a.commute_type}
                      onChange={(e) =>
                        patchAssignment(idx, { commute_type: e.target.value as string })
                      }
                    >
                      <option value="none">なし</option>
                      <option value="daily">日額</option>
                      <option value="monthly">月額（定期）</option>
                    </select>
                  </label>

                  {a.commute_type !== 'none' && (
                    <label className="field">
                      <span>金額</span>
                      <div className="amtrow">
                        <NumberInput
                          min={0}
                          placeholder="0"
                          aria-label="交通費"
                          value={a.commute_amount}
                          onChange={(v) => patchAssignment(idx, { commute_amount: v })}
                        />
                        <span className="unit">
                          {a.commute_type === 'daily' ? '円 / 日' : '円 / 月'}
                        </span>
                      </div>
                    </label>
                  )}
                </div>
              </div>
            )
          })}

          {unusedStores.length > 0 && (
            <div className="asg-add">
              <select
                defaultValue=""
                onChange={(e) => {
                  if (!e.target.value) return
                  setAssignments([
                    ...assignments,
                    emptyAssignment(me.tenantId, staff.id, e.target.value),
                  ])
                  e.target.value = ''
                }}
              >
                <option value="">＋ 所属店舗を追加</option>
                {unusedStores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div className="mbtns">
          <button type="button" className="btn sm" onClick={onClose}>
            閉じる
          </button>
          <button
            type="button"
            className="btn sm pri"
            onClick={() => {
              setError(null)
              save.mutate()
            }}
            disabled={save.isPending}
          >
            {save.isPending ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
