import React, { useState } from "react";
import {
  MessageSquare,
  Plus,
  Trash2,
  CheckSquare,
  Square,
  Clock,
  Sparkles,
  ChevronRight,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import { Session, Commitment } from "../types";

interface MemorySidebarProps {
  currentSessionId: string;
  sessions: Session[];
  commitments: Commitment[];
  onSelectSession: (sessionId: string) => void;
  onNewSession: () => void;
  onDeleteSession: (sessionId: string) => void;
  onToggleCommitment: (commitmentId: number, currentStatus: string) => void;
  isOpen: boolean;
  onClose: () => void;
}

export const MemorySidebar: React.FC<MemorySidebarProps> = ({
  currentSessionId,
  sessions,
  commitments,
  onSelectSession,
  onNewSession,
  onDeleteSession,
  onToggleCommitment,
  isOpen,
  onClose,
}) => {
  const [activeTab, setActiveTab] = useState<"sessions" | "promises">("sessions");

  // Relative age formatting
  const formatTimeAgo = (isoString?: string) => {
    if (!isoString) return "";
    const date = new Date(isoString);
    const diffSec = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
    if (diffSec < 60) return "just now";
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDays = Math.floor(diffHr / 24);
    return `${diffDays}d ago`;
  };

  const activeCommitments = commitments.filter((c) => c.status === "active");
  const completedCommitments = commitments.filter((c) => c.status === "completed");

  return (
    <>
      {/* Mobile Backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/70 backdrop-blur-sm z-40 lg:hidden"
          onClick={onClose}
        />
      )}

      {/* 280px Docked Sidebar */}
      <aside
        className={`fixed lg:static top-0 bottom-0 left-0 z-50 w-[280px] bg-[#111113] border-r border-white/[0.07] flex flex-col transition-transform duration-200 ease-in-out shrink-0 select-none ${
          isOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        }`}
      >
        {/* Workspace Node Header */}
        <div className="p-3.5 border-b border-white/[0.07] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            </span>
            <span className="font-mono text-xs font-semibold tracking-wider text-zinc-200 uppercase">
              Temporal Workbench
            </span>
          </div>
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#18181B] text-zinc-400 border border-white/[0.08]">
            v2.0
          </span>
        </div>

        {/* New Session Action */}
        <div className="p-3 border-b border-white/[0.07]">
          <button
            onClick={onNewSession}
            className="w-full flex items-center justify-between px-3 py-2 rounded bg-[#18181B] hover:bg-[#27272A] text-zinc-200 border border-white/[0.08] hover:border-amber-500/50 transition-all text-xs font-medium group shadow-keycap"
          >
            <div className="flex items-center gap-2">
              <Plus className="w-3.5 h-3.5 text-amber-400 stroke-[2]" />
              <span>New Inquiry</span>
            </div>
            <kbd className="font-mono text-[10px] text-zinc-500 bg-[#111113] px-1.5 py-0.5 rounded border border-white/[0.06] group-hover:text-amber-400">
              N
            </kbd>
          </button>
        </div>

        {/* Segmented Control */}
        <div className="p-2 border-b border-white/[0.07] bg-[#09090B]/40">
          <div className="flex rounded bg-[#09090B] p-0.5 border border-white/[0.06]">
            <button
              onClick={() => setActiveTab("sessions")}
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded text-xs font-medium transition-all ${
                activeTab === "sessions"
                  ? "bg-[#18181B] text-zinc-100 shadow-sm border border-white/[0.08]"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <MessageSquare className="w-3 h-3 stroke-[2]" />
              <span>Timeline</span>
              <span className="text-[10px] font-mono text-zinc-500">({sessions.length})</span>
            </button>

            <button
              onClick={() => setActiveTab("promises")}
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded text-xs font-medium transition-all ${
                activeTab === "promises"
                  ? "bg-[#18181B] text-zinc-100 shadow-sm border border-white/[0.08]"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <ShieldCheck className="w-3 h-3 text-amber-400 stroke-[2]" />
              <span>Commitments</span>
              {activeCommitments.length > 0 && (
                <span className="text-[10px] font-mono px-1 rounded bg-amber-500/10 text-amber-400 border border-amber-500/30">
                  {activeCommitments.length}
                </span>
              )}
            </button>
          </div>
        </div>

        {/* Tab Content Area */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1 scrollbar-thin">
          {activeTab === "sessions" ? (
            sessions.length === 0 ? (
              <div className="text-center py-12 text-zinc-500 text-xs">
                <Clock className="w-6 h-6 mx-auto mb-2 text-zinc-600 stroke-[1.5]" />
                <p>No prior sessions</p>
              </div>
            ) : (
              sessions.map((s) => {
                const isSelected = s.session_id === currentSessionId;
                return (
                  <div
                    key={s.session_id}
                    onClick={() => onSelectSession(s.session_id)}
                    className={`group relative flex items-center justify-between p-2.5 rounded border text-xs cursor-pointer transition-all ${
                      isSelected
                        ? "bg-[#18181B] border-amber-500/50 text-zinc-100 shadow-sm"
                        : "bg-transparent hover:bg-[#18181B]/60 border-transparent text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0 pr-6">
                      <span
                        className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                          isSelected ? "bg-amber-400" : "bg-zinc-600"
                        }`}
                      />
                      <div className="min-w-0">
                        <p className="truncate text-xs font-medium text-zinc-200" title={s.title || s.session_id}>
                          {s.title || `Session ${s.session_id.substring(0, 8)}`}
                        </p>
                        <div className="flex items-center gap-1.5 text-[10px] text-zinc-500 mt-0.5 font-mono">
                          <span>{s.message_count} turns</span>
                          <span>·</span>
                          <span>{formatTimeAgo(s.last_active)}</span>
                        </div>
                      </div>
                    </div>

                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteSession(s.session_id);
                      }}
                      className="opacity-0 group-hover:opacity-100 p-1 rounded text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-all shrink-0"
                      title="Delete session"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })
            )
          ) : (
            <div className="space-y-4 pt-1">
              {/* Active Commitments (Linear Style) */}
              <div>
                <div className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 px-1 mb-2 flex items-center justify-between">
                  <span>Tracked Promises</span>
                  <span className="text-amber-400">{activeCommitments.length} ACTIVE</span>
                </div>

                {activeCommitments.length === 0 ? (
                  <p className="text-xs text-zinc-500 px-2 py-4 text-center italic font-sans leading-relaxed">
                    Zero open commitments. Say "I will..." or "remind me to..." to auto-track.
                  </p>
                ) : (
                  <div className="space-y-1">
                    {activeCommitments.map((c) => (
                      <div
                        key={c.id}
                        onClick={() => onToggleCommitment(c.id, c.status)}
                        className="flex items-start gap-2.5 p-2 rounded bg-[#09090B] hover:bg-[#18181B] border border-white/[0.06] text-xs text-zinc-200 cursor-pointer transition-all group"
                      >
                        <Square className="w-3.5 h-3.5 shrink-0 text-zinc-500 group-hover:text-amber-400 mt-0.5" />
                        <div className="min-w-0 flex-1">
                          <p className="leading-snug text-zinc-300 font-sans">{c.commitment_text}</p>
                          <span className="text-[10px] text-zinc-500 font-mono mt-0.5 block">
                            {formatTimeAgo(c.detected_at_iso)}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Completed Commitments */}
              {completedCommitments.length > 0 && (
                <div className="pt-2 border-t border-white/[0.06]">
                  <div className="text-[10px] font-mono uppercase tracking-wider text-zinc-600 px-1 mb-1.5">
                    Resolved ({completedCommitments.length})
                  </div>
                  <div className="space-y-1">
                    {completedCommitments.map((c) => (
                      <div
                        key={c.id}
                        onClick={() => onToggleCommitment(c.id, c.status)}
                        className="flex items-start gap-2 p-1.5 rounded border border-transparent text-xs text-zinc-500 line-through cursor-pointer hover:bg-[#18181B]/40 transition-all"
                      >
                        <CheckSquare className="w-3.5 h-3.5 shrink-0 text-emerald-500 mt-0.5" />
                        <span className="leading-snug truncate font-sans">{c.commitment_text}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer status strip */}
        <div className="p-3 border-t border-white/[0.07] bg-[#09090B]/60 text-[10px] text-zinc-500 font-mono flex items-center justify-between">
          <span>IST · UTC+05:30</span>
          <span className="text-emerald-400 flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            WAL SYNC
          </span>
        </div>
      </aside>
    </>
  );
};
