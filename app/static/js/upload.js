document.addEventListener("DOMContentLoaded", () => {
  const dropzone = document.getElementById("upload-dropzone");
  const fileInput = document.getElementById("file-input");
  const form = document.getElementById("upload-form");
  const uploadTypeInput = document.getElementById("upload-type-input");
  const csrfInput = form ? form.querySelector('input[name="csrf_token"]') : null;
  const statusUrlTemplate = (form && form.dataset && form.dataset.uploadStatusUrlTemplate) || "";

  const progressContainer = document.getElementById("upload-progress");
  const progressBar = document.getElementById("upload-progress-bar");
  const progressText = document.getElementById("upload-progress-text");
  const feedbackEl = document.getElementById("upload-feedback");
  const btnOpenUploadFlow = document.getElementById("btnOpenUploadFlow");
  const modalEl = document.getElementById("uploadExcelModal");
  const uploadModalTitel = document.getElementById("uploadModalTitel");
  const uploadStapIndicator = document.getElementById("uploadStapIndicator");
  const uploadStapType = document.getElementById("uploadStapType");
  const uploadStapBestand = document.getElementById("uploadStapBestand");
  const uploadStapVerwerken = document.getElementById("uploadStapVerwerken");
  const uploadBestandTitel = document.getElementById("uploadBestandTitel");
  const uploadFlowAllotmentInfo = document.getElementById("uploadFlowAllotmentInfo");
  const uploadFlowFileInput = document.getElementById("uploadFlowFileInput");
  const uploadFlowFileNaam = document.getElementById("uploadFlowFileNaam");
  const uploadTypeBevestiging = document.getElementById("uploadTypeBevestiging");
  const uploadBestandBevestiging = document.getElementById("uploadBestandBevestiging");
  const btnUploadTerug = document.getElementById("btnUploadTerug");
  const btnUploadVolgende = document.getElementById("btnUploadVolgende");
  const btnUploadVerwerken = document.getElementById("btnUploadVerwerken");

  if (!dropzone || !fileInput || !form) {
    return;
  }
  if (form.dataset.uploadInitialized === "1") {
    return;
  }
  form.dataset.uploadInitialized = "1";
  let isUploading = false;
  let geselecteerdType = (window.__UPLOAD_PRESELECT_TYPE__ || "").trim();
  let geselecteerdBestand = null;
  let stap = 1;
  let activePollJobId = null;
  let pollTimerId = null;
  const STATUS_POLL_INTERVAL_MS = 2000;

  const setActive = (active) => {
    if (active) {
      dropzone.classList.add("upload-dropzone-active");
    } else {
      dropzone.classList.remove("upload-dropzone-active");
    }
  };

  const setProgress = (percent, text) => {
    if (!progressContainer || !progressBar || !progressText) return;
    progressContainer.classList.remove("d-none");
    progressBar.style.width = `${percent}%`;
    progressBar.setAttribute("aria-valuenow", `${percent}`);
    progressText.textContent = text || "";
  };

  const setFeedback = (kind, message, errors) => {
    if (!feedbackEl) return;

    const safeMessage = message ? String(message) : "";
    const errorsHtml = Array.isArray(errors) && errors.length > 0
      ? `<ul class="mb-0">${errors.map((e) => `<li>${String(e)}</li>`).join("")}</ul>`
      : "";
    const alertClass = kind === "success" ? "alert-success" : kind === "error" ? "alert-danger" : "alert-info";

    const html = `<div class="alert ${alertClass} mb-0">${safeMessage}${errorsHtml}</div>`;

    feedbackEl.style.display = "block";
    feedbackEl.innerHTML = html;
  };

  const setUiBusy = (busy) => {
    isUploading = busy;
    fileInput.disabled = busy;
    dropzone.style.pointerEvents = busy ? "none" : "auto";
    dropzone.setAttribute("aria-disabled", busy ? "true" : "false");
    form.classList.toggle("opacity-75", busy);
  };

  const stopPolling = () => {
    activePollJobId = null;
    if (pollTimerId) {
      window.clearTimeout(pollTimerId);
      pollTimerId = null;
    }
  };

  const pollStatus = async (jobId, csrfToken) => {
    if (!jobId || !statusUrlTemplate || !statusUrlTemplate.includes("__JOB_ID__")) {
      setFeedback("error", "Upload gestart, maar statuscontrole ontbreekt in de configuratie.", []);
      setUiBusy(false);
      return;
    }
    activePollJobId = jobId;
    const statusUrl = statusUrlTemplate.replace("__JOB_ID__", encodeURIComponent(jobId));

    const tick = async () => {
      if (activePollJobId !== jobId) return;
      try {
        const response = await fetch(statusUrl, {
          method: "GET",
          headers: {
            "X-Requested-With": "XMLHttpRequest",
            ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
          },
        });
        const payload = await response.json();
        if (!response.ok || !payload || !payload.success || !payload.job) {
          throw new Error("status-endpoint gaf geen geldige response");
        }

        const job = payload.job;
        const progress = Number.isFinite(job.progress_percent) ? Math.max(0, Math.min(100, job.progress_percent)) : 0;
        const defaultText = job.status === "queued"
          ? "Bestand ontvangen, wachtrij gestart."
          : "Import wordt verwerkt, dit kan even duren.";
        setProgress(progress, job.message || defaultText);

        if (job.status === "completed") {
          setFeedback("success", job.message || "Import voltooid.", job.warnings || []);
          setUiBusy(false);
          stopPolling();
          return;
        }
        if (job.status === "failed") {
          setFeedback("error", job.message || "Import mislukt.", job.errors || []);
          setUiBusy(false);
          stopPolling();
          return;
        }

        setFeedback(
          "info",
          job.message || (job.status === "queued"
            ? "Bestand succesvol ontvangen, verwerking gestart."
            : "Import wordt verwerkt, dit kan even duren"),
          []
        );
      } catch (error) {
        setFeedback("error", "Kon uploadstatus niet ophalen. Ververs de pagina om de laatste status te bekijken.", []);
        setUiBusy(false);
        stopPolling();
        return;
      }
      pollTimerId = window.setTimeout(tick, STATUS_POLL_INTERVAL_MS);
    };

    pollTimerId = window.setTimeout(tick, STATUS_POLL_INTERVAL_MS);
    await tick();
  };

  const uploadFile = async (file, uploadType) => {
    if (!file || isUploading) return;
    if (!uploadType) {
      setFeedback("error", "Kies eerst een uploadtype.", []);
      return;
    }

    // Basic client-side validation.
    const lowerName = file.name.toLowerCase();
    if (!lowerName.endsWith(".xlsx")) {
      setFeedback("error", "Ongeldig bestandstype. Alleen .xlsx-bestanden zijn toegestaan.", []);
      return;
    }

    stopPolling();
    setFeedback("info", "Upload gestart...", []);
    setProgress(10, "Bestand wordt geupload...");
    setUiBusy(true);
    const requestId =
      (window.crypto && typeof window.crypto.randomUUID === "function" && window.crypto.randomUUID()) ||
      `upload-${Date.now()}`;

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 180000);
    const formData = new FormData();
    formData.append("file", file);
    formData.append("upload_type", uploadType);
    const csrfToken = (csrfInput && csrfInput.value ? String(csrfInput.value) : "").trim();
    if (csrfToken) {
      formData.append("csrf_token", csrfToken);
    }

    try {
      setProgress(30, "Bestand wordt naar de server gestuurd...");
      const response = await fetch(form.action, {
        method: "POST",
        body: formData,
        headers: {
          "X-Requested-With": "XMLHttpRequest",
          "X-Upload-Request-Id": requestId,
          "X-Upload-Type": uploadType,
          ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
        },
        signal: controller.signal,
      });

      let json = null;
      try {
        json = await response.json();
      } catch (e) {
        json = null;
      }

      if (response.status === 202 && json && json.success && json.job && json.job.job_id) {
        setProgress(35, "Bestand succesvol ontvangen, verwerking gestart.");
        setFeedback("info", json.message || "Bestand succesvol ontvangen, verwerking gestart.", []);
        await pollStatus(json.job.job_id, csrfToken);
      } else if (response.ok && json && json.success) {
        const warnings = json.warnings || json.errors || [];
        setFeedback("success", json.message || "Upload succesvol.", warnings);
        setProgress(100, "Klaar.");
        setUiBusy(false);
      } else {
        const msg =
          (json && json.message) ||
          `Upload mislukt (HTTP ${response.status}). Controleer de bestanden en probeer opnieuw.`;
        const errors = (json && (json.errors || json.warnings || [])) || [];
        setFeedback("error", msg, errors);
        setProgress(0, "");
        setUiBusy(false);
      }
    } catch (error) {
      const isAbort = error && error.name === "AbortError";
      setFeedback(
        "error",
        isAbort
          ? "Upload duurde te lang tijdens ontvangen. Probeer opnieuw met een stabiele verbinding."
          : "Netwerkfout tijdens upload. Controleer je verbinding en probeer opnieuw.",
        []
      );
      setProgress(0, "");
      setUiBusy(false);
    } finally {
      window.clearTimeout(timeoutId);
    }
  };

  // Upload via form submit (intercept page reload).
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (isUploading) return;
    if (fileInput.files && fileInput.files.length > 0) {
      uploadFile(fileInput.files[0], (uploadTypeInput && uploadTypeInput.value) || geselecteerdType);
    }
  });

  // Drag & drop support.
  ["dragenter", "dragover"].forEach((eventName) => {
    dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (isUploading) return;
      setActive(true);
    });
  });

  ["dragleave", "drop"].forEach((eventName) => {
    dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (isUploading) return;
      if (eventName === "drop") {
        const dt = event.dataTransfer;
        if (dt && dt.files && dt.files.length > 0) {
          fileInput.files = dt.files;
          uploadFile(dt.files[0], (uploadTypeInput && uploadTypeInput.value) || geselecteerdType);
        }
      }
      setActive(false);
    });
  });

  fileInput.addEventListener("change", () => {
    if (isUploading) return;
    if (fileInput.files && fileInput.files.length > 0) {
      uploadFile(fileInput.files[0], (uploadTypeInput && uploadTypeInput.value) || geselecteerdType);
    }
  });

  const modal = modalEl ? bootstrap.Modal.getOrCreateInstance(modalEl) : null;
  const typeLabel = (t) => (t === "vlucht_allotments" ? "Vlucht allotments" : "Boekingen");
  const refreshStap = () => {
    if (!modalEl) return;
    uploadStapType.classList.toggle("d-none", stap !== 1);
    uploadStapBestand.classList.toggle("d-none", stap !== 2);
    uploadStapVerwerken.classList.toggle("d-none", stap !== 3);
    btnUploadTerug.classList.toggle("d-none", stap === 1);
    btnUploadVolgende.classList.toggle("d-none", stap === 3);
    btnUploadVerwerken.classList.toggle("d-none", stap !== 3);
    uploadModalTitel.textContent = stap === 1 ? "Kies uploadtype" : stap === 2 ? (geselecteerdType === "vlucht_allotments" ? "Upload vluchtallotmentsbestand" : "Upload boekingenbestand") : "Bevestig upload";
    uploadStapIndicator.textContent = `Stap ${stap} van 3`;
    if (stap === 2) {
      uploadBestandTitel.textContent = geselecteerdType === "vlucht_allotments" ? "Upload vluchtallotmentsbestand" : "Upload boekingenbestand";
      if (uploadFlowAllotmentInfo) {
        uploadFlowAllotmentInfo.classList.toggle("d-none", geselecteerdType !== "vlucht_allotments");
      }
    }
    if (stap === 3) {
      uploadTypeBevestiging.textContent = typeLabel(geselecteerdType);
      uploadBestandBevestiging.textContent = geselecteerdBestand ? geselecteerdBestand.name : "-";
    }
  };

  document.querySelectorAll(".upload-type-card").forEach((btn) => {
    btn.addEventListener("click", () => {
      geselecteerdType = btn.dataset.type || "";
      document.querySelectorAll(".upload-type-card").forEach((b) => b.classList.remove("border-warning", "bg-warning-subtle"));
      btn.classList.add("border-warning", "bg-warning-subtle");
    });
  });
  if (btnOpenUploadFlow && modal) {
    btnOpenUploadFlow.addEventListener("click", () => {
      stap = geselecteerdType ? 2 : 1;
      refreshStap();
      modal.show();
    });
  }
  if (btnUploadTerug) {
    btnUploadTerug.addEventListener("click", () => {
      stap = Math.max(1, stap - 1);
      refreshStap();
    });
  }
  if (btnUploadVolgende) {
    btnUploadVolgende.addEventListener("click", () => {
      if (stap === 1 && !geselecteerdType) {
        setFeedback("error", "Kies eerst een uploadtype.", []);
        return;
      }
      if (stap === 2 && !geselecteerdBestand) {
        setFeedback("error", "Selecteer eerst een bestand.", []);
        return;
      }
      stap = Math.min(3, stap + 1);
      refreshStap();
    });
  }
  if (uploadFlowFileInput) {
    uploadFlowFileInput.addEventListener("change", () => {
      geselecteerdBestand = uploadFlowFileInput.files && uploadFlowFileInput.files[0] ? uploadFlowFileInput.files[0] : null;
      uploadFlowFileNaam.textContent = geselecteerdBestand ? geselecteerdBestand.name : "Nog geen bestand geselecteerd";
    });
  }
  if (btnUploadVerwerken && modal) {
    btnUploadVerwerken.addEventListener("click", async () => {
      if (!geselecteerdBestand || !geselecteerdType) return;
      if (uploadTypeInput) uploadTypeInput.value = geselecteerdType;
      const dt = new DataTransfer();
      dt.items.add(geselecteerdBestand);
      fileInput.files = dt.files;
      modal.hide();
      await uploadFile(geselecteerdBestand, geselecteerdType);
    });
  }
  refreshStap();
  if (geselecteerdType && modal) {
    document.querySelectorAll(".upload-type-card").forEach((b) => {
      if ((b.dataset.type || "") === geselecteerdType) {
        b.classList.add("border-warning", "bg-warning-subtle");
      }
    });
    stap = 2;
    refreshStap();
    modal.show();
  }
});

