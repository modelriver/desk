import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createFileRoute, getRouteApi, Link, Outlet, redirect, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { getMe, signOut } from '../../functions/users.ts'
import { waitingCount } from '../../functions/dashboard.ts'
import { BrandMark } from '../../components/BrandMark.tsx'
import { ArchiveIcon, BookIcon, ChartIcon, ChevronsUpDownIcon, SettingsIcon, UserIcon, ExternalIcon, InboxIcon, LinkIcon, LogOutIcon, UsersIcon } from '../../components/icons.tsx'
import { Badge } from '../../components/ui.tsx'
import { cn } from '../../lib/cn.ts'
import { initials as initialsOf } from '../../lib/initials.ts'

const root = getRouteApi('__root__')

export const Route = createFileRoute('/dashboard')({
  beforeLoad: async () => {
    const user = await getMe()
    if (!user) throw redirect({ to: '/login' })
    return { user }
  },
  head: () => ({ meta: [{ title: 'Dashboard' }, { name: 'robots', content: 'noindex, nofollow' }] }),
  headers: () => ({ 'X-Robots-Tag': 'noindex, nofollow' }),
  component: DashboardLayout,
})

function NavItem({
  to,
  icon,
  children,
  exact,
  count,
}: {
  to: string
  icon: ReactNode
  children: ReactNode
  exact?: boolean
  count?: { value: number; label: string }
}) {
  return (
    <Link
      to={to}
      activeOptions={{ exact }}
      className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
      // A soft tint of the text colour reads as selected in both light and dark.
      activeProps={{ className: '!bg-foreground/8 font-medium !text-foreground' }}
    >
      {icon}
      {children}
      {count && count.value > 0 && (
        <span
          className="ml-auto grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground tabular-nums"
          title={count.label}
        >
          {count.value}
          <span className="sr-only"> {count.label}</span>
        </span>
      )}
    </Link>
  )
}

// How many visitors are waiting for a person, checked every 15 seconds and
// on every page change, so it shows on any dashboard page.
function useWaitingCount(): number {
  const fetchCount = useServerFn(waitingCount)
  const router = useRouter()
  const [count, setCount] = useState(0)
  useEffect(() => {
    let alive = true
    const check = () =>
      fetchCount()
        .then((r) => alive && setCount(r.waiting))
        .catch(() => {})
    void check()
    const timer = setInterval(check, 15_000)
    const unsubscribe = router.subscribe('onResolved', () => void check())
    return () => {
      alive = false
      clearInterval(timer)
      unsubscribe()
    }
  }, [fetchCount, router])
  return count
}

function DashboardLayout() {
  const { user } = Route.useRouteContext()
  const { brandName, logo, showName } = root.useLoaderData()
  const router = useRouter()
  const logout = useServerFn(signOut)
  const waiting = useWaitingCount()
  const initials = initialsOf(user.name)

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[15rem_1fr]">
      <aside className="flex flex-col gap-1 border-b border-border bg-muted/40 p-3 md:sticky md:top-0 md:h-dvh md:border-r md:border-b-0">
        <Link to="/dashboard" className="mb-3 flex min-w-0 items-center gap-2.5 px-2 py-1.5 font-semibold tracking-tight" aria-label={showName ? undefined : brandName}>
          <BrandMark logo={logo} size={24} />
          {showName && <span className="truncate">{brandName}</span>}
        </Link>
        <nav className="flex gap-1 overflow-x-auto md:flex-col" aria-label="Dashboard">
          <NavItem
            to="/dashboard"
            icon={<InboxIcon />}
            exact
            count={{ value: waiting, label: waiting === 1 ? 'person waiting for the team' : 'people waiting for the team' }}
          >
            Conversations
          </NavItem>
          <NavItem to="/dashboard/archived" icon={<ArchiveIcon />}>
            Archived
          </NavItem>
          <NavItem to="/dashboard/insights" icon={<ChartIcon />}>
            Insights
          </NavItem>
          {user.role === 'admin' && (
            <NavItem to="/dashboard/data" icon={<BookIcon />}>
              Knowledge
            </NavItem>
          )}
          {user.role === 'admin' && (
            <NavItem to="/dashboard/users" icon={<UsersIcon />}>
              Users
            </NavItem>
          )}
          {user.role === 'admin' && (
            <NavItem to="/dashboard/integrations" icon={<LinkIcon />}>
              Integrations
            </NavItem>
          )}
          {user.role === 'admin' && (
            <NavItem to="/dashboard/settings" icon={<SettingsIcon />}>
              Settings
            </NavItem>
          )}
          <a
            href="/articles"
            className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
          >
            <ExternalIcon />
            Help center
          </a>
        </nav>
        <AccountMenu
          user={user}
          initials={initials}
          onSignOut={async () => {
            await logout()
            await router.invalidate()
            await router.navigate({ to: '/login' })
          }}
        />
      </aside>
      <main className="min-w-0 px-4 py-6 sm:px-8 sm:py-8">
        <div className="mx-auto max-w-4xl">
          <Outlet />
        </div>
      </main>
    </div>
  )
}

// Account row at the foot of the sidebar: who is signed in, with a small menu
// for the rest (role, help center, sign out).
function AccountMenu({
  user,
  initials,
  onSignOut,
}: {
  user: { name: string; email: string; role: 'admin' | 'agent' }
  initials: string
  onSignOut: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const avatar = (size: string) => (
    <span
      className={cn(
        'grid shrink-0 place-items-center rounded-lg bg-primary/12 font-semibold text-primary',
        size,
      )}
      aria-hidden="true"
    >
      {initials}
    </span>
  )

  return (
    <div ref={root} className="relative mt-2 md:mt-auto">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-lg p-2 text-left outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring/50',
          open && 'bg-foreground/8',
        )}
      >
        {avatar('size-8 text-xs')}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium leading-tight">{user.name}</span>
          <span className="block truncate text-xs text-muted-foreground">{user.email}</span>
        </span>
        <ChevronsUpDownIcon size={15} className="shrink-0 text-muted-foreground" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Account"
          className="absolute inset-x-0 top-full z-50 mt-2 overflow-hidden rounded-xl border border-border bg-card p-1 md:top-auto md:bottom-full md:mt-0 md:mb-2"
        >
          <div className="flex items-center gap-2.5 px-2 py-2">
            {avatar('size-9 text-sm')}
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 text-sm font-medium">
                <span className="truncate">{user.name}</span>
                <Badge variant={user.role === 'admin' ? 'default' : 'muted'} className="capitalize">
                  {user.role}
                </Badge>
              </p>
              <p className="truncate text-xs text-muted-foreground" title={user.email}>
                {user.email}
              </p>
            </div>
          </div>
          <div className="my-1 h-px bg-border" />
          <Link
            role="menuitem"
            to="/dashboard/account"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 rounded-md px-2 py-1 text-[13px] text-foreground hover:bg-muted"
          >
            <UserIcon size={15} className="text-muted-foreground" />
            Account settings
          </Link>
          <a
            role="menuitem"
            href="/articles"
            className="flex items-center gap-2 rounded-md px-2 py-1 text-[13px] text-foreground hover:bg-muted"
          >
            <ExternalIcon size={15} className="text-muted-foreground" />
            Open help center
          </a>
          <button
            type="button"
            role="menuitem"
            disabled={signingOut}
            onClick={async () => {
              setSigningOut(true)
              try {
                await onSignOut()
              } finally {
                setSigningOut(false)
              }
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] text-foreground hover:bg-muted disabled:opacity-50"
          >
            <LogOutIcon size={15} className="text-muted-foreground" />
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      )}
    </div>
  )
}
