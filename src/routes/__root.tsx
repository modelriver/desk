/// <reference types="vite/client" />
import type { ReactNode } from 'react'
import { createRootRoute, HeadContent, Link, Outlet, Scripts, useRouterState } from '@tanstack/react-router'
import { ChatWidget } from '../components/ChatWidget.tsx'
import { BrandMark } from '../components/BrandMark.tsx'
import { HeaderSearch } from '../components/HeaderSearch.tsx'
import { buttonClass } from '../components/ui.tsx'
import { getSiteConfig } from '../functions/help.ts'
import appCss from '../styles.css?url'

export const Route = createRootRoute({
  loader: () => getSiteConfig(),
  head: ({ loaderData }) => {
    const fontLinks = (loaderData?.fontStylesheets ?? []).flatMap((href) => [
      { rel: 'preconnect', href: new URL(href).origin, crossOrigin: 'anonymous' as const },
      { rel: 'stylesheet', href },
    ])
    return {
      meta: [
        { charSet: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { title: loaderData?.brandName ?? 'Help Center' },
        { name: 'description', content: 'Guides, answers and support.' },
      ],
      links: [...fontLinks, { rel: 'stylesheet', href: appCss }],
      // Theme variables from support.config.json; rendered after the stylesheet so they apply.
      styles: loaderData ? [{ children: loaderData.themeCss }] : [],
    }
  },
  shellComponent: RootDocument,
  component: RootLayout,
  notFoundComponent: NotFound,
})

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}

function RootLayout() {
  const { repoUrl, brandName, logo } = Route.useLoaderData()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  // The dashboard, sign-in and the embeddable /widget page have their own chrome.
  const publicPage = !pathname.startsWith('/dashboard') && pathname !== '/login' && pathname !== '/widget'
  if (!publicPage) return <Outlet />
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-6 px-4 sm:px-6">
          <Link to="/" className="flex items-center gap-2.5 font-semibold tracking-tight">
            <BrandMark logo={logo} size={26} />
            {brandName}
          </Link>
          <nav className="ml-auto flex items-center gap-2 text-sm">
            {/* /help has its own, larger search box; ⌘K still works there. */}
            <HeaderSearch box={pathname !== '/help'} />
            <Link
              to="/help"
              className="rounded-md px-3 py-1.5 text-muted-foreground hover:text-foreground"
              activeProps={{ className: 'text-foreground' }}
            >
              Articles
            </Link>
            {/* No sign-in link for visitors; the team signs in at /login (or /dashboard). */}
          </nav>
        </div>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2 px-4 py-6 text-xs text-muted-foreground sm:px-6">
          <span>{brandName}</span>
          <a href={repoUrl} target="_blank" rel="noopener noreferrer" className="hover:text-foreground">
            Open source, built on ModelRiver
          </a>
        </div>
      </footer>
      <ChatWidget repoUrl={repoUrl} brandName={brandName} logo={logo} />
    </div>
  )
}

function NotFound() {
  return (
    <div className="mx-auto max-w-xl px-4 py-24 text-center">
      <p className="font-serif text-3xl">This page doesn’t exist</p>
      <p className="mt-3 text-muted-foreground">It may have moved, or the link may be wrong.</p>
      <div className="mt-6 flex justify-center gap-2">
        <Link to="/help" className={buttonClass('outline')}>
          Browse articles
        </Link>
      </div>
    </div>
  )
}
