import React from "react";
import { Zap, Search, Brain, ShieldCheck, Cpu } from "lucide-react";
import { TelemetryMetrics } from "../types";

interface TelemetryBarProps {
  metrics?: TelemetryMetrics;
}

export const TelemetryBar: React.FC<TelemetryBarProps> = ({ metrics }) => {
  if (!metrics) return null;

  const {
    ttft_ms,
    search_ms,
    search_count,
    memory_hits,
    citation_count,
    model_used,
    provider,
  } = metrics;

  return (
    <div className="mt-4 pt-3 border-t border-white/[0.07] flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] font-mono text-zinc-400 select-none tracking-wide">
      {/* TTFT Item */}
      <div className="inline-flex items-center gap-1.5 pr-3 border-r border-white/[0.08]" title="Time to First Token">
        <Zap className="w-3 h-3 text-amber-400 stroke-[2]" />
        <span className="text-zinc-500 font-medium">TTFT</span>
        <span className="text-zinc-200 font-semibold">{ttft_ms.toFixed(0)}ms</span>
      </div>

      {/* Search Item */}
      <div className="inline-flex items-center gap-1.5 pr-3 border-r border-white/[0.08]" title="Web Search Roundtrips">
        <Search className={`w-3 h-3 ${search_count > 0 ? "text-amber-400" : "text-zinc-600"} stroke-[2]`} />
        <span className="text-zinc-500 font-medium">SEARCH</span>
        <span className={search_count > 0 ? "text-zinc-200 font-semibold" : "text-zinc-500"}>
          {search_count}x
          {search_count > 0 ? ` (${provider.toUpperCase()} · ${search_ms.toFixed(0)}ms)` : ""}
        </span>
      </div>

      {/* Memory Item */}
      <div className="inline-flex items-center gap-1.5 pr-3 border-r border-white/[0.08]" title="Deterministic Temporal Memory Hits">
        <Brain className={`w-3 h-3 ${memory_hits > 0 ? "text-emerald-400" : "text-zinc-600"} stroke-[2]`} />
        <span className="text-zinc-500 font-medium">MEM RECALL</span>
        <span className={memory_hits > 0 ? "text-emerald-300 font-semibold" : "text-zinc-500"}>
          {memory_hits} {memory_hits === 1 ? "HIT" : "HITS"}
        </span>
      </div>

      {/* Citations Item */}
      <div className="inline-flex items-center gap-1.5 pr-3 border-r border-white/[0.08]" title="Verified Inline Citations">
        <ShieldCheck className={`w-3 h-3 ${citation_count > 0 ? "text-emerald-400" : "text-zinc-600"} stroke-[2]`} />
        <span className="text-zinc-500 font-medium">CITES</span>
        <span className={citation_count > 0 ? "text-emerald-300 font-semibold" : "text-zinc-500"}>
          {citation_count}
        </span>
      </div>

      {/* Model Item */}
      <div className="inline-flex items-center gap-1.5 ml-auto text-zinc-500" title={`Model: ${model_used}`}>
        <Cpu className="w-3 h-3 text-zinc-600 stroke-[2]" />
        <span className="text-zinc-400 truncate max-w-[150px]">{model_used.split("/").pop()}</span>
      </div>
    </div>
  );
};
