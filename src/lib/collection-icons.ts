// The icons a help-center section (a public folder) can have, by name, with
// what the Data page's picker shows and searches. Kept here without any
// drawing so the server can check a name before saving it;
// components/CollectionIcon.tsx draws them. Names follow Lucide
// (https://lucide.dev), which the drawings are adapted from, and are stored
// in `.desk.json`: never rename or remove one, only add.

const ICONS = [
  // Getting started and general
  { name: 'book-open', label: 'Book', keywords: 'guide docs documentation manual learn read basics' },
  { name: 'rocket', label: 'Rocket', keywords: 'launch start getting started onboarding new' },
  { name: 'sparkles', label: 'Sparkles', keywords: 'new features ai magic whats new' },
  { name: 'lightbulb', label: 'Idea', keywords: 'tips tricks ideas how to best practices' },
  { name: 'graduation-cap', label: 'Learning', keywords: 'learn course tutorial training academy education' },
  { name: 'circle-help', label: 'Question', keywords: 'help faq questions support' },
  { name: 'info', label: 'Info', keywords: 'about information overview details' },
  { name: 'home', label: 'Home', keywords: 'house start main overview' },
  { name: 'flag', label: 'Flag', keywords: 'milestone goal report' },
  { name: 'target', label: 'Target', keywords: 'goal aim focus objectives' },
  { name: 'compass', label: 'Compass', keywords: 'explore navigate discover direction' },
  // Growth and people
  { name: 'trending-up', label: 'Growth', keywords: 'grow increase marketing sales analytics' },
  { name: 'heart', label: 'Heart', keywords: 'love support donate like favourite favorite' },
  { name: 'star', label: 'Star', keywords: 'favourite favorite rating review featured' },
  { name: 'thumbs-up', label: 'Thumbs up', keywords: 'like feedback approve' },
  { name: 'smile', label: 'Smile', keywords: 'happy customer experience emoji' },
  { name: 'award', label: 'Award', keywords: 'badge prize achievement reward premium' },
  { name: 'megaphone', label: 'Megaphone', keywords: 'announcement marketing promote news broadcast' },
  { name: 'users', label: 'People', keywords: 'team members group community customers' },
  { name: 'user', label: 'Person', keywords: 'account profile me user' },
  { name: 'user-plus', label: 'Add person', keywords: 'invite signup sign up register join team' },
  { name: 'log-in', label: 'Sign in', keywords: 'login log in access account' },
  // Money and shopping
  { name: 'shopping-bag', label: 'Shopping bag', keywords: 'shop store buy orders ecommerce' },
  { name: 'shopping-cart', label: 'Cart', keywords: 'checkout buy basket orders ecommerce' },
  { name: 'credit-card', label: 'Card', keywords: 'billing payments pay subscription' },
  { name: 'wallet', label: 'Wallet', keywords: 'billing money payouts balance funds' },
  { name: 'receipt', label: 'Receipt', keywords: 'invoice billing payment refund' },
  { name: 'dollar-sign', label: 'Dollar', keywords: 'money pricing price cost billing' },
  { name: 'percent', label: 'Percent', keywords: 'discount coupon promo sale tax' },
  { name: 'tag', label: 'Tag', keywords: 'pricing label price discount category' },
  { name: 'gift', label: 'Gift', keywords: 'present rewards referral perks' },
  { name: 'package', label: 'Package', keywords: 'product box parcel order' },
  { name: 'truck', label: 'Delivery', keywords: 'shipping deliver delivery order tracking' },
  { name: 'briefcase', label: 'Briefcase', keywords: 'business work company enterprise' },
  { name: 'building', label: 'Company', keywords: 'business organization office enterprise' },
  // Communication
  { name: 'message-circle', label: 'Message', keywords: 'chat conversation comments talk' },
  { name: 'mail', label: 'Email', keywords: 'email inbox newsletter contact' },
  { name: 'inbox', label: 'Inbox', keywords: 'messages email tickets' },
  { name: 'send', label: 'Send', keywords: 'share message publish' },
  { name: 'phone', label: 'Phone', keywords: 'call contact support' },
  { name: 'bell', label: 'Notifications', keywords: 'alerts reminders notify' },
  { name: 'headset', label: 'Support', keywords: 'help contact customer service' },
  // Content and media
  { name: 'square-pen', label: 'Writing', keywords: 'edit write posts blog compose' },
  { name: 'file-text', label: 'Document', keywords: 'file page article policy terms legal' },
  { name: 'clipboard-list', label: 'Checklist', keywords: 'tasks list todo steps setup' },
  { name: 'image', label: 'Image', keywords: 'photo picture gallery media' },
  { name: 'camera', label: 'Camera', keywords: 'photo picture media' },
  { name: 'video', label: 'Video', keywords: 'film movie recording media stream' },
  { name: 'music', label: 'Music', keywords: 'audio sound podcast' },
  { name: 'coffee', label: 'Coffee', keywords: 'cafe drink break support' },
  { name: 'calendar', label: 'Calendar', keywords: 'schedule events bookings dates appointments' },
  { name: 'clock', label: 'Clock', keywords: 'time hours schedule history' },
  { name: 'map-pin', label: 'Location', keywords: 'map place address local' },
  { name: 'globe', label: 'Globe', keywords: 'world web language international website' },
  { name: 'leaf', label: 'Leaf', keywords: 'nature eco environment sustainability' },
  // Account, security and settings
  { name: 'shield', label: 'Security', keywords: 'safety protect privacy secure' },
  { name: 'lock', label: 'Lock', keywords: 'security password private' },
  { name: 'key', label: 'Key', keywords: 'api keys access password credentials' },
  { name: 'eye', label: 'Eye', keywords: 'privacy visibility view' },
  { name: 'settings', label: 'Settings', keywords: 'preferences configure options account' },
  { name: 'sliders', label: 'Controls', keywords: 'settings preferences adjust customize' },
  { name: 'wrench', label: 'Tools', keywords: 'troubleshooting fix repair maintenance' },
  { name: 'circle-check', label: 'Check', keywords: 'done complete success verified' },
  { name: 'triangle-alert', label: 'Warning', keywords: 'issues problems errors known issues troubleshooting' },
  // Technical
  { name: 'plug', label: 'Integrations', keywords: 'connect apps plugins' },
  { name: 'link', label: 'Link', keywords: 'url connect integrations' },
  { name: 'code', label: 'Code', keywords: 'developers api dev programming' },
  { name: 'terminal', label: 'Terminal', keywords: 'cli command line developers shell' },
  { name: 'database', label: 'Database', keywords: 'data storage sql' },
  { name: 'server', label: 'Server', keywords: 'hosting infrastructure self hosted deploy' },
  { name: 'cloud', label: 'Cloud', keywords: 'hosting sync backup' },
  { name: 'monitor', label: 'Desktop', keywords: 'computer screen app' },
  { name: 'smartphone', label: 'Mobile', keywords: 'phone app ios android' },
  { name: 'bot', label: 'Bot', keywords: 'ai assistant automation chatbot robot' },
  { name: 'zap', label: 'Lightning', keywords: 'fast automation quick power' },
  { name: 'layers', label: 'Layers', keywords: 'stack features product platform' },
  { name: 'chart', label: 'Chart', keywords: 'analytics reports stats insights data' },
  { name: 'search', label: 'Search', keywords: 'find look up discover' },
  { name: 'download', label: 'Download', keywords: 'export install get' },
  { name: 'archive', label: 'Archive', keywords: 'old storage history' },
] as const

export type CollectionIconName = (typeof ICONS)[number]['name']

// In the picker's order.
export const COLLECTION_ICONS: readonly CollectionIconName[] = ICONS.map((i) => i.name)

export const ICON_LABELS = Object.fromEntries(ICONS.map((i) => [i.name, i.label])) as Record<CollectionIconName, string>

export const DEFAULT_COLLECTION_ICON: CollectionIconName = 'book-open'

export function isCollectionIcon(name: unknown): name is CollectionIconName {
  return typeof name === 'string' && (COLLECTION_ICONS as readonly string[]).includes(name)
}

// The picker's search: icons whose name, label or keywords match every word
// typed, as the start of a word ("bill" finds billing, "inv" invoice). Empty finds all.
export function searchIcons(query: string): CollectionIconName[] {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  if (!words.length) return [...COLLECTION_ICONS]
  return ICONS.filter((icon) => {
    const terms = `${icon.name} ${icon.label} ${icon.keywords}`.toLowerCase().split(/[^a-z0-9]+/)
    return words.every((w) => terms.some((t) => t.startsWith(w)))
  }).map((i) => i.name)
}

// A section's description, as shown on its card and page.
export const MAX_FOLDER_DESCRIPTION = 200
