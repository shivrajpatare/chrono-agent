import React, { useState } from "react";
import { ExternalLink, Globe, ChevronDown, ChevronUp, Bot, User, BookOpen } from "lucide-react";
import { Message, Source } from "../types";
import { SearchIndicator } from "./SearchIndicator";
import { TelemetryBar } from "./TelemetryBar";

interface ChatMessageProps {
  message: Message;
  activeSearchQueries?: string[];
  isStreaming?: boolean;
}

export const ChatMessage: React.FC<ChatMessageProps> = ({
  message,
  activeSearchQueries,
  isStreaming,
}) => {
  const isUser = message.role === "user";
  const [highlightedSourceId, setHighlightedSourceId] = useState<number | null>(null);
  const [sourcesOpen, setSourcesOpen] = useState(true);

  const sources = message.citations || [];

  // Clean domain extraction
  const getDomain = (url: string) => {
    try {
      const parsed = new URL(url);
      return parsed.hostname.replace(/^www\./, "");
    } catch {
      return url;
    }
  };

  // Helper to render inline markdown (bold, italic, code, and [N] citation badges)
  const renderInline = (text: string, keyPrefix: string) => {
    // Matches: [1], `code`, **bold**, *italic*
    const parts = text.split(/(\[\d+\]|`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g);

    return parts.map((part, idx) => {
      const key = `${keyPrefix}-${idx}`;
      if (!part) return null;

      // 1. Citation badge [N]
      const citeMatch = part.match(/^\[(\d+)\]$/);
      if (citeMatch) {
        const citeId = parseInt(citeMatch[1], 10);
        const source = sources.find((s) => s.id === citeId);
        const isHovered = highlightedSourceId === citeId;

        return (
          <button
            key={key}
            type="button"
            onClick={() => {
              setHighlightedSourceId(citeId);
              setSourcesOpen(true);
              const el = document.getElementById(`source-card-${citeId}`);
              if (el) el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
            }}
            onMouseEnter={() => setHighlightedSourceId(citeId)}
            onMouseLeave={() => setHighlightedSourceId(null)}
            className={`inline-flex items-center justify-center px-1.5 py-0.5 mx-0.5 font-mono text-[11px] font-medium rounded transition-all select-none align-baseline ${
              isHovered
                ? "bg-amber-500 text-black border border-amber-400 scale-105 shadow-md shadow-amber-500/20"
                : "bg-[#18181B] hover:bg-[#27272A] text-zinc-300 border border-white/[0.12] hover:border-amber-500/60 shadow-keycap"
            }`}
            title={source ? `${source.title} (${source.url})` : `Source [${citeId}]`}
          >
            [{citeId}]
          </button>
        );
      }

      // 2. Inline code `code`
      if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) {
        return (
          <code
            key={key}
            className="font-mono text-[12px] px-1.5 py-0.5 mx-0.5 rounded bg-[#18181B] border border-white/[0.08] text-amber-300"
          >
            {part.slice(1, -1)}
          </code>
        );
      }

      // 3. Bold **bold**
      if (part.startsWith("**") && part.endsWith("**") && part.length >= 4) {
        return (
          <strong key={key} className="font-semibold text-zinc-100">
            {part.slice(2, -2)}
          </strong>
        );
      }

      // 4. Italic *italic*
      if (part.startsWith("*") && part.endsWith("*") && part.length >= 2) {
        return (
          <em key={key} className="italic text-zinc-300">
            {part.slice(1, -1)}
          </em>
        );
      }

      return <span key={key}>{part}</span>;
    });
  };

  // Render text with full markdown formatting and interactive [N] raised keycaps
  const renderFormattedContent = (content: string) => {
    if (isUser) {
      return (
        <p className="whitespace-pre-wrap text-[#EDEDED] font-normal leading-relaxed text-[14px]">
          {content}
        </p>
      );
    }

    const lines = content.split("\n");
    const blocks: React.ReactNode[] = [];
    let currentList: string[] = [];

    const flushList = (listIndex: number) => {
      if (currentList.length > 0) {
        blocks.push(
          <ul key={`ul-${listIndex}`} className="space-y-1.5 my-2 pl-1">
            {currentList.map((item, itemIdx) => (
              <li
                key={`li-${listIndex}-${itemIdx}`}
                className="flex items-start gap-2.5 text-[14.5px] leading-relaxed text-[#D4D4D8]"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 mt-2 shrink-0" />
                <div className="flex-1 min-w-0">
                  {renderInline(item, `item-${listIndex}-${itemIdx}`)}
                </div>
              </li>
            ))}
          </ul>
        );
        currentList = [];
      }
    };

    lines.forEach((line, idx) => {
      const trimmed = line.trim();

      // Check if bullet point (* or -)
      if (trimmed.startsWith("* ") || trimmed.startsWith("- ")) {
        currentList.push(trimmed.slice(2));
      } else {
        flushList(idx);

        if (!trimmed) {
          blocks.push(<div key={`space-${idx}`} className="h-1.5" />);
        } else if (trimmed.startsWith("### ")) {
          blocks.push(
            <h3 key={`h3-${idx}`} className="font-serif text-lg font-medium text-zinc-200 mt-3 mb-1">
              {renderInline(trimmed.slice(4), `h3-${idx}`)}
            </h3>
          );
        } else if (trimmed.startsWith("## ")) {
          blocks.push(
            <h2 key={`h2-${idx}`} className="font-serif text-xl font-medium text-zinc-100 mt-4 mb-1.5">
              {renderInline(trimmed.slice(3), `h2-${idx}`)}
            </h2>
          );
        } else {
          blocks.push(
            <p key={`p-${idx}`} className="text-[14.5px] leading-relaxed text-[#D4D4D8]">
              {renderInline(line, `p-${idx}`)}
            </p>
          );
        }
      }
    });

    flushList(lines.length);

    return <div className="space-y-1 font-sans">{blocks}</div>;
  };

  return (
    <div
      className={`transition-all rounded-xl ${
        isUser
          ? "ml-auto max-w-2xl bg-[#141416] border border-white/[0.07] p-4 text-left shadow-sm"
          : "bg-[#111113] border border-white/[0.07] p-5 shadow-card"
      }`}
    >
      {/* Header bar */}
      <div className="flex items-center justify-between pb-3 mb-3 border-b border-white/[0.06]">
        <div className="flex items-center gap-2.5">
          <div
            className={`w-6 h-6 rounded flex items-center justify-center text-xs ${
              isUser
                ? "bg-zinc-800 text-zinc-300 border border-white/[0.08]"
                : "bg-amber-500/10 text-amber-400 border border-amber-500/20"
            }`}
          >
            {isUser ? <User className="w-3.5 h-3.5" /> : <Bot className="w-3.5 h-3.5" />}
          </div>
          <span className="text-xs font-semibold uppercase tracking-wider text-zinc-300 font-mono">
            {isUser ? "Analyst" : "Chrono Synthesis"}
          </span>
          {!isUser && (
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" title="Grounded" />
          )}
        </div>

        {message.created_at_iso && (
          <span className="text-[11px] text-zinc-500 font-mono tracking-tight">
            {new Date(message.created_at_iso).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}{" "}
            IST
          </span>
        )}
      </div>

      {/* Live Parallel Search Indicator */}
      {!isUser && activeSearchQueries && activeSearchQueries.length > 0 && (
        <SearchIndicator queries={activeSearchQueries} />
      )}

      {/* Main Message Content */}
      <div className="relative">
        {renderFormattedContent(message.content)}
        {isStreaming && (
          <span className="inline-block w-1.5 h-4 ml-1 bg-amber-400 animate-pulse align-middle" />
        )}
      </div>

      {/* Grounded Sources Horizontal Strip */}
      {!isUser && sources.length > 0 && (
        <div className="mt-4 pt-3 border-t border-white/[0.06]">
          <div className="flex items-center justify-between mb-2">
            <button
              onClick={() => setSourcesOpen(!sourcesOpen)}
              className="inline-flex items-center gap-1.5 text-xs font-mono text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              <BookOpen className="w-3.5 h-3.5 text-amber-400 stroke-[2]" />
              <span className="uppercase tracking-wider">
                Corpus Evidence ({sources.length} {sources.length === 1 ? "source" : "sources"})
              </span>
              {sourcesOpen ? (
                <ChevronUp className="w-3 h-3 text-zinc-500" />
              ) : (
                <ChevronDown className="w-3 h-3 text-zinc-500" />
              )}
            </button>
          </div>

          {sourcesOpen && (
            <div className="flex gap-2.5 overflow-x-auto pb-2 pt-1 scrollbar-thin">
              {sources.map((src: Source) => {
                const isHighlighted = highlightedSourceId === src.id;
                return (
                  <div
                    key={src.id}
                    id={`source-card-${src.id}`}
                    onMouseEnter={() => setHighlightedSourceId(src.id)}
                    onMouseLeave={() => setHighlightedSourceId(null)}
                    className={`min-w-[240px] max-w-[280px] p-2.5 rounded-lg border transition-all text-left shrink-0 ${
                      isHighlighted
                        ? "bg-[#18181B] border-amber-500/70 ring-1 ring-amber-500/50 shadow-md"
                        : "bg-[#09090B] border-white/[0.07] hover:border-white/[0.15]"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1.5 mb-1.5">
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#18181B] text-amber-400 border border-white/[0.08] font-semibold">
                        [{src.id}]
                      </span>
                      <a
                        href={src.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-[11px] font-mono text-zinc-400 hover:text-amber-400 truncate hover:underline"
                        title={src.url}
                      >
                        <span className="truncate max-w-[140px]">{getDomain(src.url)}</span>
                        <ExternalLink className="w-3 h-3 shrink-0" />
                      </a>
                    </div>
                    <h4
                      className="text-xs font-medium text-zinc-200 line-clamp-1 mb-1 leading-snug"
                      title={src.title}
                    >
                      {src.title || "Web Reference"}
                    </h4>
                    <p className="text-[11px] text-zinc-400 line-clamp-2 leading-relaxed font-sans">
                      {src.snippet}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Telemetry Bar */}
      {!isUser && message.metrics && <TelemetryBar metrics={message.metrics} />}
    </div>
  );
};
