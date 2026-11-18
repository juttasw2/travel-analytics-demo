from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Callable

from flask import Response, current_app, flash, jsonify, redirect, render_template, request, url_for

from services.supabase_service import SupabaseService, SupabaseServiceError
from services.upload_handler import validate_filename


def register_upload_routes(
    bp,
    *,
    upload_jobs,
    get_request_csrf_token: Callable[[], str],
    is_valid_csrf_token: Callable[[str], bool],
    logger,
) -> None:
    @bp.route("/upload", methods=["GET", "POST"])
    def upload() -> str | Response:
        """
        Uploadpagina:
        - GET: render de lege uploadpagina
        - POST: verwerk geüploade bestanden en toon resultaten
        """
        errors: list[str] = []
        uploads = []

        # Always try to show uploads list (also after errors).
        try:
            uploads = SupabaseService().list_uploads_overzicht(limit=100)
        except SupabaseServiceError as e:
            logger.exception("Uploadlijst ophalen mislukt: %s", e)
            errors.append("Kon uploads niet ophalen.")

        upload_max_size_mb = max(1, current_app.config.get("UPLOAD_MAX_SIZE_BYTES", 0) // (1024 * 1024))
        if request.method == "GET":
            preselect_upload_type = (request.args.get("upload_type") or "").strip().lower()
            if preselect_upload_type not in {"boekingen", "vlucht_allotments"}:
                preselect_upload_type = ""
            return render_template(
                "dashboard/upload.html",
                errors=errors,
                uploads=uploads,
                upload_max_size_mb=upload_max_size_mb,
                upload_status_url_template=url_for("dashboard.upload_status", job_id="__JOB_ID__"),
                preselect_upload_type=preselect_upload_type,
            )

        is_xhr = request.headers.get("X-Requested-With") == "XMLHttpRequest"
        request_id = request.headers.get("X-Upload-Request-Id") or "n/a"
        temp_path: Path | None = None
        try:
            file = request.files.get("file")
            upload_type = (request.form.get("upload_type") or request.headers.get("X-Upload-Type") or "").strip().lower()
            if upload_type not in {"boekingen", "vlucht_allotments"}:
                msg = "Kies eerst een uploadtype: Boekingen of Vlucht allotments."
                if is_xhr:
                    return jsonify({"success": False, "message": msg, "errors": [msg], "bookings_count": 0}), 400
                return render_template(
                    "dashboard/upload.html",
                    errors=[msg],
                    uploads=uploads,
                    upload_max_size_mb=upload_max_size_mb,
                    upload_status_url_template=url_for("dashboard.upload_status", job_id="__JOB_ID__"),
                    preselect_upload_type="",
                ), 400
            csrf_token = get_request_csrf_token()
            if not is_valid_csrf_token(csrf_token):
                msg = "Sessiebeveiliging mislukt. Vernieuw de pagina en probeer opnieuw."
                if is_xhr:
                    return jsonify({"success": False, "message": msg, "errors": [msg], "bookings_count": 0}), 400
                return render_template(
                    "dashboard/upload.html",
                    errors=[msg],
                    uploads=uploads,
                    upload_max_size_mb=upload_max_size_mb,
                    upload_status_url_template=url_for("dashboard.upload_status", job_id="__JOB_ID__"),
                ), 400
            if not file or not file.filename:
                msg = "Selecteer een .xlsx-bestand om te uploaden."
                if is_xhr:
                    return jsonify({"success": False, "message": msg, "errors": [msg], "bookings_count": 0}), 400
                return render_template(
                    "dashboard/upload.html",
                    errors=[msg],
                    uploads=uploads,
                    upload_max_size_mb=upload_max_size_mb,
                    upload_status_url_template=url_for("dashboard.upload_status", job_id="__JOB_ID__"),
                ), 400

            filename = file.filename
            content_type = (file.mimetype or file.content_type or "").split(";")[0].strip().lower()
            size_bytes = int(file.content_length or 0)
            if size_bytes <= 0:
                seek_pos = file.stream.tell()
                file.stream.seek(0, os.SEEK_END)
                size_bytes = int(file.stream.tell())
                file.stream.seek(seek_pos, os.SEEK_SET)

            filename_validation = validate_filename(filename, size_bytes, content_type=content_type)
            if not filename_validation.ok:
                msg = filename_validation.error or "Upload validatie mislukt."
                if is_xhr:
                    return jsonify({"success": False, "message": msg, "errors": [msg], "bookings_count": 0}), 400
                return render_template(
                    "dashboard/upload.html",
                    errors=[msg],
                    uploads=uploads,
                    upload_max_size_mb=upload_max_size_mb,
                    upload_status_url_template=url_for("dashboard.upload_status", job_id="__JOB_ID__"),
                ), 400

            tmp = tempfile.NamedTemporaryFile(prefix="upload-", suffix=".xlsx", delete=False)
            temp_path = Path(tmp.name)
            try:
                file.save(tmp)
            finally:
                tmp.close()

            job = upload_jobs.submit(
                file_path=str(temp_path),
                filename=filename,
                size_bytes=size_bytes,
                content_type=content_type,
                request_id=request_id,
                upload_type=upload_type,
            )
            logger.info(
                "upload_request_id=%s queued job_id=%s filename=%s size_bytes=%d",
                request_id,
                job["job_id"],
                filename,
                size_bytes,
            )
            if is_xhr:
                return (
                    jsonify(
                        {
                            "success": True,
                            "status": "accepted",
                            "message": "Bestand succesvol ontvangen, verwerking gestart.",
                            "job": job,
                        }
                    ),
                    202,
                )

            flash("Bestand succesvol ontvangen, verwerking gestart.", "success")
            return redirect(url_for("dashboard.upload"))
        except Exception:  # noqa: BLE001
            if temp_path and temp_path.exists():
                try:
                    temp_path.unlink()
                except Exception:  # noqa: BLE001
                    logger.warning("upload_request_id=%s cleanup temp file failed", request_id)
            logger.exception("upload_request_id=%s upload exception", request_id)
            if is_xhr:
                return (
                    jsonify(
                        {
                            "success": False,
                            "message": "Serverfout tijdens upload.",
                            "errors": ["Interne fout tijdens uploadverwerking."],
                            "bookings_count": 0,
                        }
                    ),
                    500,
                )
            return render_template(
                "dashboard/upload.html",
                errors=["Serverfout tijdens uploadverwerking."],
                uploads=uploads,
                upload_max_size_mb=upload_max_size_mb,
                upload_status_url_template=url_for("dashboard.upload_status", job_id="__JOB_ID__"),
            ), 500

    @bp.route("/upload/status/<job_id>", methods=["GET"])
    def upload_status(job_id: str) -> Response:
        payload = upload_jobs.get(job_id)
        if payload is None:
            return jsonify({"success": False, "message": "Uploadtaak niet gevonden."}), 404
        return jsonify({"success": True, "job": payload}), 200
