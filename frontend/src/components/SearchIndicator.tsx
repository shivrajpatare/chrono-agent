import React from "react";
import { Search, Loader2 } from "lucide-react";

interface SearchIndicatorProps {
  queries: string[];
}

export const SearchIndicator: React.FC<SearchIndicatorProps> = ({ queries }) => {
  if (!queries || queries.length === 0) return null;

  return (
    <div className="my-3.5 inline-flex flex-col sm:flex-row items-start sm:items-center gap-2.5 px-3.5 py-2 rounded-lg bg-[#111113]/90 border border-white/[0.08] text-zinc-300 text-xs shadow-sm backdrop-blur-md">
      <div className="flex items-center gap-2 shrink-0">
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
          <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
        </span>
        <Search className="w-3.5 h-3.5 text-amber-400 stroke-[2]" />
        <span className="font-mono text-[11px] uppercase tracking-wider text-zinc-400">
          Querying {queries.length > 1 ? "corpus (parallel)" : "corpus"}:
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {queries.map((q, idx) => (
          <span
            key={idx}
            className="px-2 py-0.5 rounded bg-[#18181B] border border-white/[0.07] text-zinc-200 font-mono text-[11px]"
          >
            "{q}"
          </span>
        ))}
      </div>

      <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-400 shrink-0 sm:ml-auto" />
    </div>
  );
};
