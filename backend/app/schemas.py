from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=1, max_length=500)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    username: str


class ItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    kind: str
    title: str
    url: str | None = None
    note: str | None = None
    tags: str | None = None
    original_filename: str | None = None
    mime_type: str | None = None
    size_bytes: int | None = None
    created_at: datetime
    updated_at: datetime | None = None


class ShareOut(BaseModel):
    id: int
    token: str
    item_id: int
    share_url: str
    download_count: int
    created_at: datetime
    expires_at: datetime | None = None


class PublicShareOut(BaseModel):
    token: str
    title: str
    filename: str
    size_bytes: int
    mime_type: str | None = None
    uploaded_at: datetime
    shared_at: datetime
    expires_at: datetime | None = None
    download_count: int
    download_url: str


class StorageStatsOut(BaseModel):
    used_bytes: int
    quota_bytes: int
    remaining_bytes: int
    file_count: int
    disk_free_bytes: int


class HealthOut(BaseModel):
    ok: bool
    app: str
