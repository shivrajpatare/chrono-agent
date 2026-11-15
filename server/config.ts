import path from "node:path";
import fs from "node:fs";
import dotenv from "dotenv";

// Load root .env
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

export interface AppConfig {
  groqApiKey: string;
  openaiBaseUrl: string;
  primaryModel: string;
  fallbackModel: string;
  fastBackupModel: string;
  modelPool: string[];
  tavilyApiKey: string;
  timezone: string;
  databasePath: string;
  port: number;
}

const dbPath = process.env.DATABASE_PATH || "data/chrono.db";
const resolvedDbPath = path.isAbsolute(dbPath)
  ? dbPath
  : path.resolve(process.cwd(), dbPath);

// Ensure directory for SQLite DB exists
const dbDir = path.dirname(resolvedDbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const primaryModel = process.env.PRIMARY_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct";
const fallbackModel = process.env.FALLBACK_MODEL || "llama-3.3-70b-versatile";
const fastBackupModel = process.env.FAST_BACKUP_MODEL || "openai/gpt-oss-20b";

export const config: AppConfig = {
  groqApiKey: process.env.GROQ_API_KEY || "",
  openaiBaseUrl: process.env.OPENAI_BASE_URL || "https://api.groq.com/openai/v1",
  primaryModel,
  fallbackModel,
  fastBackupModel,
  modelPool: Array.from(
    new Set([
      primaryModel,
      fallbackModel,
      "openai/gpt-oss-120b",
      "qwen/qwen3.8-27b",
      fastBackupModel,
      "openai/gpt-oss-20b",
    ])
  ),
  tavilyApiKey: process.env.TAVILY_API_KEY || "",
  timezone: process.env.TIMEZONE || "Asia/Kolkata",
  databasePath: resolvedDbPath,
  port: parseInt(process.env.PORT || "8000", 10),
};
