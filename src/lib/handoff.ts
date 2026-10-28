// Spotting when a visitor wants a person instead of the AI.
//
// Two layers: wantsHuman() catches clear phrasings on the server before the
// AI is even called, and the AI is told to end its reply with HANDOFF_MARKER
// for anything else that means the same. The widget hands off when it sees
// the marker; linkCitations() drops it from what's shown.

export const HANDOFF_MARKER = '[[handoff]]'

// The AI ends a reply with this when the help articles didn't answer the
// question, so the team can see what to write next (Insights in the dashboard).
export const UNSURE_MARKER = '[[unsure]]'

export function hasUnsureMarker(answer: string): boolean {
  return answer.includes(UNSURE_MARKER)
}

const PATTERNS = [
  // "talk to a person", "speak with someone", "chat to the team", "talk to an agent"
  /\b(talk|speak|chat)\s+(to|with)\s+(a|an|the|some|your)?\s*(human|person|agent|someone|somebody|representative|rep|real person|support|support team|team|team member|member of (your|the) team|staff)\b/i,
  // "connect me with someone", "transfer me to an agent", "put me through to the team"
  // (but not "connect me to Stripe" or "put me on the annual plan")
  /\b(connect|transfer|put)\s+me\s+(through\s+)?(to|with)\s+(a|an|the|some|your)?\s*(human|person|agent|someone|somebody|representative|rep|real person|support|support team|team|team member|member of (your|the) team|staff)\b/i,
  // "transfer me", "please connect me." on their own
  /\b(connect|transfer)\s+me\s*[.!?]*$/i,
  // "real person", "live agent", "actual human"
  /\b(real|live|actual)\s+(person|human|agent|support)\b/i,
  // "human please", "agent please"
  /\b(human|agent|person)\s*,?\s*please\b/i,
  // "can I get a human", "I want a person", "I need an agent"
  /\b(get|want|need|have)\s+(a|an)\s+(human|person|agent|real person)\b/i,
  // "escalate this", "escalate me"
  /\bescalate\s+(this|me|it)\b/i,
]

export function wantsHuman(message: string): boolean {
  const text = message.trim()
  if (!text || text.length > 400) return false
  return PATTERNS.some((p) => p.test(text))
}

export function hasHandoffMarker(answer: string): boolean {
  return answer.includes(HANDOFF_MARKER)
}
