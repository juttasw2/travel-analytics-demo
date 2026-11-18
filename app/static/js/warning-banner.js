(() => {
  const ROOT_SELECTOR = "[data-warning-banner]";
  const CLOSE_SELECTOR = "[data-warning-close]";
  const CLOSED_VALUE = "1";

  function getStorage() {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  }

  function hasBeenClosed(storage, key) {
    if (!storage || !key) return false;
    return storage.getItem(key) === CLOSED_VALUE;
  }

  function markClosed(storage, key) {
    if (!storage || !key) return;
    storage.setItem(key, CLOSED_VALUE);
  }

  function clearClosed(storage, key) {
    if (!storage || !key) return;
    storage.removeItem(key);
  }

  function hasLoginSuccessFlash() {
    const successAlerts = Array.from(document.querySelectorAll(".alert.alert-success"));
    return successAlerts.some((alertEl) =>
      /succesvol ingelogd/i.test((alertEl.textContent || "").trim()),
    );
  }

  function initWarningBanner() {
    const root = document.querySelector(ROOT_SELECTOR);
    if (!root) return;
    const closeBtn = root.querySelector(CLOSE_SELECTOR);
    const storageKey = String(root.getAttribute("data-warning-storage-key") || "").trim();
    const storage = getStorage();

    // Na een nieuwe login tonen we de waarschuwing opnieuw,
    // ook als die eerder werd weggeklikt.
    if (hasLoginSuccessFlash()) {
      clearClosed(storage, storageKey);
    }

    if (!hasBeenClosed(storage, storageKey)) {
      root.classList.remove("d-none");
    }

    if (!closeBtn) return;
    closeBtn.addEventListener("click", () => {
      root.classList.add("d-none");
      markClosed(storage, storageKey);
    });
  }

  document.addEventListener("DOMContentLoaded", initWarningBanner);
})();
