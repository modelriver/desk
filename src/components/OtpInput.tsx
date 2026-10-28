import { useEffect, useRef, useState } from 'react'
import { cn } from '../lib/cn.ts'

// One box per digit. Typing moves forward, Backspace moves back, the arrow
// keys move between boxes, and pasting (or the phone's one-time-code
// autofill) fills every box at once. Calls onComplete when all are filled.
// Give it a new `key` to clear it.
export function OtpInput({
  length = 6,
  label,
  autoFocus,
  disabled,
  invalid,
  onChange,
  onComplete,
}: {
  length?: number
  label: string
  autoFocus?: boolean
  disabled?: boolean
  invalid?: boolean
  onChange?: (code: string) => void
  onComplete?: (code: string) => void
}) {
  const [digits, setDigits] = useState<string[]>(() => Array(length).fill(''))
  const boxes = useRef<Array<HTMLInputElement | null>>([])

  useEffect(() => {
    if (autoFocus) boxes.current[0]?.focus()
  }, [autoFocus])

  const focusBox = (i: number) => {
    const box = boxes.current[Math.max(0, Math.min(length - 1, i))]
    box?.focus()
    box?.select()
  }

  const update = (next: string[]) => {
    setDigits(next)
    const code = next.join('')
    onChange?.(code)
    if (code.length === length && next.every(Boolean)) onComplete?.(code)
  }

  // Put typed or pasted digits in place starting at box i.
  const fillFrom = (i: number, text: string) => {
    const incoming = text.replace(/\D/g, '').slice(0, length - i)
    if (!incoming) return
    const next = [...digits]
    for (let k = 0; k < incoming.length; k++) next[i + k] = incoming[k]!
    update(next)
    focusBox(i + incoming.length)
  }

  return (
    <div role="group" aria-label={label} className="flex items-center justify-center gap-2">
      {digits.map((digit, i) => (
        <input
          key={i}
          ref={(el) => {
            boxes.current[i] = el
          }}
          value={digit}
          disabled={disabled}
          inputMode="numeric"
          pattern="[0-9]*"
          // Lets iOS and Android offer the code from an SMS or password manager.
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          aria-label={`Digit ${i + 1} of ${length}`}
          aria-invalid={invalid || undefined}
          maxLength={length}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => {
            const value = e.currentTarget.value
            if (value === '') {
              const next = [...digits]
              next[i] = ''
              update(next)
            } else {
              // Typing replaces the selected digit; autofill may insert several.
              fillFrom(i, value.length > 1 && digit ? value.replace(digit, '') || value : value)
            }
          }}
          onPaste={(e) => {
            e.preventDefault()
            fillFrom(0, e.clipboardData.getData('text'))
          }}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && !digit && i > 0) {
              e.preventDefault()
              const next = [...digits]
              next[i - 1] = ''
              update(next)
              focusBox(i - 1)
            } else if (e.key === 'ArrowLeft') {
              e.preventDefault()
              focusBox(i - 1)
            } else if (e.key === 'ArrowRight') {
              e.preventDefault()
              focusBox(i + 1)
            }
          }}
          className={cn(
            'size-11 rounded-lg border bg-background text-center font-mono text-xl text-foreground caret-foreground sm:size-12',
            'focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring',
            'disabled:opacity-50',
            invalid ? 'border-destructive' : 'border-input',
            // A slightly wider gap in the middle groups the code as 3 + 3.
            i === Math.floor(length / 2) - 1 && 'mr-2',
          )}
        />
      ))}
    </div>
  )
}
