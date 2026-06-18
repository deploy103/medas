from datetime import UTC, datetime

from pydantic import BaseModel, ConfigDict, Field, field_serializer, field_validator


ALLOWED_SHARE_EXPIRY_HOURS = {1, 3, 5, 12, 24, 72, 120, 168, 336}


class UtcDateTimeModel(BaseModel):
    @field_serializer("*", when_used="json")
    def serialize_utc_datetime(self, value: object) -> object:
        if not isinstance(value, datetime):
            return value
        if value.tzinfo is None:
            value = value.replace(tzinfo=UTC)
        else:
            value = value.astimezone(UTC)
        return value.isoformat().replace("+00:00", "Z")


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=1, max_length=500)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    username: str


class ItemOut(UtcDateTimeModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    kind: str
    title: str
    url: str | None = None
    note: str | None = None
    tags: str | None = None
    original_filename: str | None = None
    parent_id: int | None = None
    relative_path: str | None = None
    mime_type: str | None = None
    size_bytes: int | None = None
    created_at: datetime
    updated_at: datetime | None = None


class ShareCreateRequest(BaseModel):
    item_ids: list[int] = Field(min_length=1, max_length=100)
    expires_hours: int

    @field_validator("item_ids")
    @classmethod
    def validate_item_ids(cls, value: list[int]) -> list[int]:
        if any(item_id <= 0 for item_id in value):
            raise ValueError("item_ids must contain positive ids")
        return value

    @field_validator("expires_hours")
    @classmethod
    def validate_expires_hours(cls, value: int) -> int:
        if value not in ALLOWED_SHARE_EXPIRY_HOURS:
            raise ValueError("unsupported share expiry")
        return value


class ShareFileOut(UtcDateTimeModel):
    id: int
    item_id: int
    title: str
    filename: str
    relative_path: str
    size_bytes: int
    mime_type: str | None = None
    uploaded_at: datetime
    download_count: int
    download_url: str


class ShareOut(UtcDateTimeModel):
    id: int
    token: str
    item_id: int
    title: str
    root_kind: str
    share_url: str
    download_count: int
    file_count: int
    total_size_bytes: int
    zip_size_bytes: int | None = None
    download_all_url: str
    files: list[ShareFileOut]
    created_at: datetime
    expires_at: datetime | None = None


class PublicShareOut(UtcDateTimeModel):
    token: str
    title: str
    root_kind: str
    file_count: int
    total_size_bytes: int
    zip_size_bytes: int | None = None
    files: list[ShareFileOut]
    shared_at: datetime
    expires_at: datetime | None = None
    download_count: int
    download_all_url: str


class StorageStatsOut(BaseModel):
    used_bytes: int
    quota_bytes: int
    remaining_bytes: int
    file_count: int
    disk_free_bytes: int


class HealthOut(BaseModel):
    ok: bool
    app: str
