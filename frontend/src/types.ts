export interface Source {
  id: number;
  title: string;
  url: string;
  snippet: string;
}

export interface TelemetryMetrics {
  ttft_ms: number;
  first_token_ms?: number;
  search_ms: number;
  total_ms: number;
  search_count: number;
  memory_hits: number;
  citation_count: number;
  model_used: string;
  provider: string;
}

export interface Message {
  id?: number;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  created_at_iso?: string;
  citations?: Source[];
  metrics?: TelemetryMetrics;
}

export interface Session {
  session_id: string;
  title?: string;
  last_active: string;
  message_count: number;
}

export interface Commitment {
  id: number;
  session_id: string;
  commitment_text: string;
  detected_at_iso: string;
  status: "active" | "completed" | "dismissed";
}

export interface SearchStatus {
  state: "idle" | "searching";
  queries: string[];
}

