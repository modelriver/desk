import type { ComponentProps, HTMLAttributes, LabelHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react'
import { cn } from '../lib/cn.ts'

// Small set of shadcn-style primitives, written in-house to keep the
// dependency list short. Variants are plain class maps.

const buttonBase =
  'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap font-medium ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 cursor-pointer'

const buttonVariants = {
  default: 'bg-primary text-primary-foreground hover:bg-primary-hover',
  secondary: 'bg-muted text-foreground hover:bg-border/70',
  outline: 'border border-input bg-card text-foreground hover:bg-muted',
  ghost: 'text-foreground hover:bg-muted',
  destructive: 'text-destructive hover:bg-destructive/10',
  // A confirmed removal: the one solid red button, in a confirmation's footer.
  danger: 'bg-destructive text-white hover:bg-destructive/90',
  // Quiet until hovered, then red: for close/remove buttons on list rows.
  // Stays red while its confirmation is open (aria-expanded).
  'ghost-destructive':
    'text-muted-foreground hover:bg-destructive/10 hover:text-destructive aria-expanded:bg-destructive/10 aria-expanded:text-destructive',
  link: 'text-primary underline-offset-4 hover:underline px-0 h-auto',
} as const

// One compact scale for every button in the dashboard and the help center:
// 28px small, 32px default, 36px large. Text size comes with the size.
const buttonSizes = {
  sm: 'h-7 px-2.5 text-xs',
  default: 'h-8 px-3 text-[13px]',
  lg: 'h-9 px-4 text-sm',
  icon: 'size-8 text-[13px]',
  'icon-sm': 'size-7 text-[13px]',
  // No height or padding: the caller sets them.
  none: 'text-sm',
} as const

// ComponentProps includes ref, which React 19 passes through as a normal prop.
export type ButtonProps = ComponentProps<'button'> & {
  variant?: keyof typeof buttonVariants
  size?: keyof typeof buttonSizes
}

// For links styled as buttons (a <button> inside a link is invalid HTML).
export function buttonClass(variant: keyof typeof buttonVariants = 'default', size: keyof typeof buttonSizes = 'default', className?: string) {
  // cn() doesn't merge conflicting utilities, so the default radius steps
  // aside when the caller sets its own.
  const radius = /(^|\s)rounded(-|\s|$)/.test(className ?? '') ? '' : 'rounded-md'
  return cn(buttonBase, radius, buttonVariants[variant], buttonSizes[size], className)
}

export function Button({ variant = 'default', size = 'default', className, type = 'button', ...props }: ButtonProps) {
  return <button type={type} className={buttonClass(variant, size, className)} {...props} />
}

// 16 px text on phones: iOS Safari zooms into a field with smaller text on
// focus and doesn't zoom back out. 14 px from the sm breakpoint up.
const field =
  'w-full rounded-md border border-input bg-card px-3 text-base text-foreground placeholder:text-muted-foreground sm:text-sm ' +
  'focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring disabled:opacity-50'

// ComponentProps includes ref, which React 19 passes through as a normal prop.
export function Input({ className, ...props }: ComponentProps<'input'>) {
  const height = /(^|\s)h-/.test(className ?? '') ? '' : 'h-8'
  return <input className={cn(field, height, className)} {...props} />
}

// The same look and focus ring as Input, for text on several lines.
export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn(field, 'block py-2 leading-relaxed', className)} {...props} />
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(field, 'h-8 appearance-none bg-no-repeat pr-8', className)} style={{ backgroundImage: CHEVRON, backgroundPosition: 'right 0.6rem center', backgroundSize: '14px' }} {...props}>
      {children}
    </select>
  )
}

const CHEVRON =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")"

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('grid gap-1.5 text-sm font-medium', className)} {...props} />
}

const badgeVariants = {
  default: 'bg-accent text-accent-foreground',
  muted: 'bg-muted text-muted-foreground',
  outline: 'border border-border text-muted-foreground',
  success: 'bg-success/12 text-success',
  // Needs someone's attention now, such as a visitor waiting for a person.
  priority: 'bg-primary text-primary-foreground',
  // Something is wrong or off, such as a broken connection.
  danger: 'bg-destructive/10 text-destructive',
} as const

export function Badge({
  variant = 'default',
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { variant?: keyof typeof badgeVariants }) {
  return (
    <span
      className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap', badgeVariants[variant], className)}
      {...props}
    />
  )
}

// An on/off switch. Label it with aria-labelledby (or aria-label).
export function Switch({
  checked,
  onChange,
  className,
  ...props
}: Omit<ComponentProps<'button'>, 'onChange'> & { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent disabled:opacity-50',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        checked ? 'bg-primary' : 'bg-input',
        className,
      )}
      {...props}
    >
      <span className={cn('block size-4 rounded-full bg-background', checked ? 'translate-x-4' : 'translate-x-0.5')} />
    </button>
  )
}

// A checkbox in the theme's colours. The real input stays (keyboard, forms,
// screen readers) with the browser's look turned off; the tick is drawn over
// it and shows the moment it's checked. Put it in a <label> with its text.
// `indeterminate` shows a dash for "some of these" (a folder with some files selected).
export function Checkbox({ className, indeterminate = false, ...props }: Omit<ComponentProps<'input'>, 'type'> & { indeterminate?: boolean }) {
  return (
    <span className={cn('inline-grid size-4 shrink-0 place-items-center', className)}>
      <input
        type="checkbox"
        ref={(el) => {
          if (el) el.indeterminate = indeterminate
        }}
        className={cn(
          'peer col-start-1 row-start-1 size-4 cursor-pointer appearance-none rounded-[5px] border border-input bg-card',
          'enabled:not-checked:hover:border-muted-foreground checked:border-primary checked:bg-primary indeterminate:border-primary indeterminate:bg-primary',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          'disabled:cursor-default disabled:opacity-50',
        )}
        {...props}
      />
      {indeterminate && (
        <svg viewBox="0 0 16 16" aria-hidden="true" className="pointer-events-none col-start-1 row-start-1 size-3 text-primary-foreground" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
          <path d="M4 8h8" />
        </svg>
      )}
      <svg
        viewBox="0 0 16 16"
        aria-hidden="true"
        className="pointer-events-none col-start-1 row-start-1 size-3 text-primary-foreground opacity-0 peer-checked:opacity-100 peer-disabled:opacity-0 peer-disabled:peer-checked:opacity-50"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
      </svg>
    </span>
  )
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-xl border border-border bg-card', className)} {...props} />
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 max-w-prose text-sm text-muted-foreground">{description}</p>}
      </div>
      {/* Beside the title on wider screens, however long the description. */}
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

export function Notice({ tone, children }: { tone: 'error' | 'success'; children: ReactNode }) {
  return (
    <p role={tone === 'error' ? 'alert' : 'status'} className={cn('text-[13px]', tone === 'error' ? 'text-destructive' : 'text-success')}>
      {children}
    </p>
  )
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-border px-6 py-12 text-center">
      <div className="mb-3 grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">{icon}</div>
      <p className="font-medium">{title}</p>
      {children && <div className="mt-1 max-w-sm text-sm text-muted-foreground">{children}</div>}
    </div>
  )
}

// A titled settings group: heading, optional description, and its rows in a card.
export function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="text-sm font-semibold">{title}</h2>
      {description && <p className="mt-0.5 max-w-prose text-[13px] text-muted-foreground">{description}</p>}
      <Card className="mt-2 overflow-hidden">{children}</Card>
    </section>
  )
}
