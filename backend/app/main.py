from datetime import UTC, datetime, timedelta
import secrets
import shutil
import re
import zipfile
from urllib.parse import urlparse

from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Request, Response, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from .auth import create_access_token, get_current_user, verify_user
from .config import settings
from .database import Base, engine, get_db
from .models import Item, ShareItem, ShareLink
from .schemas import (
    HealthOut,
    ItemOut,
    LoginRequest,
    PublicShareOut,
    ShareCreateRequest,
    ShareFileOut,
    ShareOut,
    StorageStatsOut,
    TokenResponse,
)
from .storage import (
    UploadTooLargeError,
    delete_share_archive,
    delete_upload,
    ensure_storage_dirs,
    new_share_archive_name,
    save_upload,
    share_archive_path,
    upload_path,
)


app = FastAPI(title=settings.app_name)
TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{20,120}$")
CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")
ARCHIVE_DISK_RESERVE_BYTES = 1024 * 1024 * 1024
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


def migrate_database() -> None:
    with engine.begin() as connection:
        connection.exec_driver_sql(
            """
            CREATE TABLE IF NOT EXISTS share_items (
              id INTEGER PRIMARY KEY,
              share_id INTEGER NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
              item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
              download_count INTEGER NOT NULL DEFAULT 0,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        connection.exec_driver_sql("CREATE INDEX IF NOT EXISTS ix_share_items_share_id ON share_items(share_id)")
        connection.exec_driver_sql("CREATE INDEX IF NOT EXISTS ix_share_items_item_id ON share_items(item_id)")

        columns = {
            row[1]
            for row in connection.exec_driver_sql("PRAGMA table_info(share_links)").fetchall()
        }
        if "zip_stored_filename" not in columns:
            connection.exec_driver_sql("ALTER TABLE share_links ADD COLUMN zip_stored_filename TEXT")
        if "zip_size_bytes" not in columns:
            connection.exec_driver_sql("ALTER TABLE share_links ADD COLUMN zip_size_bytes INTEGER")

        connection.exec_driver_sql(
            """
            INSERT INTO share_items (share_id, item_id, download_count, created_at)
            SELECT share_links.id, share_links.item_id, 0, CURRENT_TIMESTAMP
            FROM share_links
            WHERE NOT EXISTS (
              SELECT 1 FROM share_items WHERE share_items.share_id = share_links.id
            )
            """
        )


@app.on_event("startup")
def startup() -> None:
    ensure_storage_dirs()
    Base.metadata.create_all(bind=engine)
    migrate_database()
    with Session(engine) as db:
        _cleanup_expired_share_archives(db)


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
    shares = {
        share.id: share
        for share in db.query(ShareLink).join(ShareItem).filter(ShareItem.item_id == item.id).all()
    }
    for share in db.query(ShareLink).filter(ShareLink.item_id == item.id).all():
        shares[share.id] = share
    for share in shares.values():
        delete_share_archive(share.zip_stored_filename)
        db.delete(share)
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


def _utc_now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _cleanup_expired_share_archives(db: Session) -> None:
    expired_shares = (
        db.query(ShareLink)
        .filter(ShareLink.expires_at.isnot(None))
        .filter(ShareLink.expires_at < _utc_now())
        .filter(ShareLink.zip_stored_filename.isnot(None))
        .all()
    )
    if not expired_shares:
        return
    for share in expired_shares:
        delete_share_archive(share.zip_stored_filename)
        share.zip_stored_filename = None
        share.zip_size_bytes = None
    db.commit()


def _validate_share_token(token: str) -> None:
    if not TOKEN_PATTERN.fullmatch(token):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="share not found")


def _get_live_share(token: str, db: Session) -> ShareLink:
    _validate_share_token(token)
    share = db.query(ShareLink).filter(ShareLink.token == token).first()
    if share is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="share not found")
    if share.expires_at is not None and share.expires_at < _utc_now():
        delete_share_archive(share.zip_stored_filename)
        share.zip_stored_filename = None
        share.zip_size_bytes = None
        db.commit()
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="share expired")
    return share


def _get_share_entries(share: ShareLink, db: Session) -> list[ShareItem]:
    entries = (
        db.query(ShareItem)
        .filter(ShareItem.share_id == share.id)
        .order_by(ShareItem.id.asc())
        .all()
    )
    if not entries and share.item_id:
        entry = ShareItem(share_id=share.id, item_id=share.item_id)
        db.add(entry)
        db.flush()
        entries = [entry]
    return entries


def _require_share_file(entry: ShareItem) -> Item:
    item = entry.item
    if item is None or item.kind != "file" or not item.stored_filename or not item.original_filename or item.size_bytes is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="shared file missing")
    return item


def _share_file_out(share: ShareLink, entry: ShareItem) -> ShareFileOut:
    item = _require_share_file(entry)
    return ShareFileOut(
        id=entry.id,
        item_id=item.id,
        title=item.title,
        filename=item.original_filename,
        size_bytes=item.size_bytes,
        mime_type=item.mime_type,
        uploaded_at=item.created_at,
        download_count=entry.download_count,
        download_url=f"{settings.public_base_url}/s/{share.token}/files/{entry.id}/download",
    )


def _share_files_out(share: ShareLink, db: Session) -> list[ShareFileOut]:
    return [_share_file_out(share, entry) for entry in _get_share_entries(share, db)]


def _public_share_out(share: ShareLink, db: Session) -> PublicShareOut:
    files = _share_files_out(share, db)
    return PublicShareOut(
        token=share.token,
        file_count=len(files),
        total_size_bytes=sum(file.size_bytes for file in files),
        zip_size_bytes=share.zip_size_bytes,
        files=files,
        shared_at=share.created_at,
        expires_at=share.expires_at,
        download_count=share.download_count,
        download_all_url=f"{settings.public_base_url}/s/{share.token}/download",
    )


def _private_share_out(share: ShareLink, db: Session) -> ShareOut:
    files = _share_files_out(share, db)
    return ShareOut(
        id=share.id,
        token=share.token,
        item_id=share.item_id,
        share_url=f"{settings.public_base_url}/s/{share.token}",
        download_count=share.download_count,
        file_count=len(files),
        total_size_bytes=sum(file.size_bytes for file in files),
        zip_size_bytes=share.zip_size_bytes,
        download_all_url=f"{settings.public_base_url}/s/{share.token}/download",
        files=files,
        created_at=share.created_at,
        expires_at=share.expires_at,
    )


def _safe_archive_member_name(filename: str, fallback: str) -> str:
    name = filename.replace("\\", "/").split("/")[-1]
    name = CONTROL_CHARS.sub("_", name).strip().strip(".")
    if not name:
        name = fallback
    if len(name) > 180:
        stem, dot, extension = name.rpartition(".")
        if dot and stem:
            suffix = f".{extension[:24]}"
            name = f"{stem[: max(1, 180 - len(suffix))]}{suffix}"
        else:
            name = name[:180]
    return name


def _unique_archive_member_name(name: str, used_names: set[str]) -> str:
    if name not in used_names:
        used_names.add(name)
        return name
    stem, dot, extension = name.rpartition(".")
    if not dot or not stem:
        stem = name
        extension = ""
    else:
        extension = f".{extension}"
    counter = 2
    while True:
        candidate = f"{stem} ({counter}){extension}"
        if candidate not in used_names:
            used_names.add(candidate)
            return candidate
        counter += 1


def _assert_archive_disk_space(items: list[Item]) -> None:
    total_bytes = sum(item.size_bytes or 0 for item in items)
    disk = shutil.disk_usage(settings.share_dir)
    if disk.free < total_bytes + ARCHIVE_DISK_RESERVE_BYTES:
        raise HTTPException(status_code=507, detail="not enough server disk space to create share archive")


def _build_share_archive(share: ShareLink, db: Session) -> None:
    entries = _get_share_entries(share, db)
    items = [_require_share_file(entry) for entry in entries]
    _assert_archive_disk_space(items)

    archive_name = new_share_archive_name()
    archive_path = share_archive_path(archive_name)
    temp_path = archive_path.with_suffix(".tmp")
    used_names: set[str] = set()

    try:
        with zipfile.ZipFile(temp_path, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
            for entry, item in zip(entries, items):
                source_path = upload_path(item.stored_filename or "")
                if not source_path.exists() or not source_path.is_file():
                    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="stored file missing")
                fallback = f"file-{entry.id}"
                member_name = _safe_archive_member_name(item.original_filename or fallback, fallback)
                archive.write(source_path, _unique_archive_member_name(member_name, used_names))
        temp_path.replace(archive_path)
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise

    delete_share_archive(share.zip_stored_filename)
    share.zip_stored_filename = archive_name
    share.zip_size_bytes = archive_path.stat().st_size


def _create_share_for_items(item_ids: list[int], expires_at: datetime, db: Session) -> ShareOut:
    ordered_ids = list(dict.fromkeys(item_ids))
    items = db.query(Item).filter(Item.id.in_(ordered_ids)).all()
    items_by_id = {item.id: item for item in items}
    if len(items_by_id) != len(ordered_ids):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="file item not found")

    ordered_items = [items_by_id[item_id] for item_id in ordered_ids]
    for item in ordered_items:
        if item.kind != "file" or not item.stored_filename or not item.original_filename or item.size_bytes is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="file item not found")

    share = ShareLink(
        token=secrets.token_urlsafe(32),
        item_id=ordered_items[0].id,
        expires_at=expires_at,
    )
    share.entries = [ShareItem(item=item) for item in ordered_items]
    db.add(share)
    db.flush()
    _build_share_archive(share, db)
    db.commit()
    db.refresh(share)
    return _private_share_out(share, db)


@app.post("/api/shares", response_model=ShareOut)
def create_multi_share(
    payload: ShareCreateRequest,
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
) -> ShareOut:
    _cleanup_expired_share_archives(db)
    return _create_share_for_items(payload.item_ids, _utc_now() + timedelta(hours=payload.expires_hours), db)


@app.post("/api/items/{item_id}/shares", response_model=ShareOut)
def create_share(
    item_id: int,
    expires_days: int = Query(default=7, ge=1, le=365),
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
) -> ShareOut:
    _cleanup_expired_share_archives(db)
    return _create_share_for_items([item_id], _utc_now() + timedelta(days=expires_days), db)


@app.get("/api/shares", response_model=list[ShareOut])
def list_shares(
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
) -> list[ShareOut]:
    _cleanup_expired_share_archives(db)
    shares = db.query(ShareLink).order_by(ShareLink.created_at.desc()).all()
    return [_private_share_out(share, db) for share in shares]


@app.delete("/api/shares/{share_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_share(
    share_id: int,
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
) -> None:
    share = db.get(ShareLink, share_id)
    if share is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="share not found")
    delete_share_archive(share.zip_stored_filename)
    db.delete(share)
    db.commit()


@app.get("/api/public/shares/{token}", response_model=PublicShareOut)
def public_share_metadata(token: str, db: Session = Depends(get_db)) -> PublicShareOut:
    return _public_share_out(_get_live_share(token, db), db)


@app.get("/s/{token}/download")
def public_share_archive_download(token: str, db: Session = Depends(get_db)) -> FileResponse:
    share = _get_live_share(token, db)
    if not share.zip_stored_filename or not share_archive_path(share.zip_stored_filename).exists():
        _build_share_archive(share, db)
    path = share_archive_path(share.zip_stored_filename or "")
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="share archive missing")
    share.download_count += 1
    db.commit()
    return FileResponse(
        path,
        media_type="application/zip",
        filename=f"medas-share-{share.created_at:%Y%m%d-%H%M}.zip",
        headers=PUBLIC_DOWNLOAD_HEADERS,
    )


@app.get("/s/{token}/files/{share_file_id}/download")
def public_share_file_download(
    token: str,
    share_file_id: int,
    db: Session = Depends(get_db),
) -> FileResponse:
    share = _get_live_share(token, db)
    entry = (
        db.query(ShareItem)
        .filter(ShareItem.share_id == share.id)
        .filter(ShareItem.id == share_file_id)
        .first()
    )
    if entry is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="shared file missing")
    item = _require_share_file(entry)
    path = upload_path(item.stored_filename or "")
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="stored file missing")
    entry.download_count += 1
    db.commit()
    return FileResponse(
        path,
        media_type="application/octet-stream",
        filename=item.original_filename,
        headers=PUBLIC_DOWNLOAD_HEADERS,
    )
