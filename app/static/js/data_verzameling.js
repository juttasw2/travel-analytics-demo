(() => {
  const els = {
    dvApplyBtn: document.getElementById("dvApplyBtn"),
    dvResetBtn: document.getElementById("dvResetBtn"),

    dvSearch: document.getElementById("dvSearch"),
    dvBrand: document.getElementById("dvBrand"),
    dvBestemming: document.getElementById("dvBestemming"),
    dvYear: document.getElementById("dvYear"),
    dvStatus: document.getElementById("dvStatus"),
    dvDateKind: document.getElementById("dvDateKind"),
    dvDateFrom: document.getElementById("dvDateFrom"),
    dvDateTo: document.getElementById("dvDateTo"),

    dvError: document.getElementById("dvError"),
    dvSuccess: document.getElementById("dvSuccess"),
    dvLoadingText: document.getElementById("dvLoadingText"),
    dvTableBody: document.getElementById("dvTableBody"),

    dvPrevBtn: document.getElementById("dvPrevBtn"),
    dvNextBtn: document.getElementById("dvNextBtn"),
    dvPageInfo: document.getElementById("dvPageInfo"),

    dvDetailDrawer: document.getElementById("dvDetailDrawer"),
    dvDetailLoading: document.getElementById("dvDetailLoading"),
    dvDetailContent: document.getElementById("dvDetailContent"),
    dvDetailDrawerLabel: document.getElementById("dvDetailDrawerLabel"),
    dvDetailDrawerSub: document.getElementById("dvDetailDrawerSub"),
    dvEditBtn: document.getElementById("dvEditBtn"),
    dvDeleteBtn: document.getElementById("dvDeleteBtn"),

    dvBookingFields: document.getElementById("dvBookingFields"),
    dvAccommodationFields: document.getElementById("dvAccommodationFields"),
    dvTravellersFields: document.getElementById("dvTravellersFields"),
    dvExcursiesFields: document.getElementById("dvExcursiesFields"),
    dvAddonsFields: document.getElementById("dvAddonsFields"),

    dvEditModal: document.getElementById("dvEditModal"),
    dvEditModalSub: document.getElementById("dvEditModalSub"),
    dvEditForm: document.getElementById("dvEditForm"),
    dvEditError: document.getElementById("dvEditError"),
    dvEditSaveBtn: document.getElementById("dvEditSaveBtn"),
    dvEditCancelBtn: document.getElementById("dvEditCancelBtn"),

    dvEditOrdernummer: document.getElementById("dvEditOrdernummer"),
    dvEditBestemming: document.getElementById("dvEditBestemming"),
    dvEditAccommodatie: document.getElementById("dvEditAccommodatie"),
    dvEditAccommodatieType: document.getElementById("dvEditAccommodatieType"),
    dvEditLeverancier: document.getElementById("dvEditLeverancier"),
    dvEditVertrekdatum: document.getElementById("dvEditVertrekdatum"),
    dvEditTerugkeerdatum: document.getElementById("dvEditTerugkeerdatum"),
    dvEditBoekingsdatum: document.getElementById("dvEditBoekingsdatum"),
    dvEditBoekingsstatus: document.getElementById("dvEditBoekingsstatus"),
    dvEditBetaalstatus: document.getElementById("dvEditBetaalstatus"),
    dvEditReizigersAantal: document.getElementById("dvEditReizigersAantal"),
    dvEditPrepaidBedrag: document.getElementById("dvEditPrepaidBedrag"),
    dvEditExcursies: document.getElementById("dvEditExcursies"),
    dvEditAddons: document.getElementById("dvEditAddons"),

    dvBestemmingSuggestions: document.getElementById("dvBestemmingSuggestions"),
    dvAccommodatieTypeSuggestions: document.getElementById("dvAccommodatieTypeSuggestions"),
    dvLeverancierSuggestions: document.getElementById("dvLeverancierSuggestions"),
    dvDeleteModal: document.getElementById("dvDeleteModal"),
    dvDeleteModalSub: document.getElementById("dvDeleteModalSub"),
    dvDeleteError: document.getElementById("dvDeleteError"),
    dvDeleteConfirmBtn: document.getElementById("dvDeleteConfirmBtn"),
    dvDeleteCancelBtn: document.getElementById("dvDeleteCancelBtn"),
  };

  if (!els.dvApplyBtn || !els.dvResetBtn || !els.dvTableBody) return;

  const nfInt = new Intl.NumberFormat("nl-NL");
  const nfMoney = new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" });

  const API_BASE = "/data-verzameling";
  const EDIT_OPTIONS_URL = `${API_BASE}/edit-options`;

  let page = 1;
  let hasNext = false;
  const cache = new Map();
  let selectedBookingId = "";
  let selectedBookingDetail = null;
  let editOptions = null;
  let editOptionsLoaded = false;
  let editOptionsLoading = false;
  let editModal = null;
  let deleteModal = null;
  let deletingBookingId = "";
  let deletingBookingLabel = "";

  const showError = (msg) => {
    if (!els.dvError) return;
    if (!msg) {
      els.dvError.classList.add("d-none");
      els.dvError.textContent = "";
      return;
    }
    els.dvError.textContent = msg;
    els.dvError.classList.remove("d-none");
  };

  const showSuccess = (msg) => {
    if (!els.dvSuccess) return;
    if (!msg) {
      els.dvSuccess.classList.add("d-none");
      els.dvSuccess.textContent = "";
      return;
    }
    els.dvSuccess.textContent = msg;
    els.dvSuccess.classList.remove("d-none");
  };

  const showEditError = (msg) => {
    if (!els.dvEditError) return;
    if (!msg) {
      els.dvEditError.classList.add("d-none");
      els.dvEditError.textContent = "";
      return;
    }
    els.dvEditError.textContent = msg;
    els.dvEditError.classList.remove("d-none");
  };

  const showDeleteError = (msg) => {
    if (!els.dvDeleteError) return;
    if (!msg) {
      els.dvDeleteError.classList.add("d-none");
      els.dvDeleteError.textContent = "";
      return;
    }
    els.dvDeleteError.textContent = msg;
    els.dvDeleteError.classList.remove("d-none");
  };

  const setLoading = (loading) => {
    if (els.dvLoadingText) els.dvLoadingText.classList.toggle("d-none", !loading);
    if (els.dvApplyBtn) els.dvApplyBtn.disabled = loading;
    if (els.dvResetBtn) els.dvResetBtn.disabled = loading;
    if (els.dvPrevBtn) els.dvPrevBtn.disabled = loading;
    if (els.dvNextBtn) els.dvNextBtn.disabled = loading;
  };

  const setEditLoading = (loading) => {
    if (els.dvEditSaveBtn) els.dvEditSaveBtn.disabled = loading;
    if (els.dvEditCancelBtn) els.dvEditCancelBtn.disabled = loading;
  };

  const setDeleteLoading = (loading) => {
    if (els.dvDeleteConfirmBtn) els.dvDeleteConfirmBtn.disabled = loading;
    if (els.dvDeleteCancelBtn) els.dvDeleteCancelBtn.disabled = loading;
  };

  const getCsrfToken = () => {
    const el = document.querySelector("meta[name='csrf-token']");
    return String(el?.getAttribute("content") || "").trim();
  };

  const escapeHtml = (value) => {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  };

  const parseNumericInput = (raw, fieldLabel, { required = false, integer = false } = {}) => {
    const txt = String(raw ?? "").trim();
    if (!txt) {
      if (required) throw new Error(`${fieldLabel} is verplicht.`);
      return null;
    }
    const normalized = txt.replace(",", ".");
    const num = Number(normalized);
    if (!Number.isFinite(num)) throw new Error(`${fieldLabel} moet numeriek zijn.`);
    if (num < 0) throw new Error(`${fieldLabel} moet groter of gelijk aan 0 zijn.`);
    if (integer && !Number.isInteger(num)) throw new Error(`${fieldLabel} moet een geheel getal zijn.`);
    return num;
  };

  const parseIsoDate = (raw) => {
    const txt = String(raw || "").trim();
    if (!txt) return "";
    return txt.slice(0, 10);
  };

  const fetchJson = async (url, init = {}) => {
    const mergedHeaders = {
      Accept: "application/json",
      "X-Requested-With": "XMLHttpRequest",
      ...(init.headers || {}),
    };
    const resp = await fetch(url, {
      credentials: "same-origin",
      ...init,
      headers: mergedHeaders,
    });
    const rawBody = await resp.text();
    const contentType = resp.headers.get("content-type") || "";
    const isJson = contentType.includes("application/json");

    let parsed = null;
    if (rawBody && isJson) {
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        parsed = null;
      }
    }

    if (!resp.ok) {
      const rawText = String(rawBody || "").trim();
      const details = parsed?.error || parsed?.message || (parsed ? JSON.stringify(parsed) : rawBody);
      if (rawText.startsWith("<!doctype html") || rawText.startsWith("<html")) {
        throw new Error(`Endpoint niet gevonden (HTTP ${resp.status}). Mogelijk draait de server nog op oude code; herstart de app.`);
      }
      throw new Error(details || `HTTP ${resp.status}`);
    }

    if (!rawBody) return {};
    if (parsed) return parsed;
    throw new Error("Server gaf geen geldige JSON terug.");
  };

  const getFilters = () => {
    const search = els.dvSearch ? els.dvSearch.value.trim() : "";
    const brand = els.dvBrand ? els.dvBrand.value : "__all__";
    const bestemming = els.dvBestemming ? els.dvBestemming.value : "";
    const bestemming_id = bestemming || "";
    const year = els.dvYear ? Number(els.dvYear.value) || 0 : 0;
    const status = els.dvStatus ? els.dvStatus.value : "";
    const date_kind = els.dvDateKind ? els.dvDateKind.value : "boekingsdatum";
    const date_from = els.dvDateFrom ? els.dvDateFrom.value : "";
    const date_to = els.dvDateTo ? els.dvDateTo.value : "";

    return { search, brand, bestemming_id, year, status, date_kind, date_from, date_to };
  };

  const filtersKey = (f, pageNo) => {
    return JSON.stringify({
      page: pageNo,
      search: f.search,
      brand: f.brand,
      bestemming_id: f.bestemming_id,
      year: f.year,
      status: f.status,
      date_kind: f.date_kind,
      date_from: f.date_from,
      date_to: f.date_to,
    });
  };

  const populateYears = async (brand) => {
    const yearSel = els.dvYear;
    if (!yearSel) return;

    const currentValue = yearSel.value || "0";
    yearSel.innerHTML = "";
    const allOpt = document.createElement("option");
    allOpt.value = "0";
    allOpt.selected = true;
    allOpt.textContent = "Alle jaren";
    yearSel.appendChild(allOpt);

    const url = new URL(`${window.location.origin}${API_BASE}/years`);
    url.searchParams.set("brand", brand || "__all__");
    const data = await fetchJson(url.toString());
    const years = Array.isArray(data?.years) ? data.years : [];

    years.forEach((y) => {
      const opt = document.createElement("option");
      opt.value = String(y);
      opt.textContent = String(y);
      yearSel.appendChild(opt);
    });

    yearSel.value = currentValue;
    if (!yearSel.value) yearSel.value = "0";
  };

  const loadOptions = async () => {
    const url = new URL(`${window.location.origin}${API_BASE}/options`);
    const data = await fetchJson(url.toString());

    const brands = Array.isArray(data?.brands) ? data.brands : [];
    const bestemmingen = Array.isArray(data?.bestemmingen) ? data.bestemmingen : [];
    const boekingStatussen = Array.isArray(data?.boekings_statussen) ? data.boekings_statussen : [];

    // Brand options
    els.dvBrand.innerHTML = "";
    const allBrandOpt = document.createElement("option");
    allBrandOpt.value = "__all__";
    allBrandOpt.textContent = "Alle merken";
    els.dvBrand.appendChild(allBrandOpt);
    brands.forEach((b) => {
      const opt = document.createElement("option");
      opt.value = b;
      opt.textContent = b;
      els.dvBrand.appendChild(opt);
    });
    els.dvBrand.value = "__all__";

    // Destination options
    els.dvBestemming.innerHTML = "";
    const allDestOpt = document.createElement("option");
    allDestOpt.value = "";
    allDestOpt.selected = true;
    allDestOpt.textContent = "Alle bestemmingen";
    els.dvBestemming.appendChild(allDestOpt);
    bestemmingen.forEach((d) => {
      const opt = document.createElement("option");
      opt.value = String(d.id);
      opt.textContent = String(d.naam);
      els.dvBestemming.appendChild(opt);
    });

    // Status options
    els.dvStatus.innerHTML = "";
    const allStatusOpt = document.createElement("option");
    allStatusOpt.value = "";
    allStatusOpt.selected = true;
    allStatusOpt.textContent = "Alle boekingsstatussen";
    els.dvStatus.appendChild(allStatusOpt);
    boekingStatussen.forEach((s) => {
      const opt = document.createElement("option");
      opt.value = String(s.id);
      opt.textContent = String(s.naam);
      els.dvStatus.appendChild(opt);
    });

    await populateYears(els.dvBrand.value);
  };

  const renderTable = (rows) => {
    els.dvTableBody.innerHTML = "";

    if (!rows || rows.length === 0) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="13" class="text-center text-muted py-4">Geen boekingen gevonden.</td>`;
      els.dvTableBody.appendChild(tr);
      return;
    }

    rows.forEach((r) => {
      const tr = document.createElement("tr");
      tr.style.cursor = "pointer";
      tr.dataset.bookingId = r.booking_id;

      const order = r.order_nummer || "-";
      const totaal = r.totaal_te_betalen != null ? nfMoney.format(Number(r.totaal_te_betalen)) : "—";
      const transportLabel =
        r.transport ??
        r.transport_naam ??
        r.transport_name ??
        r.vervoer ??
        "-";

      tr.innerHTML = `
        <td class="fw-medium">${escapeHtml(order)}</td>
        <td>${escapeHtml(r.bestemming || "-")}</td>
        <td>${escapeHtml(r.accommodatie || "-")}</td>
        <td>${escapeHtml((window.TADate && window.TADate.formatDate && window.TADate.formatDate(r.vertrekdatum || "", r.vertrekdatum || "-")) || (r.vertrekdatum || "-"))}</td>
        <td>${escapeHtml((window.TADate && window.TADate.formatDate && window.TADate.formatDate(r.terugkeerdatum || "", r.terugkeerdatum || "-")) || (r.terugkeerdatum || "-"))}</td>
        <td>${escapeHtml((window.TADate && window.TADate.formatDate && window.TADate.formatDate(r.boekingsdatum || "", r.boekingsdatum || "-")) || (r.boekingsdatum || "-"))}</td>
        <td class="text-end">${r.aantal_reizigers != null ? nfInt.format(Number(r.aantal_reizigers)) : "-"}</td>
        <td>${escapeHtml(r.boeking_status || "-")}</td>
        <td>${escapeHtml(r.betaling_status || "-")}</td>
        <td>${escapeHtml(r.doelgroep || "-")}</td>
        <td>${escapeHtml(transportLabel || "-")}</td>
        <td class="text-end">${totaal}</td>
        <td class="text-end">
          <button type="button" class="btn btn-sm btn-outline-secondary dv-quick-edit-btn" title="Snel bewerken">✏️</button>
        </td>
      `;

      tr.addEventListener("click", () => loadDetail(r.booking_id));
      const quickBtn = tr.querySelector(".dv-quick-edit-btn");
      quickBtn?.addEventListener("click", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        loadDetail(r.booking_id, { openEdit: true });
      });
      els.dvTableBody.appendChild(tr);
    });
  };

  const toNameList = (items) => {
    if (!Array.isArray(items)) return [];
    return [...new Set(items.map((item) => String(item?.naam || "").trim()).filter(Boolean))];
  };

  const fillDatalist = (el, options) => {
    if (!el) return;
    el.innerHTML = "";
    (options || []).forEach((name) => {
      const opt = document.createElement("option");
      opt.value = String(name);
      el.appendChild(opt);
    });
  };

  const setSelectOptions = (selectEl, options, { includeEmpty = false, emptyLabel = "—" } = {}) => {
    if (!selectEl) return;
    selectEl.innerHTML = "";
    if (includeEmpty) {
      const first = document.createElement("option");
      first.value = "";
      first.textContent = emptyLabel;
      selectEl.appendChild(first);
    }
    (options || []).forEach((item) => {
      const text = String(item || "").trim();
      if (!text) return;
      const opt = document.createElement("option");
      opt.value = text;
      opt.textContent = text;
      selectEl.appendChild(opt);
    });
  };

  const setMultiSelectOptions = (selectEl, options) => {
    if (!selectEl) return;
    selectEl.innerHTML = "";
    (options || []).forEach((item) => {
      const text = String(item || "").trim();
      if (!text) return;
      const opt = document.createElement("option");
      opt.value = text;
      opt.textContent = text;
      selectEl.appendChild(opt);
    });
  };

  const setSelectedMultiValues = (selectEl, values) => {
    if (!selectEl) return;
    const wanted = new Set((values || []).map((v) => String(v).trim().toLowerCase()).filter(Boolean));
    Array.from(selectEl.options).forEach((opt) => {
      opt.selected = wanted.has(String(opt.value).trim().toLowerCase());
    });
  };

  const ensureModal = () => {
    if (!els.dvEditModal || !window.bootstrap?.Modal) return null;
    if (!editModal) editModal = new window.bootstrap.Modal(els.dvEditModal);
    return editModal;
  };

  const ensureDeleteModal = () => {
    if (!els.dvDeleteModal || !window.bootstrap?.Modal) return null;
    if (!deleteModal) deleteModal = new window.bootstrap.Modal(els.dvDeleteModal);
    return deleteModal;
  };

  const closeDetailDrawerIfOpen = () => {
    if (!els.dvDetailDrawer || !window.bootstrap?.Offcanvas) return;
    const inst = window.bootstrap.Offcanvas.getInstance(els.dvDetailDrawer);
    inst?.hide();
  };

  const askDeleteBooking = (bookingId, bookingLabel) => {
    deletingBookingId = String(bookingId || "").trim();
    deletingBookingLabel = String(bookingLabel || deletingBookingId);
    showDeleteError("");
    if (els.dvDeleteModalSub) {
      els.dvDeleteModalSub.textContent = deletingBookingLabel
        ? `Boeking: ${deletingBookingLabel}`
        : `Boeking-ID: ${deletingBookingId}`;
    }
    ensureDeleteModal()?.show();
  };

  const confirmDeleteBooking = async () => {
    if (!deletingBookingId) return;
    const csrf = getCsrfToken();
    if (!csrf) throw new Error("CSRF-token ontbreekt. Vernieuw de pagina.");
    showError("");
    showSuccess("");
    showDeleteError("");
    setDeleteLoading(true);
    try {
      await fetchJson(`${API_BASE}/boekingen/${encodeURIComponent(deletingBookingId)}`, {
        method: "DELETE",
        headers: {
          "X-CSRF-Token": csrf,
        },
      });
      ensureDeleteModal()?.hide();
      if (selectedBookingId === deletingBookingId) {
        selectedBookingId = "";
        selectedBookingDetail = null;
        closeDetailDrawerIfOpen();
      }
      cache.clear();
      await loadPage(page);
      showSuccess(`Boeking ${deletingBookingLabel || deletingBookingId} is permanent verwijderd.`);
    } finally {
      setDeleteLoading(false);
    }
  };

  const ensureEditOptions = async () => {
    if (editOptionsLoaded && editOptions) return editOptions;
    if (editOptionsLoading) return editOptions;
    editOptionsLoading = true;
    const buildFallbackOptions = () => {
      const boekingStatussen = els.dvStatus
        ? Array.from(els.dvStatus.options).map((o) => String(o.textContent || "").trim()).filter(Boolean)
        : [];
      return {
        bestemmingen: Array.from(els.dvBestemming?.options || [])
          .map((o) => String(o.textContent || "").trim())
          .filter((v) => v && v !== "Alle bestemmingen"),
        accommodatie_types: [],
        leveranciers: [],
        boeking_statussen: boekingStatussen.length
          ? boekingStatussen.filter((v) => v !== "Alle boekingsstatussen")
          : ["processing", "booked", "accepted", "cancelled"],
        betaling_statussen: ["OKE", "openstaand", "aandacht vereist"],
        excursies: [],
        addons: [],
      };
    };

    try {
      const data = await fetchJson(EDIT_OPTIONS_URL);
      editOptions = {
        bestemmingen: Array.isArray(data?.bestemmingen) ? data.bestemmingen.map((x) => String(x)).filter(Boolean) : [],
        accommodatie_types: Array.isArray(data?.accommodatie_types)
          ? data.accommodatie_types.map((x) => String(x)).filter(Boolean)
          : [],
        leveranciers: Array.isArray(data?.leveranciers) ? data.leveranciers.map((x) => String(x)).filter(Boolean) : [],
        boeking_statussen: Array.isArray(data?.boeking_statussen)
          ? data.boeking_statussen.map((x) => String(x)).filter(Boolean)
          : ["processing", "booked", "accepted", "cancelled"],
        betaling_statussen: Array.isArray(data?.betaling_statussen)
          ? data.betaling_statussen.map((x) => String(x)).filter(Boolean)
          : ["OKE", "openstaand", "aandacht vereist"],
        excursies: Array.isArray(data?.excursies) ? data.excursies.map((x) => String(x)).filter(Boolean) : [],
        addons: Array.isArray(data?.addons) ? data.addons.map((x) => String(x)).filter(Boolean) : [],
      };
      editOptionsLoaded = true;
    } catch {
      editOptions = buildFallbackOptions();
      editOptionsLoaded = true;
    } finally {
      editOptionsLoading = false;
    }
    fillDatalist(els.dvBestemmingSuggestions, editOptions?.bestemmingen || []);
    fillDatalist(els.dvAccommodatieTypeSuggestions, editOptions?.accommodatie_types || []);
    fillDatalist(els.dvLeverancierSuggestions, editOptions?.leveranciers || []);
    setSelectOptions(els.dvEditBoekingsstatus, editOptions?.boeking_statussen || []);
    setSelectOptions(els.dvEditBetaalstatus, editOptions?.betaling_statussen || [], {
      includeEmpty: true,
      emptyLabel: "Kies betaalstatus",
    });
    setMultiSelectOptions(els.dvEditExcursies, editOptions?.excursies || []);
    setMultiSelectOptions(els.dvEditAddons, editOptions?.addons || []);
    return editOptions;
  };

  const normalizeLabelMatch = (value) => String(value || "").trim().toLowerCase();

  const setSelectByLabel = (selectEl, value) => {
    if (!selectEl) return;
    const wanted = normalizeLabelMatch(value);
    let found = "";
    Array.from(selectEl.options).forEach((opt) => {
      if (!found && normalizeLabelMatch(opt.value) === wanted) {
        found = opt.value;
      }
    });
    selectEl.value = found || (wanted ? String(value || "").trim() : "");
  };

  const collectSelectedOptions = (selectEl) => {
    if (!selectEl) return [];
    return Array.from(selectEl.selectedOptions).map((opt) => String(opt.value).trim()).filter(Boolean);
  };

  const openEditModal = async () => {
    if (!selectedBookingId || !selectedBookingDetail) {
      showError("Selecteer eerst een boeking om te bewerken.");
      return;
    }
    const options = await ensureEditOptions();
    if (!options) return;
    showEditError("");

    const booking = selectedBookingDetail.booking || {};
    const accommodatie = selectedBookingDetail.accommodatie || {};
    const orderNummer = booking?.order_nummer || "";
    const bestemmingNaam = selectedBookingDetail?.bestemming?.naam || booking?.bestemming_id || "";
    const boekingStatusNaam = selectedBookingDetail?.boeking_status?.naam || booking?.boeking_status_id || "";
    const betalingStatusNaam = selectedBookingDetail?.betaling_status?.naam || booking?.betaling_status_id || "";

    if (els.dvEditModalSub) {
      els.dvEditModalSub.textContent = orderNummer ? `Ordernummer ${orderNummer}` : `Boeking ${selectedBookingId}`;
    }

    if (els.dvEditOrdernummer) els.dvEditOrdernummer.value = String(orderNummer || "");
    if (els.dvEditBestemming) els.dvEditBestemming.value = String(bestemmingNaam || "");
    if (els.dvEditAccommodatie) els.dvEditAccommodatie.value = String(accommodatie?.naam || booking?.accommodatie_id || "");
    if (els.dvEditAccommodatieType) els.dvEditAccommodatieType.value = String(accommodatie?.type || "");
    if (els.dvEditLeverancier) els.dvEditLeverancier.value = String(accommodatie?.leverancier || "");
    if (els.dvEditVertrekdatum) els.dvEditVertrekdatum.value = parseIsoDate(booking?.vertrekdatum);
    if (els.dvEditTerugkeerdatum) els.dvEditTerugkeerdatum.value = parseIsoDate(booking?.terugkeerdatum);
    if (els.dvEditBoekingsdatum) els.dvEditBoekingsdatum.value = parseIsoDate(booking?.boekingsdatum);
    if (els.dvEditReizigersAantal) els.dvEditReizigersAantal.value = booking?.aantal_reizigers ?? "";
    if (els.dvEditPrepaidBedrag) els.dvEditPrepaidBedrag.value = booking?.voorschot ?? "";

    setSelectByLabel(els.dvEditBoekingsstatus, boekingStatusNaam);
    setSelectByLabel(els.dvEditBetaalstatus, betalingStatusNaam);
    setSelectedMultiValues(els.dvEditExcursies, toNameList(selectedBookingDetail.excursies));
    setSelectedMultiValues(els.dvEditAddons, toNameList(selectedBookingDetail.addons));

    const modal = ensureModal();
    modal?.show();
  };

  const collectEditPayload = () => {
    const bestemming = String(els.dvEditBestemming?.value || "").trim();
    const accommodatie = String(els.dvEditAccommodatie?.value || "").trim();
    const boekingStatus = String(els.dvEditBoekingsstatus?.value || "").trim();
    const vertrekdatum = String(els.dvEditVertrekdatum?.value || "").trim();
    const terugkeerdatum = String(els.dvEditTerugkeerdatum?.value || "").trim();
    const boekingsdatum = String(els.dvEditBoekingsdatum?.value || "").trim();

    if (!bestemming) throw new Error("Bestemming is verplicht.");
    if (!accommodatie) throw new Error("Accommodatie is verplicht.");
    if (!boekingStatus) throw new Error("Boekingsstatus is verplicht.");
    if (vertrekdatum && terugkeerdatum && vertrekdatum > terugkeerdatum) {
      throw new Error("Vertrekdatum moet vóór terugkeerdatum liggen.");
    }

    const aantalReizigers = parseNumericInput(els.dvEditReizigersAantal?.value, "Reizigers aantal", { integer: true });
    const prepaidBedrag = parseNumericInput(els.dvEditPrepaidBedrag?.value, "Prepaid bedrag");

    return {
      order_nummer: String(els.dvEditOrdernummer?.value || "").trim(),
      bestemming,
      accommodatie,
      accommodatie_type: String(els.dvEditAccommodatieType?.value || "").trim(),
      leverancier: String(els.dvEditLeverancier?.value || "").trim(),
      vertrekdatum,
      terugkeerdatum,
      boekingsdatum,
      boeking_status: boekingStatus,
      betaling_status: String(els.dvEditBetaalstatus?.value || "").trim(),
      aantal_reizigers: aantalReizigers,
      prepaid_bedrag: prepaidBedrag,
      excursies: collectSelectedOptions(els.dvEditExcursies),
      addons: collectSelectedOptions(els.dvEditAddons),
    };
  };

  const saveEdit = async () => {
    if (!selectedBookingId) return;
    showEditError("");
    showSuccess("");
    const csrf = getCsrfToken();
    if (!csrf) throw new Error("CSRF-token ontbreekt. Vernieuw de pagina.");
    const payload = collectEditPayload();

    setEditLoading(true);
    try {
      await fetchJson(`${API_BASE}/update/${encodeURIComponent(selectedBookingId)}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrf,
        },
        body: JSON.stringify(payload),
      });

      ensureModal()?.hide();
      cache.clear();
      await loadPage(page);
      await loadDetail(selectedBookingId);
      showSuccess("Boeking succesvol aangepast");
    } finally {
      setEditLoading(false);
    }
  };

  const loadDetail = async (bookingId, opts = {}) => {
    const drawer = els.dvDetailDrawer;
    if (!drawer) return;
    selectedBookingId = String(bookingId || "").trim();
    selectedBookingDetail = null;
    if (els.dvEditBtn) {
      els.dvEditBtn.classList.remove("d-none");
      els.dvEditBtn.disabled = true;
    }
    if (els.dvDeleteBtn) {
      els.dvDeleteBtn.classList.remove("d-none");
      els.dvDeleteBtn.disabled = true;
    }

    // bootstrap offcanvas
    const bsOffcanvas = window.bootstrap?.Offcanvas ? new window.bootstrap.Offcanvas(drawer) : null;
    if (bsOffcanvas) bsOffcanvas.show();

    els.dvDetailLoading?.classList.remove("d-none");
    els.dvDetailContent?.classList.add("d-none");
    showError("");

    els.dvDetailDrawerSub.textContent = `Boeking ${selectedBookingId}`;
    els.dvBookingFields.innerHTML = "";
    els.dvAccommodationFields.textContent = "";
    els.dvTravellersFields.textContent = "";
    els.dvExcursiesFields.textContent = "";
    els.dvAddonsFields.textContent = "";

    try {
      const url = new URL(`${window.location.origin}${API_BASE}/detail/${encodeURIComponent(selectedBookingId)}`);
      const data = await fetchJson(url.toString());

      const booking = data?.booking || data?.payload?.booking || null;
      const accommodatie = data?.accommodatie || data?.payload?.accommodatie || null;
      const payload = data?.payload || data || {};
      selectedBookingDetail = payload;
      if (els.dvEditBtn) {
        els.dvEditBtn.disabled = false;
      }
      if (els.dvDeleteBtn) {
        els.dvDeleteBtn.disabled = false;
      }

      els.dvDetailDrawerSub.textContent = booking?.order_nummer
        ? `Ordernummer ${booking.order_nummer}`
        : `Boeking ${selectedBookingId}`;
      els.dvDetailLoading?.classList.add("d-none");
      els.dvDetailContent?.classList.remove("d-none");

      // Booking fields
      if (booking) {
        const frag = document.createDocumentFragment();
        Object.entries(booking).forEach(([k, v]) => {
          const col = document.createElement("div");
          col.className = "col-12 col-md-6";
          col.innerHTML = `
            <div class="text-muted small">${k}</div>
            <div class="fw-medium">${v === null || v === undefined ? "-" : String(v)}</div>
          `;
          frag.appendChild(col);
        });
        els.dvBookingFields.appendChild(frag);
      }

      // Accommodatie
      if (accommodatie) {
        els.dvAccommodationFields.innerHTML = `
          <div class="fw-medium">${accommodatie.naam || "-"}</div>
          <div class="text-muted small">Type: ${accommodatie.type || "-"}</div>
          <div class="text-muted small">Leverancier: ${accommodatie.leverancier || "-"}</div>
          <div class="text-muted small">Bestemming: ${accommodatie.bestemming?.naam || "-"}</div>
        `;
      }

      const renderList = (arr, renderFn) => {
        const list = Array.isArray(arr) ? arr : [];
        if (list.length === 0) return "<div class='text-muted small'>—</div>";
        return `<div class="list-group">${list.map(renderFn).join("")}</div>`;
      };

      els.dvTravellersFields.innerHTML = renderList(
        data?.reizigers || data?.payload?.reizigers,
        (item) => `<div class="list-group-item d-flex justify-content-between"><span>${item.geboortedatum || "-"} (${item.geslacht || "-"})</span><span class="text-muted small">${item.status?.naam || "-"}</span></div>`
      );

      els.dvExcursiesFields.innerHTML = renderList(
        data?.excursies || data?.payload?.excursies,
        (item) =>
          `<div class="list-group-item"><div class="fw-medium">${item.naam || "-"}</div><div class="text-muted small">Type: ${item.type || "-"} • Prijs: ${item.prijs || "-"}</div><div class="text-muted small">Vertrek: ${item.vertrekdatum || "-"} • Terugkeer: ${item.terugkeerdatum || "-"}</div></div>`
      );

      els.dvAddonsFields.innerHTML = renderList(
        data?.addons || data?.payload?.addons,
        (item) =>
          `<div class="list-group-item"><div class="fw-medium">${item.naam || "-"}</div><div class="text-muted small">Prijs: ${item.prijs || "-"}</div><div class="text-muted small">Vertrek: ${item.vertrekdatum || "-"} • Terugkeer: ${item.terugkeerdatum || "-"}</div></div>`
      );

      if (opts?.openEdit) {
        await openEditModal();
      }
    } catch (e) {
      showError(e?.message || String(e));
      els.dvDetailLoading?.classList.add("d-none");
      if (els.dvDetailContent) {
        els.dvDetailContent.classList.remove("d-none");
      }
      if (els.dvBookingFields) {
        const message = e?.message || "Fout bij laden van detailgegevens.";
        els.dvBookingFields.innerHTML = `<div class="col-12"><div class="alert alert-danger mb-0">${message}</div></div>`;
      }
      if (els.dvEditBtn) els.dvEditBtn.disabled = true;
      if (els.dvDeleteBtn) els.dvDeleteBtn.disabled = true;
    }
  };

  const loadPage = async (pageNo) => {
    const f = getFilters();
    const key = filtersKey(f, pageNo);
    if (cache.has(key)) {
      const cached = cache.get(key);
      hasNext = cached.has_next;
      page = pageNo;
      els.dvPageInfo.textContent = `Pagina ${page}`;
      els.dvPrevBtn.disabled = page <= 1;
      els.dvNextBtn.disabled = !hasNext;
      renderTable(cached.rows);
      return;
    }

    setLoading(true);
    showError("");
    showSuccess("");
    try {
      const url = new URL(`${window.location.origin}${API_BASE}/list`);
      url.searchParams.set("page", String(pageNo));
      url.searchParams.set("search", f.search || "");
      url.searchParams.set("brand", f.brand || "__all__");
      url.searchParams.set("bestemming", f.bestemming_id || "");
      url.searchParams.set("year", String(f.year || 0));
      url.searchParams.set("status", f.status || "");
      url.searchParams.set("date_kind", f.date_kind || "boekingsdatum");
      if (f.date_from) url.searchParams.set("date_from", f.date_from);
      if (f.date_to) url.searchParams.set("date_to", f.date_to);

      const data = await fetchJson(url.toString());
      const rows = Array.isArray(data?.rows) ? data.rows : [];
      hasNext = Boolean(data?.has_next);
      page = Number(data?.page) || pageNo;

      cache.set(key, { rows, has_next: hasNext });

      els.dvPageInfo.textContent = `Pagina ${page}`;
      els.dvPrevBtn.disabled = page <= 1;
      els.dvNextBtn.disabled = !hasNext;
      renderTable(rows);
    } catch (e) {
      showError(e?.message || String(e));
      renderTable([]);
      hasNext = false;
    } finally {
      setLoading(false);
    }
  };

  // Events
  els.dvBrand.addEventListener("change", async () => {
    await populateYears(els.dvBrand.value);
    els.dvApplyBtn.disabled = false;
    els.dvResetBtn.disabled = false;
  });

  els.dvApplyBtn.addEventListener("click", async () => {
    page = 1;
    cache.clear();
    await loadPage(1);
  });

  els.dvResetBtn.addEventListener("click", async () => {
    els.dvSearch.value = "";
    els.dvBrand.value = "__all__";
    els.dvBestemming.value = "";
    els.dvYear.value = "0";
    els.dvStatus.value = "";
    els.dvDateKind.value = "boekingsdatum";
    els.dvDateFrom.value = "";
    els.dvDateTo.value = "";
    page = 1;
    cache.clear();
    await populateYears("__all__");
    await loadPage(1);
  });

  els.dvPrevBtn.addEventListener("click", async () => {
    if (page <= 1) return;
    await loadPage(page - 1);
  });
  els.dvNextBtn.addEventListener("click", async () => {
    if (!hasNext) return;
    await loadPage(page + 1);
  });

  els.dvEditBtn?.addEventListener("click", async () => {
    try {
      await openEditModal();
    } catch (e) {
      showError(e?.message || String(e));
    }
  });

  els.dvDeleteBtn?.addEventListener("click", () => {
    if (!selectedBookingId) return;
    const booking = selectedBookingDetail?.booking || {};
    const order = String(booking?.order_nummer || "").trim();
    const bestemming = String(selectedBookingDetail?.bestemming?.naam || "").trim();
    const bookingLabel = [order, bestemming].filter(Boolean).join(" · ");
    askDeleteBooking(selectedBookingId, bookingLabel);
  });

  els.dvEditForm?.addEventListener("submit", async (evt) => {
    evt.preventDefault();
    try {
      await saveEdit();
    } catch (e) {
      showEditError(e?.message || String(e));
    }
  });

  els.dvDeleteConfirmBtn?.addEventListener("click", async () => {
    try {
      await confirmDeleteBooking();
    } catch (e) {
      showDeleteError(e?.message || String(e));
    }
  });

  // Init
  const init = async () => {
    setLoading(true);
    try {
      await loadOptions();
      els.dvApplyBtn.disabled = false;
      els.dvResetBtn.disabled = false;
      await loadPage(1);
    } catch (e) {
      showError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  init();
})();

