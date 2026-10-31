import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Link, type LinkProps } from "@tanstack/react-router";
import { cn } from "../lib/cn.ts";

export interface TabItem {
  id: string;
  label: ReactNode;
  // Where the tab goes: the same page with its own ?tab=, so tabs can be linked to.
  link: LinkProps;
}

// Tabs as links (Settings, Conversations), with one underline that slides to
// the chosen tab. It's measured after each render and placed without motion
// the first time, so it doesn't fly in on page load. The chosen tab only
// changes colour, not weight, so the labels never shift. `aside` sits at the
// row's right end, on the same line as the tabs (a filter, say).
export function TabBar({
  tabs,
  active,
  label,
  aside,
}: {
  tabs: TabItem[];
  active: string;
  label: string;
  aside?: ReactNode;
}) {
  const nav = useRef<HTMLElement>(null);
  const [bar, setBar] = useState<{
    left: number;
    width: number;
    moved: boolean;
  } | null>(null);

  useLayoutEffect(() => {
    const place = () => {
      const current = nav.current?.querySelector<HTMLElement>(
        '[aria-selected="true"]',
      );
      if (!current) return;
      setBar((prev) => ({
        left: current.offsetLeft,
        width: current.offsetWidth,
        moved: prev !== null,
      }));
    };
    place();
    // Web fonts and window size change the tabs' widths.
    const observer = new ResizeObserver(place);
    if (nav.current) observer.observe(nav.current);
    return () => observer.disconnect();
  }, [active]);

  return (
    <div className="mb-6 flex flex-col-reverse gap-2 border-b border-border sm:flex-row sm:items-end sm:gap-3">
      <nav
        ref={nav}
        role="tablist"
        aria-label={label}
        className="relative -mx-1 flex min-w-0 flex-1 gap-1 overflow-x-auto px-1"
      >
        {tabs.map((t) => (
          <Link
            key={t.id}
            {...t.link}
            role="tab"
            aria-selected={active === t.id}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 px-3 py-2 text-sm whitespace-nowrap",
              active === t.id
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground",
              // Until the sliding underline is measured (the server-rendered page), the tab draws its own.
              active === t.id &&
                !bar &&
                "shadow-[inset_0_-2px_0_var(--primary)]",
            )}
          >
            {t.label}
          </Link>
        ))}
        {bar && (
          <span
            aria-hidden="true"
            data-motion={bar.moved ? "" : undefined}
            className="tab-bar pointer-events-none absolute bottom-0 left-0 h-0.5 rounded-full bg-primary"
            style={{ width: bar.width, transform: `translateX(${bar.left}px)` }}
          />
        )}
      </nav>
      {aside && <div className="sm:shrink-0 sm:pb-1.5">{aside}</div>}
    </div>
  );
}
