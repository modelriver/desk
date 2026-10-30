import type { CSSProperties } from 'react'
import type { Logo } from '../lib/site-config.ts'
import { cn } from '../lib/cn.ts'
import { HelpBot } from './HelpBot.tsx'

// The logo from support.config.json (brand.logo / brand.logoDark), or the
// help bot when none is set. Shown with <img>, so scripts inside an SVG
// never run. `alt` is empty where the brand name is written right beside it.
// `logoHeight` sets a logo's height where it differs from the bot's `size`,
// and `phoneLogoHeight` below the `sm` breakpoint. The width follows the
// logo's own shape; it only shrinks (without stretching) when the space runs
// out, on a narrow phone.
export function BrandMark({
  logo,
  size,
  alt = '',
  logoHeight = size,
  phoneLogoHeight = logoHeight,
}: {
  logo: Logo
  size: number
  alt?: string
  logoHeight?: number
  phoneLogoHeight?: number
}) {
  // Still in the header and sidebar: motion there would distract.
  if (!logo) return <HelpBot size={size} animated={false} label={alt || undefined} />
  const style = { '--logo-h': `${logoHeight}px`, '--logo-h-phone': `${phoneLogoHeight}px` } as CSSProperties
  const sized = 'h-(--logo-h-phone) w-auto max-w-[70vw] shrink-0 object-contain object-left sm:h-(--logo-h)'
  return (
    <>
      <img src={logo.light} alt={alt} style={style} className={cn(sized, logo.dark && 'dark:hidden')} />
      {logo.dark && <img src={logo.dark} alt={alt} style={style} className={cn(sized, 'hidden dark:block')} />}
    </>
  )
}
