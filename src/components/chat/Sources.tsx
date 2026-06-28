import { useState } from "react";
import { ExternalLink, Globe, ChevronDown, ShieldCheck, CalendarClock } from "lucide-react";
import type { UIMessage } from "ai";

type SearchResult = {
  title?: string;
  url?: string;
  snippet?: string;
  publishedDate?: string;
};

type SearchOutput = {
  query?: string;
  retrievedAt?: string;
  results?: SearchResult[];
};

type FetchOutput = {
  url?: string;
  title?: string;
  publishedDate?: string;
  retrievedAt?: string;
};

function hostOf(url?: string) {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function fmtDate(s?: string) {
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function daysAgo(s?: string) {
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  const diff = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (diff < 0) return null;
  return diff;
}

function confidenceFor(results: SearchResult[], fetched: number) {
  const dated = results.filter((r) => r.publishedDate).length;
  const score = Math.min(100, results.length * 12 + dated * 8 + fetched * 18);
  if (score >= 75) return { label: "High confidence", tone: "high" as const };
  if (score >= 45) return { label: "Medium confidence", tone: "med" as const };
  return { label: "Low confidence — verify", tone: "low" as const };
}

export function Sources({ message }: { message: UIMessage }) {
  const [open, setOpen] = useState(true);

  const searches: SearchOutput[] = [];
  const fetches: FetchOutput[] = [];

  for (const part of message.parts as Array<Record<string, unknown>>) {
    const type = part.type as string | undefined;
    if (!type) continue;
    const state = part.state as string | undefined;
    if (state && state !== "output-available") continue;
    const output = part.output as Record<string, unknown> | undefined;
    if (!output) continue;
    if (type === "tool-web_search") {
      searches.push(output as SearchOutput);
    } else if (type === "tool-fetch_url") {
      fetches.push(output as FetchOutput);
    }
  }

  // Merge results, dedupe by URL
  const merged = new Map<string, SearchResult & { verified?: boolean }>();
  for (const s of searches) {
    for (const r of s.results ?? []) {
      if (!r.url) continue;
      if (!merged.has(r.url)) merged.set(r.url, { ...r });
    }
  }
  for (const f of fetches) {
    if (!f.url) continue;
    const existing = merged.get(f.url);
    if (existing) {
      existing.verified = true;
      if (!existing.publishedDate && f.publishedDate) existing.publishedDate = f.publishedDate;
      if (!existing.title && f.title) existing.title = f.title;
    } else {
      merged.set(f.url, { url: f.url, title: f.title, publishedDate: f.publishedDate, verified: true });
    }
  }

  const items = Array.from(merged.values());
  if (items.length === 0) return null;

  const conf = confidenceFor(items, fetches.length);
  const queries = searches.map((s) => s.query).filter(Boolean) as string[];
  const retrieved = searches[0]?.retrievedAt ?? fetches[0]?.retrievedAt;

  const toneClasses = {
    high: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
    med: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30",
    low: "bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/30",
  }[conf.tone];

  return (
    <div className="mt-4 rounded-xl border border-border/60 bg-card/40 backdrop-blur-sm overflow-hidden animate-fade-in">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-3 px-3.5 py-2.5 text-left hover:bg-accent/40 transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-gradient/10 text-primary">
            <Globe className="h-3.5 w-3.5" />
            <span className="absolute inset-0 rounded-lg bg-brand-gradient opacity-0 hover:opacity-10 transition" />
          </span>
          <div className="min-w-0">
            <div className="text-xs font-semibold">Sources <span className="text-muted-foreground font-normal">· {items.length}</span></div>
            {queries[0] && (
              <div className="text-[11px] text-muted-foreground truncate">"{queries[0]}"</div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`hidden sm:inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${toneClasses}`}>
            <ShieldCheck className="h-3 w-3" />
            {conf.label}
          </span>
          <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
        </div>
      </button>

      {open && (
        <div className="px-3 pb-3 pt-1 space-y-1.5 animate-fade-in">
          <span className={`sm:hidden inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${toneClasses}`}>
            <ShieldCheck className="h-3 w-3" />
            {conf.label}
          </span>
          {retrieved && (
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <CalendarClock className="h-3 w-3" />
              Retrieved {fmtDate(retrieved)}
            </div>
          )}
          <ol className="space-y-1.5">
            {items.map((r, i) => {
              const host = hostOf(r.url);
              const date = fmtDate(r.publishedDate);
              const age = daysAgo(r.publishedDate);
              const freshness =
                age == null
                  ? null
                  : age <= 1
                  ? "today"
                  : age <= 7
                  ? `${age}d ago`
                  : age <= 30
                  ? `${Math.round(age / 7)}w ago`
                  : age <= 365
                  ? `${Math.round(age / 30)}mo ago`
                  : `${Math.round(age / 365)}y ago`;
              return (
                <li
                  key={r.url}
                  className="group relative rounded-lg border border-border/50 bg-background/60 p-2.5 hover:border-primary/40 hover:-translate-y-0.5 hover:shadow-brand/30 transition-all duration-200"
                  style={{ animation: `fade-in 0.4s ease-out ${i * 60}ms both` }}
                >
                  <a href={r.url} target="_blank" rel="noopener noreferrer" className="block min-w-0">
                    <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                      <span className="inline-flex items-center justify-center h-4 w-4 rounded bg-muted text-[8px] font-bold">
                        {i + 1}
                      </span>
                      <span className="truncate">{host}</span>
                      {r.verified && (
                        <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 px-1.5 py-0.5 text-[9px] font-medium">
                          <ShieldCheck className="h-2.5 w-2.5" /> verified
                        </span>
                      )}
                      {date && (
                        <span className="ml-auto inline-flex items-center gap-0.5 text-[10px] text-muted-foreground">
                          <CalendarClock className="h-2.5 w-2.5" />
                          {date}{freshness ? ` · ${freshness}` : ""}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs font-medium text-foreground line-clamp-2 group-hover:text-primary transition-colors">
                      {r.title || r.url}
                    </div>
                    {r.snippet && (
                      <div className="mt-1 text-[11px] text-muted-foreground line-clamp-2">{r.snippet}</div>
                    )}
                    <ExternalLink className="absolute top-2.5 right-2.5 h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                  </a>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}

export function SearchingIndicator({ message }: { message: UIMessage }) {
  // Detect in-progress tool calls
  const active = (message.parts as Array<Record<string, unknown>>).some((p) => {
    const t = p.type as string | undefined;
    const s = p.state as string | undefined;
    return (
      (t === "tool-web_search" || t === "tool-fetch_url") &&
      (s === "input-streaming" || s === "input-available" || s === "executing")
    );
  });
  if (!active) return null;
  const isFetch = (message.parts as Array<Record<string, unknown>>).some(
    (p) => p.type === "tool-fetch_url" && p.state !== "output-available",
  );
  return (
    <div className="mt-2 inline-flex items-center gap-2 rounded-full border border-border/60 bg-card/60 backdrop-blur px-3 py-1.5 text-xs animate-fade-in">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full rounded-full bg-brand-gradient opacity-75 animate-ping" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-brand-gradient" />
      </span>
      <span className="text-shimmer font-medium">
        {isFetch ? "Reading source…" : "Searching the web…"}
      </span>
    </div>
  );
}
