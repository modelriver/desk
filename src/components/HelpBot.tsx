import { cn } from '../lib/cn.ts'

// Desk's help bot: a round-shouldered robot whose eyes have a river ripple
// along the bottom. One drawing, five moods, each with its own motion:
//   idle       online, waiting: bobs, glances around, blinks, now and then waves
//   thinking   writing an answer: tilts its head, antenna wiggles, dots for a mouth
//   happy      resolved: hops, waves, smiling eyes
//   listening  the visitor is typing: sound waves, pulsing antenna, "o" mouth
//   sleepy     off duty (a person has the chat): breathing, drooped antenna, closed eyes, z's
// Colors come from the theme (ink = text color, paper = card), so it follows
// light and dark mode; `inverted` swaps them for use on a dark button.
// Motion is opt-in through the `bot-live` class (see styles.css) and stops for
// people who prefer reduced motion.

export type BotMood = 'idle' | 'thinking' | 'happy' | 'listening' | 'sleepy'

const HEAD = 'M28 18H92C102 18 110 26 110 36V80C110 98 100 110 86 110C76 110 70 100 60 100C50 100 44 110 34 110C20 110 10 98 10 80V36C10 26 18 18 28 18Z'

// River eyes: round on top, a ripple along the bottom.
function riverEye(x: number, y: number, w: number, h: number) {
  const r = w / 2
  const mid = x + r
  const top = y
  const base = y + h
  return `M${x} ${top + r}Q${x} ${top} ${mid} ${top}Q${x + w} ${top} ${x + w} ${top + r}V${base}Q${x + w * 0.75} ${base - 3} ${mid} ${base}Q${x + w * 0.25} ${base + 3} ${x} ${base}Z`
}

// z's drifting up from the top right corner: [x, y, font size]. The head-only
// drawing has less room above it, so they sit lower and larger there.
const SLEEP_Z_FIGURE = [[98, 6, 12], [104, 0, 14], [110, -6, 16]] as const
const SLEEP_Z_HEAD = [[90, 14, 16], [97, 8, 18]] as const

const BODY_MOTION: Record<BotMood, string> = {
  idle: 'bot-bob',
  thinking: 'bot-tilt',
  happy: 'bot-jump',
  listening: 'bot-bob',
  sleepy: 'bot-breathe',
}

export function HelpBot({
  mood = 'idle',
  size = 28,
  body = 'head',
  inverted = false,
  animated = true,
  label,
  className,
}: {
  mood?: BotMood
  size?: number
  // "figure": the whole bot with arms and a shadow. "head": head and antenna, for small spots.
  body?: 'figure' | 'head'
  inverted?: boolean
  animated?: boolean
  // Accessible name; without one the bot is decorative.
  label?: string
  className?: string
}) {
  const figure = body === 'figure'
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true as const }
  return (
    <svg
      viewBox={figure ? '-14 -12 148 134' : '4 -4 112 118'}
      width={size}
      height={figure ? Math.round((size * 134) / 148) : size}
      className={cn('bot', inverted && 'bot-inverted', animated && 'bot-live', `bot-${mood}`, 'shrink-0', className)}
      {...a11y}
    >
      {figure && <ellipse className={cn('bot-ink', mood === 'happy' ? 'bot-shadow-jump' : 'bot-shadow')} cx="60" cy="118" rx="34" ry="4" opacity="0.12" />}

      {figure && mood === 'listening' && (
        <>
          <path className="bot-ink-stroke bot-wave-l" d="M-4 40Q-11 52 -4 64" fill="none" strokeWidth="3" strokeLinecap="round" />
          <path className="bot-ink-stroke bot-wave-l bot-late" d="M-4 40Q-11 52 -4 64" fill="none" strokeWidth="3" strokeLinecap="round" />
          <path className="bot-ink-stroke bot-wave-r" d="M124 40Q131 52 124 64" fill="none" strokeWidth="3" strokeLinecap="round" />
          <path className="bot-ink-stroke bot-wave-r bot-late" d="M124 40Q131 52 124 64" fill="none" strokeWidth="3" strokeLinecap="round" />
        </>
      )}
      {mood === 'sleepy' && (
        <g className="bot-ink" fontWeight="700" fontFamily="system-ui, sans-serif">
          {(figure ? SLEEP_Z_FIGURE : SLEEP_Z_HEAD).map(([x, y, size], i) => (
            <text key={i} className={cn('bot-z', i === 1 && 'bot-z2', i === 2 && 'bot-z3')} x={x} y={y} fontSize={size}>
              z
            </text>
          ))}
        </g>
      )}

      <g className={BODY_MOTION[mood]}>
        {figure && (
          <>
            <ellipse className="bot-paper bot-ink-stroke" cx="7" cy={mood === 'sleepy' ? 82 : 80} rx="5.5" ry="8.5" strokeWidth="4" />
            <ellipse
              className={cn('bot-paper bot-ink-stroke', (mood === 'idle' || mood === 'happy') && 'bot-arm')}
              cx="113"
              cy={mood === 'sleepy' ? 82 : 80}
              rx="5.5"
              ry="8.5"
              strokeWidth="4"
            />
          </>
        )}

        {/* Antenna */}
        {mood === 'sleepy' ? (
          <>
            <path className="bot-ink-stroke" d="M60 19Q60 9 52 6" fill="none" strokeWidth="5" strokeLinecap="round" />
            <circle className="bot-ink" cx="50" cy="6" r="6" />
          </>
        ) : mood === 'listening' ? (
          <>
            <line className="bot-ink-stroke" x1="60" y1="19" x2="60" y2="8" strokeWidth="5" strokeLinecap="round" />
            <circle className="bot-ink bot-pulse" cx="60" cy="5" r="6" />
          </>
        ) : (
          <g className="bot-antenna">
            <line className="bot-ink-stroke" x1="60" y1="19" x2="60" y2="8" strokeWidth="5" strokeLinecap="round" />
            <circle className="bot-ink" cx="60" cy="5" r="6" />
          </g>
        )}

        <path className="bot-paper bot-ink-stroke" d={HEAD} strokeWidth="5" strokeLinejoin="round" />
        <rect className="bot-ink" x="22" y="32" width="76" height="50" rx="22" />

        {/* Eyes and mouth */}
        {mood === 'idle' && (
          <>
            <g className="bot-look">
              <g className="bot-blink">
                <path className="bot-paper" d={riverEye(37, 47, 16, 12)} />
                <path className="bot-paper" d={riverEye(67, 47, 16, 12)} />
              </g>
            </g>
            <path className="bot-paper-stroke" d="M55 70Q57.5 73.5 60 70Q62.5 73.5 65 70" fill="none" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          </>
        )}
        {mood === 'thinking' && (
          <>
            <g className="bot-blink bot-blink-late">
              <path className="bot-paper" d={riverEye(41, 42, 16, 12)} />
              <path className="bot-paper" d={riverEye(69, 42, 16, 12)} />
            </g>
            <circle className="bot-paper bot-dot" cx="50" cy="70" r="3.2" />
            <circle className="bot-paper bot-dot bot-d2" cx="60" cy="70" r="3.2" />
            <circle className="bot-paper bot-dot bot-d3" cx="70" cy="70" r="3.2" />
          </>
        )}
        {mood === 'happy' && (
          <>
            <path className="bot-paper-stroke" d="M37 59Q45 46 53 59" fill="none" strokeWidth="4.5" strokeLinecap="round" />
            <path className="bot-paper-stroke" d="M67 59Q75 46 83 59" fill="none" strokeWidth="4.5" strokeLinecap="round" />
            <path className="bot-paper-stroke" d="M53 68Q60 76 67 68" fill="none" strokeWidth="3" strokeLinecap="round" />
          </>
        )}
        {mood === 'listening' && (
          <>
            <g className="bot-blink">
              <path className="bot-paper" d={riverEye(36, 45, 18, 14)} />
              <path className="bot-paper" d={riverEye(66, 45, 18, 14)} />
            </g>
            <circle className="bot-paper-stroke" cx="60" cy="71" r="3" fill="none" strokeWidth="2.5" />
          </>
        )}
        {mood === 'sleepy' && (
          <>
            {/* Closed eyes curving down, the opposite of happy's raised arcs. */}
            <path className="bot-paper-stroke" d="M38 55Q45 63 52 55" fill="none" strokeWidth="4" strokeLinecap="round" />
            <path className="bot-paper-stroke" d="M68 55Q75 63 82 55" fill="none" strokeWidth="4" strokeLinecap="round" />
            <path className="bot-paper-stroke" d="M57 71H63" fill="none" strokeWidth="2.5" strokeLinecap="round" />
          </>
        )}
      </g>
    </svg>
  )
}
