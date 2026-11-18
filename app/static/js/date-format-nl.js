(() => {
  const ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function parseDateInput(value) {
    if (value == null || value === "") return null;
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) return null;
      return value;
    }
    const s = String(value).trim();
    if (!s) return null;
    const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(s);
    if (iso) {
      const y = Number(iso[1]);
      const m = Number(iso[2]);
      const d = Number(iso[3]);
      const dt = new Date(y, m - 1, d);
      if (Number.isNaN(dt.getTime())) return null;
      return dt;
    }
    const parsed = new Date(s);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed;
  }

  function formatDate(value, fallback = "") {
    const dt = parseDateInput(value);
    if (!dt) return fallback;
    return `${pad2(dt.getDate())}-${pad2(dt.getMonth() + 1)}-${dt.getFullYear()}`;
  }

  function formatTextContent(text) {
    if (!text || !ISO_DATE_RE.test(text)) {
      ISO_DATE_RE.lastIndex = 0;
      return text;
    }
    ISO_DATE_RE.lastIndex = 0;
    return text.replace(ISO_DATE_RE, (_full, y, m, d) => formatDate(`${y}-${m}-${d}`));
  }

  function shouldSkipNode(node) {
    if (!node || !node.parentElement) return true;
    const parent = node.parentElement;
    if (parent.closest("script, style, code, pre, textarea")) return true;
    return false;
  }

  function formatTextNodes(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const updates = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (shouldSkipNode(node)) continue;
      const original = node.nodeValue || "";
      const formatted = formatTextContent(original);
      if (formatted !== original) {
        updates.push([node, formatted]);
      }
    }
    updates.forEach(([node, formatted]) => {
      node.nodeValue = formatted;
    });
  }

  function formatInputValues(root) {
    const inputs = root.querySelectorAll('input[type="text"], input:not([type])');
    inputs.forEach((input) => {
      const value = input.value;
      const formatted = formatDate(value, value);
      if (formatted !== value) {
        input.value = formatted;
      }
    });
  }

  function formatDatesInDom(root = document.body) {
    if (!root) return;
    formatTextNodes(root);
    formatInputValues(root);
  }

  window.TADate = {
    formatDate,
  };
  window.formatDateNL = formatDate;
  window.applyDutchDateFormatting = formatDatesInDom;

  document.addEventListener("DOMContentLoaded", () => {
    formatDatesInDom(document.body);
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === "characterData" && mutation.target.nodeType === Node.TEXT_NODE) {
          const node = mutation.target;
          if (shouldSkipNode(node)) return;
          const original = node.nodeValue || "";
          const formatted = formatTextContent(original);
          if (formatted !== original) {
            node.nodeValue = formatted;
          }
          return;
        }
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            formatDatesInDom(node);
          } else if (node.nodeType === Node.TEXT_NODE && node.parentElement) {
            const original = node.nodeValue || "";
            const formatted = formatTextContent(original);
            if (formatted !== original) {
              node.nodeValue = formatted;
            }
          }
        });
      });
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  });
})();
