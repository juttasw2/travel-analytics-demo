from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from uuid import uuid4
import logging

from services.upload_handler import verwerk_boekingen_excel, verwerk_vlucht_allotments_excel


logger = logging.getLogger(__name__)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class UploadJob:
    job_id: str
    filename: str
    size_bytes: int
    content_type: str
    file_path: str
    request_id: str
    upload_type: str = "boekingen"
    status: str = "queued"
    stage: str = "received"
    progress_percent: int = 5
    message: str = "Bestand succesvol ontvangen, verwerking gestart."
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    upload_id: str | None = None
    bookings_count: int = 0
    created_at: datetime = field(default_factory=_utc_now)
    updated_at: datetime = field(default_factory=_utc_now)
    started_at: datetime | None = None
    finished_at: datetime | None = None


class UploadJobQueue:
    def __init__(
        self,
        *,
        max_workers: int = 1,
        retention_seconds: int = 24 * 60 * 60,
        max_tracked_jobs: int = 500,
    ) -> None:
        self._executor = ThreadPoolExecutor(max_workers=max(1, max_workers), thread_name_prefix="upload-worker")
        self._retention_seconds = max(600, retention_seconds)
        self._max_tracked_jobs = max(100, max_tracked_jobs)
        self._jobs: dict[str, UploadJob] = {}
        self._lock = Lock()

    def submit(
        self,
        *,
        file_path: str,
        filename: str,
        size_bytes: int,
        content_type: str,
        request_id: str,
        upload_type: str,
    ) -> dict:
        now = _utc_now()
        job_id = f"job-{uuid4()}"
        job = UploadJob(
            job_id=job_id,
            filename=filename,
            size_bytes=size_bytes,
            content_type=content_type,
            file_path=file_path,
            request_id=request_id,
            upload_type=upload_type,
            created_at=now,
            updated_at=now,
        )
        with self._lock:
            self._cleanup_locked(now)
            self._jobs[job_id] = job

        self._executor.submit(self._run_job, job_id)
        return self.get(job_id)

    def get(self, job_id: str) -> dict | None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            return self._job_payload_locked(job)

    def _job_payload_locked(self, job: UploadJob) -> dict:
        queue_position: int | None = None
        if job.status == "queued":
            jobs_ahead = sum(
                1
                for existing in self._jobs.values()
                if existing.status == "queued" and existing.created_at < job.created_at
            )
            queue_position = jobs_ahead + 1

        return {
            "job_id": job.job_id,
            "status": job.status,
            "stage": job.stage,
            "progress_percent": job.progress_percent,
            "message": job.message,
            "errors": list(job.errors),
            "warnings": list(job.warnings),
            "filename": job.filename,
            "upload_type": job.upload_type,
            "size_bytes": job.size_bytes,
            "bookings_count": job.bookings_count,
            "upload_id": job.upload_id,
            "queue_position": queue_position,
            "created_at": job.created_at.isoformat(),
            "updated_at": job.updated_at.isoformat(),
            "started_at": job.started_at.isoformat() if job.started_at else None,
            "finished_at": job.finished_at.isoformat() if job.finished_at else None,
        }

    def _update_job(self, job_id: str, **changes: object) -> UploadJob | None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            for key, value in changes.items():
                setattr(job, key, value)
            job.updated_at = _utc_now()
            if job.status in {"completed", "failed"} and not job.finished_at:
                job.finished_at = _utc_now()
            return job

    def _run_job(self, job_id: str) -> None:
        started_at = _utc_now()
        job = self._update_job(
            job_id,
            status="processing",
            stage="importing",
            progress_percent=20,
            message="Import wordt verwerkt, dit kan even duren.",
            started_at=started_at,
        )
        if job is None:
            return

        try:
            file_bytes = Path(job.file_path).read_bytes()
            self._update_job(job_id, progress_percent=35, stage="parsing")
            if job.upload_type == "vlucht_allotments":
                result = verwerk_vlucht_allotments_excel(
                    file_bytes=file_bytes,
                    filename=job.filename,
                    size_bytes=job.size_bytes,
                    content_type=job.content_type,
                )
            else:
                result = verwerk_boekingen_excel(
                    file_bytes=file_bytes,
                    filename=job.filename,
                    size_bytes=job.size_bytes,
                    content_type=job.content_type,
                )

            if not result.success:
                self._update_job(
                    job_id,
                    status="failed",
                    stage="failed",
                    progress_percent=100,
                    message=result.message or "Import mislukt.",
                    errors=result.errors,
                    warnings=result.warnings,
                    upload_id=result.upload_id,
                    bookings_count=result.bookings_count,
                )
                return

            self._update_job(
                job_id,
                status="completed",
                stage="completed",
                progress_percent=100,
                message="Import voltooid.",
                errors=[],
                warnings=result.warnings,
                upload_id=result.upload_id,
                bookings_count=result.bookings_count,
            )
        except Exception:  # noqa: BLE001
            logger.exception("upload_job_id=%s processing exception", job_id)
            self._update_job(
                job_id,
                status="failed",
                stage="failed",
                progress_percent=100,
                message="Verwerking is mislukt door een serverfout.",
                errors=["Interne fout tijdens importverwerking."],
            )
        finally:
            try:
                path = Path(job.file_path)
                if path.exists():
                    path.unlink()
            except Exception:  # noqa: BLE001
                logger.warning("upload_job_id=%s temporary file cleanup failed", job_id)

    def _cleanup_locked(self, now: datetime) -> None:
        retention_cutoff = now.timestamp() - self._retention_seconds
        stale_ids = [
            job_id
            for job_id, job in self._jobs.items()
            if job.status in {"completed", "failed"} and job.updated_at.timestamp() < retention_cutoff
        ]
        for job_id in stale_ids:
            self._jobs.pop(job_id, None)

        if len(self._jobs) <= self._max_tracked_jobs:
            return
        sorted_jobs = sorted(self._jobs.values(), key=lambda j: j.created_at)
        overflow = len(self._jobs) - self._max_tracked_jobs
        for job in sorted_jobs[:overflow]:
            self._jobs.pop(job.job_id, None)
