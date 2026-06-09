from dataclasses import dataclass
import os
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class Settings:
    app_name: str = "Personal Vault"
    storage_dir: Path = Path(os.getenv("VAULT_STORAGE_DIR", ROOT_DIR / "storage"))
    jwt_secret: str = os.getenv("VAULT_SECRET_KEY", "change-this-local-dev-secret")
    jwt_algorithm: str = "HS256"
    access_token_minutes: int = int(os.getenv("VAULT_ACCESS_TOKEN_MINUTES", "720"))
    public_base_url: str = os.getenv("VAULT_PUBLIC_BASE_URL", "http://localhost:8000")
    cors_origin: str = os.getenv("VAULT_CORS_ORIGIN", "http://localhost:5173")
    storage_quota_bytes: int = int(os.getenv("VAULT_STORAGE_QUOTA_BYTES", str(50 * 1024 * 1024 * 1024)))
    max_upload_bytes: int = int(os.getenv("VAULT_MAX_UPLOAD_BYTES", str(512 * 1024 * 1024)))

    @property
    def upload_dir(self) -> Path:
        return self.storage_dir / "uploads"

    @property
    def share_dir(self) -> Path:
        return self.storage_dir / "shares"

    @property
    def database_url(self) -> str:
        return os.getenv("VAULT_DATABASE_URL", f"sqlite:///{self.storage_dir / 'vault.db'}")


settings = Settings()
