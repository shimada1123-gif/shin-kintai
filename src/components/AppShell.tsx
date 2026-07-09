import { Link, Outlet, useRouterState } from '@tanstack/react-router'
import { useAuth } from '@/lib/auth'
import { ROLE_LABEL, scopeLabel, useMe, type Role } from '@/lib/me-context'

interface NavItem {
  to: string
  label: string
  roles: Role[]
}

const NAV: NavItem[] = [
  { to: '/', label: 'ダッシュボード', roles: ['owner', 'area_manager', 'store_manager', 'staff'] },
  { to: '/punch', label: '打刻', roles: ['owner', 'area_manager', 'store_manager', 'staff'] },
  { to: '/attendance', label: '勤怠', roles: ['owner', 'area_manager', 'store_manager', 'staff'] },
  { to: '/shifts', label: 'シフト', roles: ['owner', 'area_manager', 'store_manager'] },
  { to: '/staff', label: 'スタッフ', roles: ['owner', 'area_manager', 'store_manager'] },
  { to: '/reports', label: 'レポート', roles: ['owner', 'area_manager'] },
  { to: '/users', label: 'ユーザー管理', roles: ['owner', 'area_manager', 'store_manager'] },
  { to: '/settings', label: '設定', roles: ['owner'] },
]

/** 暖簾風の細い横棒4本。2本目だけ山吹。 */
function Noren() {
  return (
    <div className="noren" aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
    </div>
  )
}

export function AppShell() {
  const { user, signOut } = useAuth()
  const { me } = useMe()
  const pathname = useRouterState({ select: (s) => s.location.pathname })

  if (!me) return null

  const items = NAV.filter((n) => n.roles.includes(me.role))
  const displayName = me.staffName ?? user?.email ?? ''
  const initial = displayName.slice(0, 1).toUpperCase()

  return (
    <div className="shell-root">
      {me.testMode && (
        <div className="testmode-banner" role="status">
          テストモード — デモ打刻が有効です。実勤怠とは分離されています。
        </div>
      )}
      <div className="shell">
      <aside className="side">
        <div className="brand">
          <Noren />
          <h1>
            SHIN<span>勤怠</span>
          </h1>
          <div className="sub">KINTAI · SHIFT</div>
        </div>

        <nav className="shell-nav" aria-label="メインナビゲーション">
          <div className="navlab">MENU</div>
          {items.map((item) => {
            const active = item.to === '/' ? pathname === '/' : pathname.startsWith(item.to)
            return (
              <Link key={item.to} to={item.to} className={`nav-item${active ? ' is-active' : ''}`}>
                {item.label}
              </Link>
            )
          })}
        </nav>

        <div className="side-foot">PHASE 1</div>
      </aside>

      <div className="shell-main">
        <header className="topbar">
          <span className="tenant-name">{me.tenantName}</span>
          <span className={`role-badge role-${me.role}`}>{ROLE_LABEL[me.role]}</span>

          <div className="scope">
            <span className="tag">SCOPE</span>
            <span className="scope-chip">{scopeLabel(me)}</span>
          </div>

          <div className="who">
            <div className="av" aria-hidden="true">
              {initial}
            </div>
            <div>
              <div className="nm">{displayName}</div>
              <div className="rl">{ROLE_LABEL[me.role]}</div>
            </div>
            <button className="btn-ghost" onClick={() => void signOut()}>
              ログアウト
            </button>
          </div>
        </header>

        <div className="wrap">
          <Outlet />
        </div>
        </div>
      </div>
    </div>
  )
}

export function Placeholder({ title }: { title: string }) {
  return (
    <section className="placeholder">
      <div className="eyebrow">SHIN KINTAI</div>
      <div className="page-h">
        <h1>{title}</h1>
      </div>
      <p className="note">準備中です。</p>
    </section>
  )
}
