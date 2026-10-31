import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { getRouteApi, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { removeBrandAsset, updateBranding, uploadBrandAsset } from '../functions/branding.ts'
import type { getSettings } from '../functions/settings.ts'
import { ASSET_RULES, BrandAssetError, checkBrandImage, LOGO_HEIGHT, type BrandAssetKind } from '../lib/brand-assets.ts'
import { BODY_FONTS, contrast, CORNERS, darkAccents, googleFontUrl, HEADING_FONTS, HOME_DEFAULTS, LIMITS, lightAccents, pageTitle, RECOMMENDED } from '../lib/branding.ts'
import { cn } from '../lib/cn.ts'
import { errorMessage } from '../lib/errors.ts'
import { HelpBot } from './HelpBot.tsx'
import { resolveLogo, type Palette } from '../lib/site-config.ts'
import { BusyIcon } from './BusyIcon.tsx'
import { RelativeTime } from './RelativeTime.tsx'
import { Button, Checkbox, Input, Notice, Section, Select } from './ui.tsx'

// The Appearance and SEO tabs of Settings. Each form saves on its own and
// applies at once: the root loader is re-run so the header, fonts and colours
// update without a reload. A blank field goes back to support.config.json.
// Images are previewed when picked and only uploaded on Save.

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
      <HomeSection branding={branding} onChange={onChange} />
    </div>
  )
}

// The home page's hero: its heading, the line under it, and the example in
// the question box. Blank keeps Desk's own words (HOME_DEFAULTS).
function HomeSection({ branding, onChange }: Props) {
  const save = useServerFn(updateBranding)
  const { busy, result, run } = useSave(onChange)
  const saved = branding.saved
  const initial = { homeHeading: saved.homeHeading ?? '', homeIntro: saved.homeIntro ?? '', askExample: saved.askExample ?? '' }
  const [form, setForm] = useState(initial)
  const set = (key: keyof typeof form, value: string) => setForm((f) => ({ ...f, [key]: value }))
  const changed = (Object.keys(form) as Array<keyof typeof form>).some((k) => form[k].trim() !== initial[k])
  const blank = { homeHeading: '', homeIntro: '', askExample: '' }

  return (
    <Section title="Home page" description="The words at the top of the help center’s home page. Leave a field blank to keep Desk’s own.">
      <Field label="Heading" htmlFor="home-heading">
        <Input id="home-heading" value={form.homeHeading} onChange={(e) => set('homeHeading', e.target.value)} placeholder={HOME_DEFAULTS.heading} maxLength={LIMITS.homeHeading} className="sm:max-w-md" />
      </Field>
      <Field label="Line under it" htmlFor="home-intro" hint="Shown while the chat is on. When it’s paused, the page points to the articles instead.">
        <textarea
          id="home-intro"
          value={form.homeIntro}
          onChange={(e) => set('homeIntro', e.target.value)}
          placeholder={HOME_DEFAULTS.intro}
          maxLength={LIMITS.homeIntro}
          rows={3}
          className="w-full resize-y rounded-md border border-input bg-card px-3 py-2 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring sm:text-sm"
        />
      </Field>
      <Field label="Example question" htmlFor="ask-example" hint="Shown in the question box before visitors type. A question your visitors really ask works best.">
        <Input id="ask-example" value={form.askExample} onChange={(e) => set('askExample', e.target.value)} placeholder={HOME_DEFAULTS.example} maxLength={LIMITS.askExample} />
      </Field>
      <Actions
        busy={busy}
        result={result}
        canSave={changed}
        onSave={() => void run(() => save({ data: form }), 'Saved. Visitors see it on their next page.')}
        canReset={Boolean(saved.homeHeading || saved.homeIntro || saved.askExample) || Object.values(form).some((v) => v.trim())}
        onReset={() =>
          saved.homeHeading || saved.homeIntro || saved.askExample
            ? void run(async () => {
                const next = await save({ data: blank })
                setForm(blank)
                return next
              }, 'Back to the defaults.')
            : setForm(blank)
        }
      />
    </Section>
  )
}

// Both logos and "Hide the name" are changed here and saved together: a
// picked image is previewed in the header as visitors would see it, and only
// uploaded on Save.
function LogoSection({ branding, onChange }: Props) {
  const { brandName } = root.useLoaderData()
  const save = useServerFn(updateBranding)
  const upload = useServerFn(uploadBrandAsset)
  const remove = useServerFn(removeBrandAsset)
  const router = useRouter()
  const { busy, result, run } = useSave(onChange)
  const hideName = useId()
  const lightLogo = usePendingImage('logo')
  const darkLogo = usePendingImage('logo-dark')
  const savedHide = branding.saved.showName === false
  const [hide, setHide] = useState(savedHide)
  const { light, dark } = branding.current
  const fromFile = branding.defaults.fileLogo

  // The header with these changes saved (as the server resolves it).
  const logo = resolveLogo(lightLogo.showing(branding.logo?.url ?? null), darkLogo.showing(branding.logoDark?.url ?? null), fromFile)
  const showName = !hide || logo === null
  const darkFromFile = !lightLogo.showing(branding.logo?.url ?? null) && Boolean(fromFile?.dark) && !darkLogo.showing(branding.logoDark?.url ?? null)
  const changed = lightLogo.pending !== null || darkLogo.pending !== null || (logo !== null && hide !== savedHide)

  const discard = () => {
    lightLogo.clear()
    darkLogo.clear()
    setHide(savedHide)
  }

  const submit = () =>
    run(async () => {
      let latest: BrandingData | null = null
      try {
        // The light logo first: a dark one pairs with it.
        for (const [kind, image] of [['logo', lightLogo], ['logo-dark', darkLogo]] as const) {
          if (image.pending === 'remove') latest = await remove({ data: { kind } })
          else if (image.pending) {
            const form = new FormData()
            form.set('kind', kind)
            form.set('file', image.pending.file)
            latest = await upload({ data: form })
          }
          image.clear()
        }
        if (logo !== null && hide !== savedHide) latest = await save({ data: { showName: !hide } })
      } catch (err) {
        // Whatever was saved before the failure still shows.
        if (latest) {
          onChange(latest)
          await router.invalidate()
        }
        throw err
      }
      return latest ?? branding
    }, 'Saved. Visitors see it on their next page.')

  return (
    <Section title="Logo" description="Shown at the top of every help-center page. Add a dark-mode version if your logo doesn’t show up well on a dark background.">
      <LogoRow
        label="Light mode"
        palette={light}
        src={logo?.light ?? null}
        name={showName ? brandName : null}
        kind="logo"
        asset={branding.logo}
        image={lightLogo}
        busy={busy}
        fallback={fromFile ? 'Using the logo from support.config.json.' : 'Using the Desk bot.'}
      />
      <LogoRow
        label="Dark mode"
        palette={dark}
        src={logo ? (logo.dark ?? logo.light) : null}
        name={showName ? brandName : null}
        kind="logo-dark"
        asset={branding.logoDark}
        image={darkLogo}
        busy={busy}
        fallback={!logo ? 'Add a light-mode logo first.' : darkFromFile ? 'Using the dark logo from support.config.json.' : 'Using the light-mode logo.'}
        disabled={!logo && !darkLogo.showing(branding.logoDark?.url ?? null)}
      />
      {/* Only with a logo: the Desk bot alone would leave the header nameless. */}
      {logo && (
        <div className="border-b border-border px-5 py-4">
          <label htmlFor={hideName} className="flex cursor-pointer items-start gap-3">
            <Checkbox id={hideName} checked={hide} disabled={busy} className="mt-0.5" onChange={(e) => setHide(e.target.checked)} />
            <span className="min-w-0">
              <span className="block text-sm font-medium">Hide the name in the header</span>
              <span className="mt-0.5 block text-sm text-muted-foreground">For a logo that already spells out the name. Page titles and the chat still use it.</span>
            </span>
          </label>
        </div>
      )}
      <Actions busy={busy} result={result} canSave={changed} onSave={() => void submit()} onDiscard={changed ? discard : undefined} />
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
  image,
  busy,
  fallback,
  disabled,
}: {
  label: string
  palette: Palette
  src: string | null
  name: string | null
  kind: BrandAssetKind
  asset: Asset
  image: PendingImage
  busy: boolean
  fallback: string
  disabled?: boolean
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
        <ImagePicker image={image} saved={asset !== null} busy={busy} disabled={disabled} />
      </div>
      <AssetDetails kind={kind} asset={asset} image={image} fallback={fallback} />
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
  const fonts = useFontPreview(form.bodyFont, form.headingFont, branding.defaults.fonts)

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
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <Select id="body-font" value={form.bodyFont} onChange={(e) => set('bodyFont', e.target.value)} className="sm:w-64">
            {BODY_FONTS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </Select>
          <FontSample family={fonts.body} className="text-sm">
            Ask in your own words.
          </FontSample>
        </div>
      </Field>
      <Field label="Headings" htmlFor="heading-font">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <Select id="heading-font" value={form.headingFont} onChange={(e) => set('headingFont', e.target.value)} className="sm:w-64">
            {HEADING_FONTS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </Select>
          <FontSample family={fonts.heading} className="text-xl leading-tight">
            How can we help?
          </FontSample>
        </div>
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
      <Actions
        busy={busy}
        result={result}
        canSave={changed && hexOk}
        onSave={() => void submit()}
        canReset={customised || changed}
        onReset={() => (customised ? void reset() : setForm(initial))}
      />
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
        canReset={Boolean(saved.name || saved.homeTitle || saved.description)}
        onReset={() => void reset()}
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

// A picked favicon shows in the previews, as a tab and on its own, and is
// only uploaded on Save.
function FaviconSection({ branding, onChange }: Props) {
  const { favicon } = root.useLoaderData()
  const upload = useServerFn(uploadBrandAsset)
  const remove = useServerFn(removeBrandAsset)
  const { busy, result, run } = useSave(onChange)
  const image = usePendingImage('favicon')
  // Without one, the tab uses the logo, else the Desk bot (see getSiteConfig).
  const fallback = branding.logo?.url ?? branding.defaults.fileLogo?.light ?? '/favicon.svg'
  const href = image.pending === 'remove' ? fallback : image.pending ? image.pending.url : (favicon?.href ?? '/favicon.svg')

  const submit = () =>
    run(async () => {
      const pending = image.pending
      if (!pending) return branding
      let next: BrandingData
      if (pending === 'remove') next = await remove({ data: { kind: 'favicon' } })
      else {
        const form = new FormData()
        form.set('kind', 'favicon')
        form.set('file', pending.file)
        next = await upload({ data: form })
      }
      image.clear()
      return next
    }, 'Saved. Browsers show it on the next page they load.')

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
        <ImagePicker image={image} saved={branding.favicon !== null} busy={busy} />
      </div>
      <AssetDetails kind="favicon" asset={branding.favicon} image={image} fallback={branding.logo || branding.defaults.configLogo ? 'Using your logo.' : 'Using the Desk bot.'} />
      <Actions busy={busy} result={result} canSave={image.pending !== null} onSave={() => void submit()} onDiscard={image.pending ? image.clear : undefined} />
      <Row label="This site’s address" hint="Used for canonical links, the sitemap and structured data. Set APP_URL on the server.">
        {branding.appUrl ? <span className="font-mono text-xs">{branding.appUrl}</span> : <span className="text-destructive">Not set</span>}
      </Row>
    </Section>
  )
}

// --- Shared pieces ---

type Asset = BrandingData['logo']

// A picked image (shown at once from the browser's own copy) or a removal,
// waiting for Save. It's checked as the server would check it, so a file the
// server would refuse never looks ready to save.
type PendingImage = ReturnType<typeof usePendingImage>

function usePendingImage(kind: BrandAssetKind) {
  const [pending, setPending] = useState<{ file: File; url: string } | 'remove' | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The preview's object URL is let go when it's replaced, saved or dropped.
  useEffect(() => () => {
    if (pending && pending !== 'remove') URL.revokeObjectURL(pending.url)
  }, [pending])

  const pick = async (file: File) => {
    setError(null)
    try {
      checkBrandImage(kind, new Uint8Array(await file.arrayBuffer()))
    } catch (err) {
      setError(err instanceof BrandAssetError ? err.message : 'Couldn’t read that file.')
      return
    }
    setPending({ file, url: URL.createObjectURL(file) })
  }
  const clear = () => {
    setPending(null)
    setError(null)
  }
  return {
    kind,
    pending,
    error,
    pick,
    clear,
    // With one saved, it's removed on Save; otherwise the picked file is just dropped.
    remove: (saved: boolean) => {
      setError(null)
      setPending(saved ? 'remove' : null)
    },
    // What to show: the picked file, nothing once removed, else what's saved.
    showing: (saved: string | null) => (pending === 'remove' ? null : pending ? pending.url : saved),
  }
}

function ImagePicker({ image, saved, busy, disabled }: { image: PendingImage; saved: boolean; busy: boolean; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null)
  const has = image.pending === 'remove' ? false : image.pending !== null || saved

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-2">
        {has && (
          <Button variant="ghost-destructive" size="sm" disabled={busy} onClick={() => image.remove(saved)}>
            Remove
          </Button>
        )}
        <Button variant="outline" size="sm" disabled={busy || disabled} onClick={() => input.current?.click()}>
          {has ? 'Replace' : 'Upload'}
        </Button>
        <input
          ref={input}
          type="file"
          accept=".svg,.png,image/svg+xml,image/png"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void image.pick(file)
            e.target.value = ''
          }}
        />
      </div>
      {image.error && (
        <p role="alert" className="max-w-64 text-right text-xs text-destructive">
          {image.error}
        </p>
      )}
    </div>
  )
}

function AssetDetails({ kind, asset, image, fallback }: { kind: BrandAssetKind; asset: Asset; image: PendingImage; fallback: string }) {
  return (
    <div className="border-b border-border px-5 py-3 text-xs text-muted-foreground">
      {image.pending === 'remove' ? (
        <p className="font-medium text-foreground">Removed when you save. {fallback}</p>
      ) : image.pending ? (
        <p className="font-medium text-foreground">
          {image.pending.file.name}, {formatSize(image.pending.file.size)}. Not saved yet.
        </p>
      ) : asset ? (
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

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} bytes` : `${Math.round(bytes / 1024)} KB`
}

// The font stacks a body and heading choice give, as applyBranding builds
// them, with each Google font's stylesheet loaded the first time it's chosen.
function useFontPreview(bodyId: string, headingId: string, defaults: { sans: string; serif: string }) {
  const body = BODY_FONTS.find((f) => f.id === bodyId)
  const heading = HEADING_FONTS.find((f) => f.id === headingId)
  useEffect(() => {
    for (const font of [body, heading]) {
      const href = font && googleFontUrl(font)
      if (!href || document.querySelector(`link[href="${href}"]`)) continue
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = href
      document.head.appendChild(link)
    }
  }, [body, heading])
  const sans = body?.family ? `'${body.family}', ${defaults.sans}` : defaults.sans
  const serif = heading?.id === 'body' ? sans : heading?.family ? `'${heading.family}', ${defaults.serif}` : defaults.serif
  return { body: sans, heading: serif }
}

// A line in the chosen font, beside its picker.
function FontSample({ family, className, children }: { family: string; className?: string; children: ReactNode }) {
  return (
    <span className={cn('min-w-0 flex-1 truncate text-foreground', className)} style={{ fontFamily: family }} aria-hidden="true">
      {children}
    </span>
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

// Save, plus Reset to defaults (always shown where a form has defaults, off
// when there's nothing to reset) or Discard for unsaved changes.
function Actions({
  busy,
  result,
  canSave,
  onSave,
  canReset = false,
  onReset,
  onDiscard,
}: {
  busy: boolean
  result: { ok: boolean; text: string } | null
  canSave: boolean
  onSave: () => void
  canReset?: boolean
  onReset?: () => void
  onDiscard?: () => void
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-3 px-5 py-3">
      {result && (
        <span className="mr-auto">
          <Notice tone={result.ok ? 'success' : 'error'}>{result.text}</Notice>
        </span>
      )}
      {onDiscard && (
        <Button variant="ghost" size="sm" disabled={busy} onClick={onDiscard}>
          Discard
        </Button>
      )}
      {onReset && (
        <Button variant="ghost" size="sm" disabled={busy || !canReset} onClick={onReset}>
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
