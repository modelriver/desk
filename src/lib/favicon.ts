// The browser-tab icon: the Desk bot's head, as the header draws it (see
// HelpBot.tsx), in the theme's colours. The SVG switches to the dark theme's
// colours when the browser is in dark mode.

export interface FaviconColors {
  ink: string
  paper: string
}

// HelpBot's head, antenna, visor, eyes (riverEye(37/67, 47, 16, 12)) and smile.
const SHAPES = [
  '<line class="i-s" x1="60" y1="19" x2="60" y2="8" stroke-width="5" stroke-linecap="round"/>',
  '<circle class="i" cx="60" cy="5" r="6"/>',
  '<path class="p i-s" stroke-width="5" stroke-linejoin="round" d="M28 18H92C102 18 110 26 110 36V80C110 98 100 110 86 110C76 110 70 100 60 100C50 100 44 110 34 110C20 110 10 98 10 80V36C10 26 18 18 28 18Z"/>',
  '<rect class="i" x="22" y="32" width="76" height="50" rx="22"/>',
  '<path class="p" d="M37 55Q37 47 45 47Q53 47 53 55V59Q49 56 45 59Q41 62 37 59Z"/>',
  '<path class="p" d="M67 55Q67 47 75 47Q83 47 83 55V59Q79 56 75 59Q71 62 67 59Z"/>',
  '<path class="p-s" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" d="M55 70Q57.5 73.5 60 70Q62.5 73.5 65 70"/>',
].join('')

// Theme colours are checked when support.config.json is read (hex, rgb(),
// hsl() or oklch()); escaping is a second guard, since they land in markup.
const safe = (color: string) => color.replace(/[<>&"'{};]/g, '')

const rules = ({ ink, paper }: FaviconColors) =>
  `.i{fill:${safe(ink)}}.p{fill:${safe(paper)}}.i-s{stroke:${safe(ink)}}.p-s{stroke:${safe(paper)}}`

export function faviconSvg(light: FaviconColors, dark: FaviconColors): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="4 -4 112 118">` +
    `<style>${rules(light)}@media (prefers-color-scheme:dark){${rules(dark)}}</style>` +
    SHAPES +
    `</svg>`
  )
}
