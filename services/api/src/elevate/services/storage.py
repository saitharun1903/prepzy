"""Private file storage for uploaded resumes.

Backends:
  * ``local`` — files under ELEVATE_DATA_DIR/users/<user-id>/resumes (single machine / local profile).
  * ``s3``    — any S3-compatible store (Cloudflare R2, AWS S3, Backblaze B2, Tigris ...). Required
                in production because platform disks are ephemeral and not shared between the API
                and the worker. Objects are private; downloads stream through the authenticated API.
Object names are generated (``<32 hex>.bin``) and namespaced by owner; user input never forms a path.
"""

from __future__ import annotations

import re
import shutil
import uuid
from functools import lru_cache
from pathlib import Path
from typing import Any, Protocol

from ..config import get_settings
from ..errors import NotFound, ValidationFailed

_NAME = re.compile(r"[0-9a-f]{32}\.bin")


def _check(name: str) -> None:
    if not _NAME.fullmatch(name):
        raise ValidationFailed("Invalid storage reference")


class Storage(Protocol):
    def put(self, owner: uuid.UUID, name: str, data: bytes) -> None: ...
    def get(self, owner: uuid.UUID, name: str) -> bytes: ...
    def delete(self, owner: uuid.UUID, name: str) -> None: ...
    def delete_owner(self, owner: uuid.UUID) -> None: ...
    def health(self) -> dict[str, Any]: ...


class LocalStorage:
    def _dir(self, owner: uuid.UUID) -> Path:
        return get_settings().data_dir / "users" / str(owner) / "resumes"

    def put(self, owner: uuid.UUID, name: str, data: bytes) -> None:
        _check(name)
        d = self._dir(owner)
        d.mkdir(parents=True, exist_ok=True)
        (d / name).write_bytes(data)

    def get(self, owner: uuid.UUID, name: str) -> bytes:
        _check(name)
        p = self._dir(owner) / name
        if not p.exists():
            raise NotFound("The stored file is missing")
        return p.read_bytes()

    def delete(self, owner: uuid.UUID, name: str) -> None:
        _check(name)
        (self._dir(owner) / name).unlink(missing_ok=True)

    def delete_owner(self, owner: uuid.UUID) -> None:
        root = get_settings().data_dir.resolve()
        p = (get_settings().data_dir / "users" / str(owner)).resolve()
        if root in p.parents and p.exists():
            shutil.rmtree(p)

    def health(self) -> dict[str, Any]:
        return {"backend": "local", "ok": True}


class S3Storage:
    def __init__(self) -> None:
        import boto3
        from botocore.config import Config
        s = get_settings()
        self.bucket = s.s3_bucket
        self.client = boto3.client(
            "s3", endpoint_url=s.s3_endpoint_url or None, region_name=s.s3_region or None,
            aws_access_key_id=s.s3_access_key_id, aws_secret_access_key=s.s3_secret_access_key,
            config=Config(retries={"max_attempts": 3, "mode": "standard"}, connect_timeout=5, read_timeout=30,
                          signature_version="s3v4"))

    @staticmethod
    def _key(owner: uuid.UUID, name: str) -> str:
        _check(name)
        return f"users/{owner}/resumes/{name}"

    def put(self, owner: uuid.UUID, name: str, data: bytes) -> None:
        self.client.put_object(Bucket=self.bucket, Key=self._key(owner, name), Body=data,
                               ContentType="application/octet-stream")

    def get(self, owner: uuid.UUID, name: str) -> bytes:
        from botocore.exceptions import ClientError
        try:
            return self.client.get_object(Bucket=self.bucket, Key=self._key(owner, name))["Body"].read()
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") in ("NoSuchKey", "404"):
                raise NotFound("The stored file is missing") from e
            raise

    def delete(self, owner: uuid.UUID, name: str) -> None:
        self.client.delete_object(Bucket=self.bucket, Key=self._key(owner, name))

    def delete_owner(self, owner: uuid.UUID) -> None:
        prefix = f"users/{owner}/"
        paginator = self.client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Prefix=prefix):
            keys = [{"Key": o["Key"]} for o in page.get("Contents", [])]
            if keys:
                self.client.delete_objects(Bucket=self.bucket, Delete={"Objects": keys, "Quiet": True})

    def health(self) -> dict[str, Any]:
        from botocore.exceptions import BotoCoreError, ClientError
        try:
            self.client.head_bucket(Bucket=self.bucket)
            return {"backend": "s3", "ok": True}
        except (BotoCoreError, ClientError):
            return {"backend": "s3", "ok": False}


@lru_cache
def get_storage() -> Storage:
    return S3Storage() if get_settings().storage_backend == "s3" else LocalStorage()
