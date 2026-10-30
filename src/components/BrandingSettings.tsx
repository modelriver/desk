import { useId, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { getRouteApi, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { removeBrandAsset, updateBranding, uploadBrandAsset } from '../functions/branding.ts'
import type { getSettings } from '../functions/settings.ts'
import { ASSET_RULES, LOGO_HEIGHT, type BrandAssetKind } from '../lib/brand-assets.ts'
import { BODY_FONTS, contrast, CORNERS, darkAccents, HEADING_FONTS, LIMITS, lightAccents, pageTitle, RECOMMENDED } from '../lib/branding.ts'
import { cn } from '../lib/cn.ts'
import { errorMessage } from '../lib/errors.ts'
import { HelpBot } from './HelpBot.tsx'
import type { Palette } from '../lib/site-config.ts'
import { BusyIcon } from './BusyIcon.tsx'
import { RelativeTime } from './RelativeTime.tsx'
import { Button, Checkbox, Input, Notice, Section, Select } from './ui.tsx'

// The Appearance and SEO tabs of Settings. Each form saves on its own and
// applies at once: the root loader is re-run so the header, fonts and colours
// update without a reload. A blank field goes back to support.config.json.

export type BrandingData = Awaited<ReturnType<typeof getSettings>>['branding']

type Props = { branding: BrandingData; onChange: (next: BrandingData) => void }

const root = getRouteApi('__root__')

// Saving: the server function, then a refresh of everything that shows the brand.
function useSave(onChange: Props['onChange']) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const run = async (action: () => Promise<BrandingData>, done: string) => {
    setBusy(true)
    setResult(null)
    try {
      onChange(await action())
      await router.invalidate()
      setResult({ ok: true, text: done })
    } catch (err) {
      setResult({ ok: false, text: errorMessage(err, 'Couldn’t save. Please try again.') })
    } finally {
      setBusy(false)
    }
  }
  return { busy, result, run }
}

// --- Appearance ---

export function AppearanceSettings({ branding, onChange }: Props) {
  return (
    <div className="grid gap-5">
      <LogoSection branding={branding} onChange={onChange} />
      <LookSection branding={branding} onChange={onChange} />
    </div>
  )
}

function LogoSection({ branding, onChange }: Props) {
  const { brandName, showName } = root.useLoaderData()
  const save = useServerFn(updateBranding)
  const { busy, result, run } = useSave(onChange)
  const hideName = useId()
  const { logo, light, dark } = branding.current
  const darkFromFile = !branding.logo && Boolean(logo?.dark) && !branding.logoDark

  return (
    <Section title="Logo" description="Shown at the top of every help-center page. Add a dark-mode version if your logo doesn’t show up well on a dark background.">
      <LogoRow
        label="Light mode"
        palette={light}
        src={logo?.light ?? null}
        name={showName ? brandName : null}
        kind="logo"
        asset={branding.logo}
        fallback={branding.defaults.configLogo ? 'Using the logo from support.config.json.' : 'Using the Desk bot.'}
        onChange={onChange}
      />
      <LogoRow
        label="Dark mode"
        palette={dark}
        src={logo ? (logo.dark ?? logo.light) : null}
        name={showName ? brandName : null}
        kind="logo-dark"
        asset={branding.logoDark}
        fallback={!logo ? 'Add a light-mode logo first.' : darkFromFile ? 'Using the dark logo from support.config.json.' : 'Using the light-mode logo.'}
        disabled={!logo && !branding.logoDark}
        onChange={onChange}
      />
      {/* Only with a logo: the Desk bot alone would leave the header nameless. */}
      {logo && (
        <div className="px-5 py-4">
          <label htmlFor={hideName} className="flex cursor-pointer items-start gap-3">
            <Checkbox
              id={hideName}
              checked={!showName}
              disabled={busy}
              className="mt-0.5"
              onChange={(e) => {
                const hide = e.target.checked
                void run(() => save({ data: { showName: !hide } }), hide ? 'The name is hidden.' : 'The name is shown.')
              }}
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium">Hide the name in the header</span>
              <span className="mt-0.5 block text-sm text-muted-foreground">For a logo that already spells out the name. Page titles and the chat still use it.</span>
            </span>
          </label>
          {result && !result.ok && (
            <div className="mt-1.5 pl-7">
              <Notice tone="error">{result.text}</Notice>
            </div>
          )}
        </div>
      )}
    </Section>
  )
}

// One colour scheme's logo: the header as visitors in that scheme see it,
// whatever scheme the admin's own browser is in (its colours are set on the
// preview itself), with upload, replace and remove beside it.
function LogoRow({
  label,
  palette,
  src,
  name,
  kind,
  asset,
  fallback,
  disabled,
  onChange,
}: {
  label: string
  palette: Palette
  src: string | null
  name: string | null
  kind: BrandAssetKind
  asset: Asset
  fallback: string
  disabled?: boolean
  onChange: Props['onChange']
}) {
  return (
    <div>
      <div className="flex flex-wrap items-end gap-4 px-5 pt-4 pb-3">
        <div className="w-full min-w-0 sm:w-auto sm:flex-1">
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">{label}</p>
          <div
            className="flex h-14 min-w-0 items-center gap-2.5 rounded-lg border border-border bg-background px-4 text-base font-semibold tracking-tight text-foreground"
            style={schemeVars(palette)}
          >
            {src ? <img src={src} alt="" style={{ height: LOGO_HEIGHT }} className="w-auto max-w-full shrink-0 object-contain object-left" /> : <HelpBot size={26} animated={false} />}
            {name && <span className="truncate">{name}</span>}
          </div>
        </div>
        <AssetButtons kind={kind} asset={asset} onChange={onChange} disabled={disabled} />
      </div>
      <AssetDetails kind={kind} asset={asset} fallback={fallback} />
    </div>
  )
}

// A colour scheme's tokens as the CSS variables the stylesheet reads.
function schemeVars(palette: Palette): CSSProperties {
  return Object.fromEntries(Object.entries(palette).map(([token, value]) => [`--${token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, value])) as CSSProperties
}

function LookSection({ branding, onChange }: Props) {
  const save = useServerFn(updateBranding)
  const { busy, result, run } = useSave(onChange)
  const saved = branding.saved
  const initial = {
    brandColor: saved.brandColor ?? branding.defaults.brandColor,
    bodyFont: saved.bodyFont ?? 'system',
    headingFont: saved.headingFont ?? 'default',
    corners: saved.corners ?? 'default',
  }
  const [form, setForm] = useState(initial)
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }))
  const hexOk = /^#[0-9a-f]{6}$/i.test(form.brandColor)
  const changed = (Object.keys(form) as Array<keyof typeof form>).some((k) => form[k].toLowerCase() !== initial[k].toLowerCase())
  const customised = Boolean(saved.brandColor || saved.bodyFont || saved.headingFont || saved.corners)
  const preview = hexOk ? previewVars(form.brandColor) : null
  const radius = CORNERS.find((c) => c.id === form.corners)?.radius

  const submit = () =>
    run(
      () =>
        save({
          data: {
            // The theme's own colour isn't saved as an override, so a later change to support.config.json still shows.
            brandColor: form.brandColor.toLowerCase() === branding.defaults.brandColor.toLowerCase() ? '' : form.brandColor,
            bodyFont: form.bodyFont === 'system' ? '' : form.bodyFont,
            headingFont: form.headingFont === 'default' ? '' : form.headingFont,
            corners: form.corners === 'default' ? '' : form.corners,
          },
        }),
      'Saved. Visitors see it on their next page.',
    )

  const reset = () =>
    run(async () => {
      const next = await save({ data: { brandColor: '', bodyFont: '', headingFont: '', corners: '' } })
      setForm({ brandColor: next.defaults.brandColor, bodyFont: 'system', headingFont: 'default', corners: 'default' })
      return next
    }, 'Back to the defaults.')

  return (
    <Section title="Colour and type" description="One brand colour for buttons, links and highlights in light and dark mode, and the fonts for text and headings.">
      <Field label="Brand colour" htmlFor="brand-color">
        <div className="flex items-center gap-2">
          <input
            type="color"
            aria-label="Pick a brand colour"
            value={hexOk ? form.brandColor : '#000000'}
            onChange={(e) => set('brandColor', e.target.value)}
            className="h-8 w-10 shrink-0 cursor-pointer rounded-md border border-input bg-card p-0.5"
          />
          <span className="w-28 shrink-0">
            <Input id="brand-color" value={form.brandColor} onChange={(e) => set('brandColor', e.target.value.trim())} maxLength={7} spellCheck={false} className="font-mono" />
          </span>
          {preview && (
            // Light and dark accents as variables, so the sample matches the dashboard's own scheme.
            <span className="ml-1 hidden items-center gap-2 sm:flex" aria-hidden="true" style={preview}>
              <span
                className="inline-flex h-7 items-center bg-(--lp) px-2.5 text-xs font-medium text-(--lpf) dark:bg-(--dp) dark:text-(--dpf)"
                style={{ borderRadius: radius }}
              >
                Button
              </span>
              <span className="inline-flex h-6 items-center rounded-full bg-(--la) px-2 text-xs font-medium text-(--laf) dark:bg-(--da) dark:text-(--daf)">
                Highlight
              </span>
            </span>
          )}
        </div>
        {!hexOk && <p className="text-xs text-destructive">Use a hex colour like #238a92.</p>}
        {hexOk && contrast(form.brandColor, '#ffffff') < 3 && (
          <p className="text-xs text-muted-foreground">This colour is light, so links in it can be hard to read on white. A darker shade works better.</p>
        )}
      </Field>
      <Field label="Body text" htmlFor="body-font" hint="Fonts other than the system’s load from Google Fonts.">
        <Select id="body-font" value={form.bodyFont} onChange={(e) => set('bodyFont', e.target.value)} className="sm:w-64">
          {BODY_FONTS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Headings" htmlFor="heading-font">
        <Select id="heading-font" value={form.headingFont} onChange={(e) => set('headingFont', e.target.value)} className="sm:w-64">
          {HEADING_FONTS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Corners" htmlFor="corners">
        <Select id="corners" value={form.corners} onChange={(e) => set('corners', e.target.value as typeof form.corners)} className="sm:w-64">
          {CORNERS.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </Select>
      </Field>
      <Actions busy={busy} result={result} canSave={changed && hexOk} onSave={() => void submit()} onReset={customised ? () => void reset() : undefined} />
    </Section>
  )
}

function previewVars(hex: string): CSSProperties {
  const light = lightAccents(hex)
  const dark = darkAccents(hex)
  return {
    '--lp': light.primary,
    '--lpf': light.primaryForeground,
    '--la': light.accent,
    '--laf': light.accentForeground,
    '--dp': dark.primary,
    '--dpf': dark.primaryForeground,
    '--da': dark.accent,
    '--daf': dark.accentForeground,
  } as CSSProperties
}

// --- SEO ---

export function SeoSettings({ branding, onChange }: Props) {
  return (
    <div className="grid gap-5">
      <SearchSection branding={branding} onChange={onChange} />
      <FaviconSection branding={branding} onChange={onChange} />
    </div>
  )
}

function SearchSection({ branding, onChange }: Props) {
  const save = useServerFn(updateBranding)
  const { busy, result, run } = useSave(onChange)
  const saved = branding.saved
  const initial = { name: saved.name ?? '', homeTitle: saved.homeTitle ?? '', description: saved.description ?? '' }
  const [form, setForm] = useState(initial)
  const set = (key: keyof typeof form, value: string) => setForm((f) => ({ ...f, [key]: value }))
  const changed = (Object.keys(form) as Array<keyof typeof form>).some((k) => form[k].trim() !== initial[k])

  // What applies when a field is left blank.
  const name = form.name.trim() || branding.defaults.name
  const homeTitle = form.homeTitle.trim() || name
  const description =
    form.description.trim() ||
    `Guides and answers from ${name}. Search the help articles by topic, or ask the assistant and reach our team when you need a person.`

  const submit = () => run(() => save({ data: form }), 'Saved. Search engines pick it up on their next visit.')
  const reset = () =>
    run(async () => {
      const next = await save({ data: { name: '', homeTitle: '', description: '' } })
      setForm({ name: '', homeTitle: '', description: '' })
      return next
    }, 'Back to the defaults.')

  return (
    <Section title="Search results" description="How the help center is named in browser tabs, search results and shared links.">
      <Field label="Name" htmlFor="seo-name" hint={`Shown in the header and added to every page’s title, like “${pageTitle('Billing', name)}”.`}>
        <Input id="seo-name" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder={branding.defaults.name} maxLength={LIMITS.name} className="sm:max-w-md" />
      </Field>
      <Field label="Home page title" htmlFor="seo-title" hint="The home page’s title on its own, without the name added.">
        <Input id="seo-title" value={form.homeTitle} onChange={(e) => set('homeTitle', e.target.value)} placeholder={name} maxLength={LIMITS.homeTitle} />
        <Counter length={homeTitle.length} recommended={RECOMMENDED.title} />
      </Field>
      <Field label="Description" htmlFor="seo-description" hint="The home page’s summary in search results, and for pages without their own.">
        <textarea
          id="seo-description"
          value={form.description}
          onChange={(e) => set('description', e.target.value)}
          placeholder={description}
          maxLength={LIMITS.description}
          rows={3}
          className="w-full resize-y rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring"
        />
        <Counter length={description.length} recommended={RECOMMENDED.description} />
      </Field>
      <div className="border-b border-border px-5 py-4">
        <p className="mb-2 text-xs font-medium text-muted-foreground">Preview</p>
        <SearchPreview url={branding.appUrl} title={homeTitle} description={description} />
      </div>
      <Actions
        busy={busy}
        result={result}
        canSave={changed}
        onSave={() => void submit()}
        onReset={saved.name || saved.homeTitle || saved.description ? () => void reset() : undefined}
      />
    </Section>
  )
}

// A search result, roughly as Google lays it out.
function SearchPreview({ url, title, description }: { url: string; title: string; description: string }) {
  const host = url ? url.replace(/^https?:\/\//, '').replace(/\/$/, '') : 'your-help-center.com'
  const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)
  return (
    <div className="max-w-xl rounded-lg border border-border bg-background px-4 py-3">
      <p className="truncate text-xs text-muted-foreground">{host}</p>
      <p className="mt-0.5 truncate text-[17px] leading-snug text-[#1a0dab] dark:text-[#8ab4f8]">{cut(title, RECOMMENDED.title)}</p>
      <p className="mt-1 line-clamp-2 text-[13px] leading-snug text-muted-foreground">{cut(description, RECOMMENDED.description)}</p>
    </div>
  )
}

function FaviconSection({ branding, onChange }: Props) {
  const { favicon } = root.useLoaderData()
  const href = favicon?.href ?? '/favicon.svg'
  return (
    <Section title="Favicon" description="The small icon in browser tabs, bookmarks and some search results.">
      <div className="flex flex-wrap items-center gap-4 border-b border-border px-5 py-4">
        <div className="flex min-w-0 flex-1 items-center gap-4">
          <span className="grid size-14 shrink-0 place-items-center rounded-lg border border-border bg-background">
            <img src={href} alt="" className="size-8" />
          </span>
          <span className="flex h-8 min-w-0 items-center gap-2 rounded-t-lg border border-b-0 border-border bg-background px-3 text-xs" aria-hidden="true">
            <img src={href} alt="" className="size-4 shrink-0" />
            <span className="truncate">{branding.name}</span>
          </span>
        </div>
        <AssetButtons kind="favicon" asset={branding.favicon} onChange={onChange} />
      </div>
      <AssetDetails kind="favicon" asset={branding.favicon} fallback={branding.logo || branding.defaults.configLogo ? 'Using your logo.' : 'Using the Desk bot.'} />
      <Row label="This site’s address" hint="Used for canonical links, the sitemap and structured data. Set APP_URL on the server.">
        {branding.appUrl ? <span className="font-mono text-xs">{branding.appUrl}</span> : <span className="text-destructive">Not set</span>}
      </Row>
    </Section>
  )
}

// --- Shared pieces ---

type Asset = BrandingData['logo']

function AssetButtons({ kind, asset, onChange, disabled }: { kind: BrandAssetKind; asset: Asset; onChange: Props['onChange']; disabled?: boolean }) {
  const upload = useServerFn(uploadBrandAsset)
  const remove = useServerFn(removeBrandAsset)
  const { busy, result, run } = useSave(onChange)
  const input = useRef<HTMLInputElement>(null)

  const pick = (file: File | undefined) => {
    if (!file) return
    const form = new FormData()
    form.set('kind', kind)
    form.set('file', file)
    void run(() => upload({ data: form }), 'Uploaded.')
    if (input.current) input.current.value = ''
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-2">
        {asset && (
          <Button variant="ghost-destructive" size="sm" disabled={busy} onClick={() => void run(() => remove({ data: { kind } }), 'Removed.')}>
            Remove
          </Button>
        )}
        <Button variant="outline" size="sm" disabled={busy || disabled} onClick={() => input.current?.click()}>
          <BusyIcon busy={busy} size={14} />
          {asset ? 'Replace' : 'Upload'}
        </Button>
        <input ref={input} type="file" accept=".svg,.png,image/svg+xml,image/png" className="hidden" onChange={(e) => pick(e.target.files?.[0])} />
      </div>
      {result && !result.ok && (
        <p role="alert" className="max-w-64 text-right text-xs text-destructive">
          {result.text}
        </p>
      )}
    </div>
  )
}

function AssetDetails({ kind, asset, fallback }: { kind: BrandAssetKind; asset: Asset; fallback: string }) {
  return (
    <div className="border-b border-border px-5 py-3 text-xs text-muted-foreground">
      {asset ? (
        <p>
          {asset.type === 'image/svg+xml' ? 'SVG' : `PNG, ${asset.width} × ${asset.height} px`}, uploaded
          {asset.updatedBy && ` by ${asset.updatedBy}`} <RelativeTime iso={asset.updatedAt} />.
        </p>
      ) : (
        <p>{fallback}</p>
      )}
      <p className="mt-0.5">{ASSET_RULES[kind].hint}</p>
    </div>
  )
}

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5 border-b border-border px-5 py-4 sm:grid-cols-[11rem_1fr] sm:gap-6">
      <div className="min-w-0">
        <label htmlFor={htmlFor} className="text-sm font-medium">
          {label}
        </label>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
      <div className="grid min-w-0 gap-1.5">{children}</div>
    </div>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-1 px-5 py-3 text-sm">
      <div className="min-w-0">
        <p>{label}</p>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
      <div className="min-w-0 text-right [overflow-wrap:anywhere]">{children}</div>
    </div>
  )
}

// "54 of about 60": muted until it runs past what search engines show.
function Counter({ length, recommended }: { length: number; recommended: number }) {
  return (
    <p className={cn('text-xs', length > recommended ? 'text-destructive' : 'text-muted-foreground')}>
      {length} characters{length > recommended ? `; search engines show about ${recommended}` : ''}
    </p>
  )
}

function Actions({
  busy,
  result,
  canSave,
  onSave,
  onReset,
}: {
  busy: boolean
  result: { ok: boolean; text: string } | null
  canSave: boolean
  onSave: () => void
  onReset?: () => void
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-3 px-5 py-3">
      {result && (
        <span className="mr-auto">
          <Notice tone={result.ok ? 'success' : 'error'}>{result.text}</Notice>
        </span>
      )}
      {onReset && (
        <Button variant="ghost" size="sm" disabled={busy} onClick={onReset}>
          Reset to defaults
        </Button>
      )}
      <Button size="sm" disabled={busy || !canSave} onClick={onSave}>
        <BusyIcon busy={busy} size={14} />
        Save
      </Button>
    </div>
  )
}
