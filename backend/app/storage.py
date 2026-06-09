from pathlib import Path
import uuid

from fastapi import UploadFile

from .config import settings


class UploadTooLargeError(Exception):
    pass


def ensure_storage_dirs() -> None:
    settings.storage_dir.mkdir(parents=True, exist_ok=True)
    settings.upload_dir.mkdir(parents=True, exist_ok=True)
    settings.share_dir.mkdir(parents=True, exist_ok=True)


async def save_upload(upload: UploadFile, max_bytes: int | None = None) -> tuple[str, str, int]:
    ensure_storage_dirs()
    original_name = upload.filename or "upload.bin"
    extension = Path(original_name).suffix[:32]
    stored_name = f"{uuid.uuid4().hex}{extension}"
    target = settings.upload_dir / stored_name
    size = 0

    with target.open("wb") as out_file:
        while chunk := await upload.read(1024 * 1024):
            size += len(chunk)
            if max_bytes is not None and size > max_bytes:
                out_file.close()
                target.unlink(missing_ok=True)
                raise UploadTooLargeError
            out_file.write(chunk)

    return original_name, stored_name, size


def upload_path(stored_name: str) -> Path:
    return settings.upload_dir / stored_name


def new_share_archive_name() -> str:
    return f"{uuid.uuid4().hex}.zip"


def share_archive_path(stored_name: str) -> Path:
    return settings.share_dir / stored_name


def delete_upload(stored_name: str | None) -> None:
    if not stored_name:
        return
    path = upload_path(stored_name)
    if path.exists() and path.is_file():
        path.unlink()


def delete_share_archive(stored_name: str | None) -> None:
    if not stored_name:
        return
    path = share_archive_path(stored_name)
    if path.exists() and path.is_file():
        path.unlink()
