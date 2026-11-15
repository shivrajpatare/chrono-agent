import os
from functools import lru_cache
from pathlib import Path
from typing import Optional
from zoneinfo import ZoneInfo
from pydantic_settings import BaseSettings, SettingsConfigDict

# Base backend directory
BACKEND_DIR = Path(__file__).resolve().parent.parent
WORKSPACE_DIR = BACKEND_DIR.parent

class Settings(BaseSettings):
    # LLM Settings
    PRIMARY_MODEL: str = "meta-llama/llama-4-scout-17b-16e-instruct"
    FALLBACK_MODEL: str = "llama-3.3-70b-versatile"
    FAST_BACKUP_MODEL: str = "openai/gpt-oss-20b"
    GROQ_API_KEY: str = ""
    OPENAI_BASE_URL: str = "https://api.groq.com/openai/v1"

    # Search Settings
    TAVILY_API_KEY: Optional[str] = None
    SEARCH_CACHE_TTL_SECONDS: int = 600
    MAX_SEARCH_SNIPPET_LENGTH: int = 350
    JACCARD_SIMILARITY_THRESHOLD: float = 0.75
    MAX_SEARCH_RESULTS_PER_QUERY: int = 3
    MAX_TOTAL_SEARCH_SOURCES: int = 8

    # Storage & Time Settings
    TIMEZONE: str = "Asia/Kolkata"
    DATABASE_PATH: str = "data/chrono.db"

    model_config = SettingsConfigDict(
        env_file=(
            str(BACKEND_DIR / ".env"),
            str(WORKSPACE_DIR / ".env"),
            ".env",
        ),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    def get_db_path(self) -> Path:
        """Resolve database path to an absolute path."""
        p = Path(self.DATABASE_PATH)
        if not p.is_absolute():
            p = BACKEND_DIR / p
        p.parent.mkdir(parents=True, exist_ok=True)
        return p

    def get_zone_info(self) -> ZoneInfo:
        """Resolve timezone safely."""
        try:
            return ZoneInfo(self.TIMEZONE)
        except Exception:
            return ZoneInfo("Asia/Kolkata")

@lru_cache()
def get_settings() -> Settings:
    """Return cached application settings singleton."""
    return Settings()

