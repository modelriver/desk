import { Link } from '@tanstack/react-router'
import { ArticleList, type ArticleLink } from './ArticleList.tsx'
import { headingSlug } from '../lib/markdown.ts'

interface SectionData {
  category: string
  path: string | null
  articles: ArticleLink[]
  subsections: Array<{ name: string; path: string | null; articles: ArticleLink[] }>
}

// Sections and their subsections. Folder-backed ones link to their own page
// (/help/billing). `titled` false hides the top-level headings (a single
// unnamed section, or a section's own page).
export function HelpSections({ sections, titled = true }: { sections: SectionData[]; titled?: boolean }) {
  return (
    <div className="grid gap-10">
      {sections.map((section) => (
        <section key={section.category} aria-labelledby={titled ? `cat-${headingSlug(section.category)}` : undefined}>
          {titled && (
            <h2 id={`cat-${headingSlug(section.category)}`} className="mb-3 scroll-mt-20 text-sm font-semibold text-muted-foreground">
              {section.path ? (
                <Link to="/help/$" params={{ _splat: section.path }} className="hover:text-foreground hover:underline underline-offset-4">
                  {section.category}
                </Link>
              ) : (
                section.category
              )}
            </h2>
          )}
          {section.articles.length > 0 && <ArticleList articles={section.articles} />}
          {section.subsections.map((sub) => (
            <div key={sub.name} className="mt-5">
              <h3 className="mb-2 text-sm text-muted-foreground">
                {sub.path ? (
                  <Link to="/help/$" params={{ _splat: sub.path }} className="hover:text-foreground hover:underline underline-offset-4">
                    {sub.name}
                  </Link>
                ) : (
                  sub.name
                )}
              </h3>
              <ArticleList articles={sub.articles} />
            </div>
          ))}
        </section>
      ))}
    </div>
  )
}
