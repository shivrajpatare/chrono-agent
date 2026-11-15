import React, { useState, useEffect, useRef } from "react";
import {
  Send,
  Search,
  Brain,
  Menu,
  RotateCcw,
  Clock,
  ArrowUp,
  Cpu,
  Terminal,
  ShieldCheck,
  Compass,
} from "lucide-react";
import { Message, Session, Commitment, Source, TelemetryMetrics } from "./types";
import { ChatMessage } from "./components/ChatMessage";
import { MemorySidebar } from "./components/MemorySidebar";

export const App: React.FC = () => {
  const [sessionId, setSessionId] = useState<string>(() => `session-${crypto.randomUUID().substring(0, 8)}`);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputMessage, setInputMessage] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [activeSearchQueries, setActiveSearchQueries] = useState<string[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [commitments, setCommitments] = useState<Commitment[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [backendHealthy, setBackendHealthy] = useState<boolean | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto scroll to bottom
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, activeSearchQueries]);

  // Fetch initial data
  const fetchSessions = async () => {
    try {
      const res = await fetch("/api/sessions");
      if (res.ok) {
        const data = await res.json();
        setSessions(data);
      }
    } catch (e) {
      console.error("Failed to fetch sessions", e);
    }
  };

  const fetchCommitments = async () => {
    try {
      const res = await fetch("/api/commitments");
      if (res.ok) {
        const data = await res.json();
        setCommitments(data);
      }
    } catch (e) {
      console.error("Failed to fetch commitments", e);
    }
  };

  const checkHealth = async () => {
    try {
      const res = await fetch("/api/health");
      setBackendHealthy(res.ok);
    } catch {
      setBackendHealthy(false);
    }
  };

  useEffect(() => {
    fetchSessions();
    fetchCommitments();
    checkHealth();
  }, []);

  // Switch session
  const handleSelectSession = async (newSessionId: string) => {
    if (newSessionId === sessionId) return;
    setSessionId(newSessionId);
    setSidebarOpen(false);

    try {
      const res = await fetch(`/api/sessions/${newSessionId}/messages`);
      if (res.ok) {
        const data = await res.json();
        const mapped: Message[] = data.map((d: any) => ({
          id: d.id,
          session_id: d.session_id,
          role: d.role,
          content: d.content,
          created_at_iso: d.created_at_iso,
          citations: d.citations,
        }));
        setMessages(mapped);
      } else {
        setMessages([]);
      }
    } catch (e) {
      console.error("Failed to load session messages", e);
      setMessages([]);
    }
  };

  // Start new session
  const handleNewSession = () => {
    const newId = `session-${crypto.randomUUID().substring(0, 8)}`;
    setSessionId(newId);
    setMessages([]);
    setSidebarOpen(false);
    inputRef.current?.focus();
  };

  // Delete session
  const handleDeleteSession = async (targetSessionId: string) => {
    try {
      const res = await fetch(`/api/sessions/${targetSessionId}`, { method: "DELETE" });
      if (res.ok) {
        await fetchSessions();
        await fetchCommitments();
        if (targetSessionId === sessionId) {
          handleNewSession();
        }
      }
    } catch (e) {
      console.error("Failed to delete session", e);
    }
  };

  // Toggle commitment status
  const handleToggleCommitment = async (commitmentId: number, currentStatus: string) => {
    const newStatus = currentStatus === "active" ? "completed" : "active";
    try {
      const res = await fetch(`/api/commitments/${commitmentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      if (res.ok) {
        fetchCommitments();
      }
    } catch (e) {
      console.error("Failed to update commitment", e);
    }
  };

  // Send Chat Message via Streaming SSE
  const handleSendMessage = async (textToSend?: string) => {
    const query = (textToSend || inputMessage).trim();
    if (!query || isStreaming) return;

    setInputMessage("");
    setIsStreaming(true);
    setActiveSearchQueries([]);

    // Add user message to UI immediately
    const userMsg: Message = {
      session_id: sessionId,
      role: "user",
      content: query,
      created_at_iso: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);

    // Assistant placeholder message
    const initialAssistantMsg: Message = {
      session_id: sessionId,
      role: "assistant",
      content: "",
      created_at_iso: new Date().toISOString(),
      citations: [],
    };
    setMessages((prev) => [...prev, initialAssistantMsg]);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, message: query }),
      });

      if (!response.ok || !response.body) {
        throw new Error(`Server returned ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");

      let buffer = "";
      let accumulatedContent = "";
      let currentSources: Source[] = [];
      let currentMetrics: TelemetryMetrics | undefined;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Buffer partial chunks across \n\n boundaries
        const eventBlocks = buffer.split("\n\n");
        buffer = eventBlocks.pop() || "";

        for (const block of eventBlocks) {
          if (!block.trim()) continue;

          let eventType = "message";
          let dataStr = "";

          const lines = block.split("\n");
          for (const line of lines) {
            if (line.startsWith("event: ")) {
              eventType = line.substring(7).trim();
            } else if (line.startsWith("data: ")) {
              dataStr += line.substring(6);
            }
          }

          if (!dataStr) continue;

          try {
            const parsedData = JSON.parse(dataStr);

            if (eventType === "status") {
              if (parsedData.state === "searching") {
                setActiveSearchQueries(parsedData.queries || []);
              }
            } else if (eventType === "sources") {
              currentSources = parsedData;
              setActiveSearchQueries([]);
            } else if (eventType === "token") {
              if (parsedData.text) {
                accumulatedContent += parsedData.text;
                setMessages((prev) => {
                  const updated = [...prev];
                  const lastIdx = updated.length - 1;
                  if (lastIdx >= 0 && updated[lastIdx].role === "assistant") {
                    updated[lastIdx] = {
                      ...updated[lastIdx],
                      content: accumulatedContent,
                      citations: currentSources,
                    };
                  }
                  return updated;
                });
              }
            } else if (eventType === "metrics") {
              currentMetrics = parsedData;
              setActiveSearchQueries([]);
              setMessages((prev) => {
                const updated = [...prev];
                const lastIdx = updated.length - 1;
                if (lastIdx >= 0 && updated[lastIdx].role === "assistant") {
                  updated[lastIdx] = {
                    ...updated[lastIdx],
                    metrics: currentMetrics,
                    citations: currentSources,
                  };
                }
                return updated;
              });
            }
          } catch (err) {
            console.warn("Failed to parse SSE line JSON:", dataStr, err);
          }
        }
      }
    } catch (err: any) {
      console.error("Chat error:", err);
      setMessages((prev) => {
        const updated = [...prev];
        const lastIdx = updated.length - 1;
        if (lastIdx >= 0 && updated[lastIdx].role === "assistant") {
          updated[lastIdx] = {
            ...updated[lastIdx],
            content: `⚠️ Error communicating with agent: ${err.message}`,
          };
        }
        return updated;
      });
    } finally {
      setIsStreaming(false);
      setActiveSearchQueries([]);
      fetchSessions();
      fetchCommitments();
    }
  };

  // Editorial starter inquiries
  const quickStarters = [
    {
      category: "FRESH RESEARCH",
      icon: Search,
      prompt: "Search the web: What are the key new features in Python 3.13 and SQLite WAL mode?",
    },
    {
      category: "PARALLEL BENCHMARK",
      icon: Cpu,
      prompt: "Compare Groq LPU inference vs traditional GPU inference latency",
    },
    {
      category: "TEMPORAL COMMITMENT",
      icon: ShieldCheck,
      prompt: "Remind me to benchmark our FTS5 index tonight",
    },
    {
      category: "EPISODIC RECALL",
      icon: Clock,
      prompt: "What was the very first thing I asked you in this session?",
    },
  ];

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#09090B] text-[#EDEDED] font-sans">
      {/* 280px Left Rail */}
      <MemorySidebar
        currentSessionId={sessionId}
        sessions={sessions}
        commitments={commitments}
        onSelectSession={handleSelectSession}
        onNewSession={handleNewSession}
        onDeleteSession={handleDeleteSession}
        onToggleCommitment={handleToggleCommitment}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      {/* Main Workbench Canvas */}
      <main className="flex-1 flex flex-col h-full min-w-0 bg-[#09090B] relative">
        {/* Top Minimalist Header */}
        <header className="h-12 border-b border-white/[0.07] px-4 flex items-center justify-between bg-[#09090B]/90 backdrop-blur-md z-10 shrink-0">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setSidebarOpen(true)}
              className="lg:hidden p-1.5 rounded text-zinc-400 hover:text-zinc-100 hover:bg-[#18181B] transition-colors"
            >
              <Menu className="w-4 h-4" />
            </button>
            <div className="flex items-center gap-2 font-mono text-xs text-zinc-400 min-w-0">
              <span className="text-zinc-500 uppercase tracking-wider shrink-0">Workbench</span>
              <span className="text-zinc-600 shrink-0">/</span>
              <span className="text-zinc-200 truncate max-w-[180px] sm:max-w-xs" title={sessions.find(s => s.session_id === sessionId)?.title || sessionId}>
                {sessions.find(s => s.session_id === sessionId)?.title || sessionId.substring(0, 16)}
              </span>
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            <div className="hidden sm:flex items-center gap-2 px-2.5 py-1 rounded bg-[#111113] border border-white/[0.08] text-[11px] font-mono text-zinc-400">
              <span className={`w-1.5 h-1.5 rounded-full ${backendHealthy ? "bg-emerald-400" : "bg-amber-400"}`} />
              <span>GROQ ENGINE READY</span>
            </div>
            <button
              onClick={handleNewSession}
              className="p-1.5 rounded text-zinc-400 hover:text-zinc-200 hover:bg-[#18181B] transition-colors border border-transparent hover:border-white/[0.08]"
              title="Reset conversation (New Session)"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          </div>
        </header>

        {/* Research Reading & Chat Flow */}
        <div className="flex-1 overflow-y-auto px-4 sm:px-8 py-6 space-y-5 scrollbar-thin">
          {messages.length === 0 ? (
            /* Editorial Empty State */
            <div className="max-w-2xl mx-auto py-12 sm:py-20 text-center">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#111113] border border-white/[0.08] text-[11px] font-mono text-amber-400 mb-5">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                <span>CHRONO RESEARCH WORKBENCH</span>
              </div>

              <h1 className="font-serif text-3xl sm:text-4xl text-zinc-100 font-normal tracking-tight mb-3">
                Precision Temporal Research
              </h1>
              <p className="text-xs sm:text-sm text-zinc-400 max-w-md mx-auto mb-10 leading-relaxed font-sans">
                Strict single-tool architecture with deterministic SQLite temporal memory, verified inline citations, and promise tracking.
              </p>

              {/* 4 Minimal Starter Cards */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-left">
                {quickStarters.map((chip, idx) => {
                  const Icon = chip.icon;
                  return (
                    <button
                      key={idx}
                      onClick={() => handleSendMessage(chip.prompt)}
                      className="p-3.5 rounded-lg border border-white/[0.07] bg-[#111113] hover:bg-[#18181B] hover:border-amber-500/40 transition-all text-left group shadow-sm"
                    >
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="font-mono text-[10px] text-zinc-500 uppercase tracking-wider group-hover:text-amber-400 transition-colors flex items-center gap-1.5">
                          <Icon className="w-3 h-3 stroke-[2]" />
                          {chip.category}
                        </span>
                        <kbd className="font-mono text-[10px] text-zinc-600 bg-[#09090B] px-1 rounded border border-white/[0.06]">
                          ↵
                        </kbd>
                      </div>
                      <p className="text-xs text-zinc-300 font-sans leading-relaxed group-hover:text-white transition-colors">
                        {chip.prompt}
                      </p>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="max-w-3xl mx-auto space-y-4">
              {messages.map((msg, idx) => (
                <ChatMessage
                  key={idx}
                  message={msg}
                  activeSearchQueries={
                    idx === messages.length - 1 && isStreaming ? activeSearchQueries : undefined
                  }
                  isStreaming={idx === messages.length - 1 && isStreaming}
                />
              ))}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Floating Composer Area */}
        <div className="p-4 bg-gradient-to-t from-[#09090B] via-[#09090B] to-transparent shrink-0">
          <div className="max-w-3xl mx-auto relative rounded-xl border border-white/[0.08] bg-[#111113]/95 shadow-card backdrop-blur-md focus-within:border-amber-500/50 transition-all">
            <textarea
              ref={inputRef}
              rows={1}
              value={inputMessage}
              onChange={(e) => setInputMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSendMessage();
                }
              }}
              placeholder="Interrogate research corpus, recall past turns, or state a commitment ('I will...')..."
              className="w-full bg-transparent px-4 py-3.5 pr-20 text-sm text-[#EDEDED] placeholder-zinc-500 focus:outline-none resize-none max-h-32 min-h-[48px] font-sans"
            />

            <div className="absolute right-2.5 bottom-2.5 flex items-center gap-1.5">
              <kbd className="hidden sm:inline-block font-mono text-[10px] text-zinc-500 bg-[#18181B] px-1.5 py-1 rounded border border-white/[0.06]">
                ↵ Enter
              </kbd>
              <button
                type="button"
                onClick={() => handleSendMessage()}
                disabled={!inputMessage.trim() || isStreaming}
                className={`p-1.5 rounded transition-all ${
                  inputMessage.trim() && !isStreaming
                    ? "bg-[#EDEDED] text-[#09090B] hover:bg-white shadow-sm cursor-pointer"
                    : "bg-[#18181B] text-zinc-600 cursor-not-allowed border border-white/[0.06]"
                }`}
                title="Send inquiry"
              >
                <ArrowUp className="w-3.5 h-3.5 stroke-[2.5]" />
              </button>
            </div>
          </div>

          <div className="text-center mt-2 text-[10px] text-zinc-500 font-mono tracking-wide">
            IST (UTC+05:30) · GROQ LPU · SQLITE WAL FTS5 · PERSISTENT HTTP/2
          </div>
        </div>
      </main>
    </div>
  );
};
