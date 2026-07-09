import { createFileRoute } from '@tanstack/react-router'
import { ROLE_LABEL, scopeLabel, useMe } from '@/lib/me-context'

export const Route = createFileRoute('/_authed/')({
  component: Dashboard,
})

function Dashboard() {
  const { me } = useMe()
  if (!me) return null

  return (
    <section className="dashboard">
      <div className="eyebrow">OVERVIEW</div>
      <div className="page-h">
        <h1>ダッシュボード</h1>
        <span className="desc">{me.tenantName}</span>
      </div>

      <div className="card-grid">
        <article className="card kpi">
          <div className="k">あなたの権限</div>
          <div className="v v-text">{ROLE_LABEL[me.role]}</div>
          <div className="d">閲覧範囲 · {scopeLabel(me)}</div>
        </article>

        <article className="card kpi">
          <div className="k">閲覧できる店舗</div>
          <div className="v">
            {me.stores.length}
            <small>店舗</small>
          </div>
          <ul className="card-list">
            {me.stores.length === 0 ? (
              <li className="empty">対象なし</li>
            ) : (
              me.stores.map((s) => <li key={s.id}>{s.name}</li>)
            )}
          </ul>
        </article>

        <article className="card kpi">
          <div className="k">エリア</div>
          <div className="v">
            {me.areas.length}
            <small>エリア</small>
          </div>
          <ul className="card-list">
            {me.areas.length === 0 ? (
              <li className="empty">対象なし</li>
            ) : (
              me.areas.map((a) => <li key={a.id}>{a.name}</li>)
            )}
          </ul>
        </article>
      </div>

      <div className="sec-h">
        <span className="rule" />
      </div>
      <p className="note">打刻・シフト・集計の各機能は準備中です。</p>
    </section>
  )
}
