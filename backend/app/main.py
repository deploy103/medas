from datetime import datetime, timedelta
import secrets
import shutil
import re
from urllib.parse import urlparse

from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Request, Response, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from .auth import create_access_token, get_current_user, verify_user
from .config import settings
from .database import Base, engine, get_db
from .models import Item, ShareLink
from .schemas import HealthOut, ItemOut, LoginRequest, PublicShareOut, ShareOut, StorageStatsOut, TokenResponse
from .storage import UploadTooLargeError, delete_upload, ensure_storage_dirs, save_upload, upload_path


app = FastAPI(title=settings.app_name)
TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{20,120}$")
PUBLIC_DOWNLOAD_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
}

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.cors_origin],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def add_security_headers(request: Request, call_next) -> Response:
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
    return response


@app.on_event("startup")
def startup() -> None:
    ensure_storage_dirs()
    Base.metadata.create_all(bind=engine)


@app.get("/api/health", response_model=HealthOut)
def health() -> HealthOut:
    return HealthOut(ok=True, app=settings.app_name)


@app.post("/api/auth/login", response_model=TokenResponse)
def login(payload: LoginRequest, db: Session = Depends(get_db)) -> TokenResponse:
    if not verify_user(db, payload.username, payload.password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid credentials")
    return TokenResponse(access_token=create_access_token(payload.username), username=payload.username)


def _used_file_bytes(db: Session) -> int:
    used = db.query(func.coalesce(func.sum(Item.size_bytes), 0)).filter(Item.kind == "file").scalar()
    return int(used or 0)


@app.get("/api/storage", response_model=StorageStatsOut)
def storage_stats(
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
) -> StorageStatsOut:
    used_bytes = _used_file_bytes(db)
    quota_bytes = settings.storage_quota_bytes
    disk = shutil.disk_usage(settings.storage_dir)
    return StorageStatsOut(
        used_bytes=used_bytes,
        quota_bytes=quota_bytes,
        remaining_bytes=max(quota_bytes - used_bytes, 0),
        file_count=db.query(Item).filter(Item.kind == "file").count(),
        disk_free_bytes=disk.free,
    )


@app.get("/api/items", response_model=list[ItemOut])
def list_items(
    kind: str = "all",
    q: str = "",
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
) -> list[Item]:
    query = db.query(Item)
    if kind != "all":
        query = query.filter(Item.kind == kind)
    if q:
        like = f"%{q}%"
        query = query.filter(
            or_(
                Item.title.ilike(like),
                Item.url.ilike(like),
                Item.note.ilike(like),
                Item.tags.ilike(like),
                Item.original_filename.ilike(like),
            )
        )
    return query.order_by(Item.created_at.desc()).all()


@app.post("/api/items", response_model=ItemOut)
async def create_item(
    kind: str = Form(...),
    title: str = Form(...),
    url: str | None = Form(None),
    note: str | None = Form(None),
    tags: str | None = Form(None),
    file: UploadFile | None = File(None),
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
) -> Item:
    if kind not in {"file", "link", "note"}:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="kind must be file, link, or note")
    title = title.strip()
    if not title or len(title) > 240:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="title must be 1-240 characters")
    if url:
        url = url.strip()
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="url must start with http:// or https://")
    if note:
        note = note.strip()[:5000]
    if tags:
        tags = tags.strip()[:500]
    if kind == "link" and not url:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="link item requires url")
    if kind == "file" and file is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="file item requires upload")

    original_filename = stored_filename = mime_type = None
    size_bytes = None
    if kind == "file" and file is not None:
        remaining_quota = max(settings.storage_quota_bytes - _used_file_bytes(db), 0)
        upload_limit = min(settings.max_upload_bytes, remaining_quota)
        if upload_limit <= 0:
            raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="storage quota exceeded")
        try:
            original_filename, stored_filename, size_bytes = await save_upload(file, upload_limit)
        except UploadTooLargeError as exc:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail="file is larger than the remaining storage quota or upload limit",
            ) from exc
        mime_type = file.content_type

    item = Item(
        kind=kind,
        title=title,
        url=url,
        note=note,
        tags=tags,
        original_filename=original_filename,
        stored_filename=stored_filename,
        mime_type=mime_type,
        size_bytes=size_bytes,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@app.delete("/api/items/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_item(
    item_id: int,
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
) -> None:
    item = db.get(Item, item_id)
    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="item not found")
    delete_upload(item.stored_filename)
    db.delete(item)
    db.commit()


@app.get("/api/items/{item_id}/download")
def download_item(
    item_id: int,
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
) -> FileResponse:
    item = db.get(Item, item_id)
    if item is None or item.kind != "file" or not item.stored_filename:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="file not found")
    path = upload_path(item.stored_filename)
    if not path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="stored file missing")
    return FileResponse(path, media_type=item.mime_type, filename=item.original_filename)


def _share_out(share: ShareLink) -> ShareOut:
    return ShareOut(
        id=share.id,
        token=share.token,
        item_id=share.item_id,
        share_url=f"{settings.public_base_url}/s/{share.token}",
        download_count=share.download_count,
        created_at=share.created_at,
        expires_at=share.expires_at,
    )


def _utc_now() -> datetime:
    return datetime.utcnow()


def _validate_share_token(token: str) -> None:
    if not TOKEN_PATTERN.fullmatch(token):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="share not found")


def _get_live_share(token: str, db: Session) -> ShareLink:
    _validate_share_token(token)
    share = db.query(ShareLink).filter(ShareLink.token == token).first()
    if share is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="share not found")
    if share.expires_at is not None and share.expires_at < _utc_now():
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="share expired")
    return share


def _public_share_out(share: ShareLink) -> PublicShareOut:
    item = share.item
    if item.kind != "file" or not item.stored_filename or not item.original_filename or item.size_bytes is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="shared file missing")
    return PublicShareOut(
        token=share.token,
        title=item.title,
        filename=item.original_filename,
        size_bytes=item.size_bytes,
        mime_type=item.mime_type,
        uploaded_at=item.created_at,
        shared_at=share.created_at,
        expires_at=share.expires_at,
        download_count=share.download_count,
        download_url=f"{settings.public_base_url}/s/{share.token}/download",
    )


@app.post("/api/items/{item_id}/shares", response_model=ShareOut)
def create_share(
    item_id: int,
    expires_days: int = Query(default=7, ge=1, le=365),
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
) -> ShareOut:
    item = db.get(Item, item_id)
    if item is None or item.kind != "file" or not item.stored_filename:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="file item not found")
    share = ShareLink(
        token=secrets.token_urlsafe(32),
        item_id=item.id,
        expires_at=_utc_now() + timedelta(days=expires_days),
    )
    db.add(share)
    db.commit()
    db.refresh(share)
    return _share_out(share)


@app.get("/api/shares", response_model=list[ShareOut])
def list_shares(
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
) -> list[ShareOut]:
    shares = db.query(ShareLink).order_by(ShareLink.created_at.desc()).all()
    return [_share_out(share) for share in shares]


@app.delete("/api/shares/{share_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_share(
    share_id: int,
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
) -> None:
    share = db.get(ShareLink, share_id)
    if share is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="share not found")
    db.delete(share)
    db.commit()


@app.get("/api/public/shares/{token}", response_model=PublicShareOut)
def public_share_metadata(token: str, db: Session = Depends(get_db)) -> PublicShareOut:
    return _public_share_out(_get_live_share(token, db))


@app.get("/s/{token}/download")
def public_share_download(token: str, db: Session = Depends(get_db)) -> FileResponse:
    share = _get_live_share(token, db)
    item = share.item
    if item.kind != "file" or not item.stored_filename or not item.original_filename:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="shared file missing")
    path = upload_path(item.stored_filename)
    if not path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="stored file missing")
    share.download_count += 1
    db.commit()
    return FileResponse(
        path,
        media_type="application/octet-stream",
        filename=item.original_filename,
        headers=PUBLIC_DOWNLOAD_HEADERS,
    )
