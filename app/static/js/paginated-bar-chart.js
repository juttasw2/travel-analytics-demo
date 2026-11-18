(function (g) {
  class TAPaginatedChartData {
    constructor(pageSize = 10) {
      this.pageSize = Number(pageSize) > 0 ? Number(pageSize) : 10;
      this.offset = 0;
      this.items = [];
    }

    setItems(items) {
      this.items = Array.isArray(items) ? items.slice() : [];
      this.offset = 0;
      this._clampOffset();
    }

    setOffset(offset) {
      this.offset = Number.isFinite(offset) ? Number(offset) : 0;
      this._clampOffset();
    }

    _clampOffset() {
      if (this.items.length <= this.pageSize) {
        this.offset = 0;
        return;
      }
      const maxOffset = Math.floor((this.items.length - 1) / this.pageSize) * this.pageSize;
      this.offset = Math.max(0, Math.min(this.offset, maxOffset));
    }

    nextPage() {
      this.setOffset(this.offset + this.pageSize);
    }

    prevPage() {
      this.setOffset(this.offset - this.pageSize);
    }

    canPrev() {
      return this.offset > 0;
    }

    canNext() {
      return this.offset + this.pageSize < this.items.length;
    }

    getWindow() {
      return this.items.slice(this.offset, this.offset + this.pageSize);
    }

    getInfo() {
      if (!this.items.length) return { start: 0, end: 0, total: 0 };
      const start = this.offset + 1;
      const end = Math.min(this.offset + this.pageSize, this.items.length);
      return { start, end, total: this.items.length };
    }
  }

  g.TAPaginatedChartData = TAPaginatedChartData;
})(typeof globalThis !== "undefined" ? globalThis : this);
