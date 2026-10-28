// The `---` block at the top of an article: one `key: value` per line.
// Its own module with no Node imports, so browser code can use it too.

export function parseFrontMatter(source: string): { data: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source)
  if (!match) return { data: {}, body: source }
  const data: Record<string, string> = {}
  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (!kv) continue
    data[kv[1]!] = kv[2]!.trim().replace(/^(['"])(.*)\1$/, '$2')
  }
  return { data, body: source.slice(match[0].length) }
}
