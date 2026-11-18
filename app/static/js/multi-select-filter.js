(() => {
  class TAMultiSelectFilter {
    constructor(config) {
      this.selectEl = config?.selectEl || null;
      this.placeholderAll = String(config?.placeholderAll || "Alle");
      this.searchPlaceholder = String(config?.searchPlaceholder || "Zoek...");
      this.itemLabelSingle = String(config?.itemLabelSingle || "selectie");
      this.itemLabelPlural = String(config?.itemLabelPlural || "selecties");
      this.enableSelectAll = config?.enableSelectAll !== false;
      this.selected = new Set();
      this.options = [];
      this.onChange = typeof config?.onChange === "function" ? config.onChange : null;
      this.boundDocClick = (evt) => this.handleDocumentClick(evt);
      this.boundSearchInput = () => this.renderOptions();
      if (!this.selectEl) return;
      this.build();
      this.syncOptionsFromSelect();
    }

    build() {
      this.selectEl.classList.add("ta-ms-native-hidden");
      const wrapper = document.createElement("div");
      wrapper.className = "ta-ms";
      wrapper.dataset.targetId = this.selectEl.id || "";
      wrapper.innerHTML = `
        <button type="button" class="form-select form-select-sm text-start ta-ms-toggle" aria-haspopup="listbox" aria-expanded="false"></button>
        <div class="ta-ms-menu d-none" role="listbox">
          <input type="search" class="form-control form-control-sm ta-ms-search" autocomplete="off" />
          <div class="ta-ms-actions"></div>
          <div class="ta-ms-options"></div>
        </div>
      `;
      this.wrapper = wrapper;
      this.toggleEl = wrapper.querySelector(".ta-ms-toggle");
      this.menuEl = wrapper.querySelector(".ta-ms-menu");
      this.searchEl = wrapper.querySelector(".ta-ms-search");
      this.actionsEl = wrapper.querySelector(".ta-ms-actions");
      this.optionsEl = wrapper.querySelector(".ta-ms-options");
      this.searchEl.placeholder = this.searchPlaceholder;
      this.selectEl.insertAdjacentElement("afterend", wrapper);
      this.toggleEl.addEventListener("click", () => this.toggleMenu());
      this.searchEl.addEventListener("input", this.boundSearchInput);
      document.addEventListener("click", this.boundDocClick);
      this.renderActions();
      this.renderToggleText();
    }

    destroy() {
      document.removeEventListener("click", this.boundDocClick);
      this.searchEl?.removeEventListener("input", this.boundSearchInput);
      if (this.wrapper && this.wrapper.parentNode) this.wrapper.parentNode.removeChild(this.wrapper);
      if (this.selectEl) this.selectEl.classList.remove("ta-ms-native-hidden");
    }

    syncOptionsFromSelect() {
      if (!this.selectEl) return;
      const prev = new Set(this.selected);
      this.options = [...this.selectEl.options]
        .map((opt) => ({ value: String(opt.value || ""), label: String(opt.textContent || "").trim() }))
        .filter((opt) => opt.value !== "");
      this.selected.clear();
      this.options.forEach((opt) => {
        if (prev.has(opt.value)) this.selected.add(opt.value);
      });
      this.syncSelectElement();
      this.renderOptions();
      this.renderToggleText();
    }

    setOptions(options) {
      if (!this.selectEl) return;
      this.selectEl.innerHTML = "";
      const opts = Array.isArray(options) ? options : [];
      opts.forEach((opt) => {
        const value = String(opt?.value || "");
        const label = String(opt?.label || value);
        const node = document.createElement("option");
        node.value = value;
        node.textContent = label;
        this.selectEl.appendChild(node);
      });
      this.syncOptionsFromSelect();
    }

    setValue(values, { triggerChange = false } = {}) {
      const next = new Set((Array.isArray(values) ? values : []).map((v) => String(v)));
      this.selected.clear();
      this.options.forEach((opt) => {
        if (next.has(opt.value)) this.selected.add(opt.value);
      });
      this.syncSelectElement();
      this.renderOptions();
      this.renderToggleText();
      if (triggerChange) this.emitChange();
    }

    getValue() {
      return this.options.filter((opt) => this.selected.has(opt.value)).map((opt) => opt.value);
    }

    clear({ triggerChange = false } = {}) {
      this.selected.clear();
      this.syncSelectElement();
      this.renderOptions();
      this.renderToggleText();
      if (triggerChange) this.emitChange();
    }

    handleDocumentClick(evt) {
      if (!this.wrapper) return;
      const target = evt.target;
      if (!(target instanceof Node)) return;
      if (!this.wrapper.contains(target)) this.closeMenu();
    }

    toggleMenu() {
      if (!this.menuEl || !this.toggleEl) return;
      const isClosed = this.menuEl.classList.contains("d-none");
      if (isClosed) this.openMenu();
      else this.closeMenu();
    }

    openMenu() {
      if (!this.menuEl || !this.toggleEl) return;
      this.menuEl.classList.remove("d-none");
      this.toggleEl.setAttribute("aria-expanded", "true");
      this.renderOptions();
      if (this.searchEl) {
        this.searchEl.focus();
        this.searchEl.select();
      }
    }

    closeMenu() {
      if (!this.menuEl || !this.toggleEl) return;
      this.menuEl.classList.add("d-none");
      this.toggleEl.setAttribute("aria-expanded", "false");
    }

    renderActions() {
      if (!this.actionsEl) return;
      if (!this.enableSelectAll) {
        this.actionsEl.innerHTML = "";
        return;
      }
      this.actionsEl.innerHTML = `
        <button type="button" class="btn btn-link btn-sm p-0 ta-ms-link" data-ta-ms-action="all">Alles selecteren</button>
        <button type="button" class="btn btn-link btn-sm p-0 ta-ms-link" data-ta-ms-action="clear">Wissen</button>
      `;
      this.actionsEl.querySelector('[data-ta-ms-action="all"]')?.addEventListener("click", (evt) => {
        evt.preventDefault();
        this.options.forEach((opt) => this.selected.add(opt.value));
        this.syncSelectElement();
        this.renderOptions();
        this.renderToggleText();
        this.emitChange();
      });
      this.actionsEl.querySelector('[data-ta-ms-action="clear"]')?.addEventListener("click", (evt) => {
        evt.preventDefault();
        this.clear({ triggerChange: true });
      });
    }

    renderOptions() {
      if (!this.optionsEl) return;
      const q = String(this.searchEl?.value || "")
        .trim()
        .toLowerCase();
      const filtered = this.options.filter((opt) => !q || opt.label.toLowerCase().includes(q));
      if (!filtered.length) {
        this.optionsEl.innerHTML = '<div class="ta-ms-empty">Geen resultaten</div>';
        return;
      }
      this.optionsEl.innerHTML = "";
      const frag = document.createDocumentFragment();
      filtered.forEach((opt) => {
        const row = document.createElement("label");
        row.className = "ta-ms-option";
        row.innerHTML = `<input type="checkbox" class="form-check-input" /> <span></span>`;
        const input = row.querySelector("input");
        const text = row.querySelector("span");
        input.checked = this.selected.has(opt.value);
        input.addEventListener("change", () => {
          if (input.checked) this.selected.add(opt.value);
          else this.selected.delete(opt.value);
          this.syncSelectElement();
          this.renderToggleText();
          this.emitChange();
        });
        text.textContent = opt.label;
        frag.appendChild(row);
      });
      this.optionsEl.appendChild(frag);
    }

    syncSelectElement() {
      if (!this.selectEl) return;
      const values = this.selected;
      [...this.selectEl.options].forEach((opt) => {
        opt.selected = values.has(String(opt.value || ""));
      });
      const list = this.getValue();
      this.selectEl.dataset.taMultiValues = list.join(",");
      this.selectEl.value = list[0] || "";
    }

    renderToggleText() {
      if (!this.toggleEl) return;
      const count = this.selected.size;
      if (count <= 0) {
        this.toggleEl.textContent = this.placeholderAll;
        return;
      }
      if (count === 1) {
        const only = this.options.find((opt) => this.selected.has(opt.value));
        this.toggleEl.textContent = only ? only.label : `1 ${this.itemLabelSingle}`;
        return;
      }
      this.toggleEl.textContent = `${count} ${this.itemLabelPlural}`;
    }

    emitChange() {
      if (this.onChange) this.onChange(this.getValue());
      this.selectEl?.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  window.TAMultiSelectFilter = TAMultiSelectFilter;
})();
