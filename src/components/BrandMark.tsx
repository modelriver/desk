import type { Logo } from '../lib/site-config.ts'
import { cn } from '../lib/cn.ts'
import { HelpBot } from './HelpBot.tsx'

// The logo from support.config.json (brand.logo / brand.logoDark), or the
// help bot when none is set. Shown with <img>, so scripts inside an SVG
// never run. `alt` is empty where the brand name is written right beside it.
export function BrandMark({ logo, size, alt = '' }: { logo: Logo; size: number; alt?: string }) {
  // Still in the header and sidebar: motion there would distract.
  if (!logo) return <HelpBot size={size} animated={false} label={alt || undefined} />
  const style = { height: size }
  return (
    <>
      <img src={logo.light} alt={alt} style={style} className={cn('w-auto max-w-40 shrink-0', logo.dark && 'dark:hidden')} />
      {logo.dark && <img src={logo.dark} alt={alt} style={style} className="hidden w-auto max-w-40 shrink-0 dark:block" />}
    </>
  )
}
