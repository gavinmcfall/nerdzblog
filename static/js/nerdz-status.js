/* nerdz-status.js — the shell's live telemetry pill, as a framework-agnostic
   custom element. Used identically by the React app and the Hugo blog.
   SOURCE OF TRUTH: nerdz/docs/unified-shell-spec.md §4. Do not edit a copy;
   edit the spec, then re-sync both repos.

   Renders:  akl, nz · cluster <ok|warn|down> · up <Nd HH:MM:SS>
   Data:     GET /api/cluster  (same-origin everywhere — no CORS)
   States:   loading → "akl, nz · cluster … · up —"
             ok    when summary.healthy === summary.total && total > 0
             down  when summary.healthy === 0
             warn  otherwise
             total failure (never loaded) → "akl, nz" only; never throws */
(function () {
  if (customElements.get("nerdz-status")) return;

  var POLL_MS = 30000;

  function formatUptime(seconds) {
    if (!isFinite(seconds) || seconds <= 0) return "—"; // em-dash
    var days = Math.floor(seconds / 86400);
    var rest = Math.floor(seconds) - days * 86400;
    var h = String(Math.floor(rest / 3600) % 24).padStart(2, "0");
    var m = String(Math.floor(rest / 60) % 60).padStart(2, "0");
    var s = String(Math.floor(rest) % 60).padStart(2, "0");
    return days + "d " + h + ":" + m + ":" + s;
  }

  class NerdzStatus extends HTMLElement {
    connectedCallback() {
      this._status = undefined; // 'ok' | 'warn' | 'down' | undefined (loading)
      this._base = 0; // uptimeSeconds at last successful fetch
      this._at = 0; // Date.now() at last successful fetch
      this._loaded = false; // ever succeeded?
      this._failedFresh = false; // failed AND never succeeded
      this.render();
      this._poll = setInterval(() => this._fetch(), POLL_MS);
      this._tick = setInterval(() => this.render(), 1000);
      this._fetch();
    }

    disconnectedCallback() {
      clearInterval(this._poll);
      clearInterval(this._tick);
      if (this._abort) this._abort.abort();
    }

    async _fetch() {
      if (this._abort) this._abort.abort();
      this._abort = new AbortController();
      try {
        var res = await fetch("/api/cluster", {
          signal: this._abort.signal,
          cache: "no-store",
        });
        if (!res.ok) throw new Error("bad status");
        var data = await res.json();
        var sum = (data && data.summary) || {};
        this._base = sum.uptimeSeconds || 0;
        this._at = Date.now();
        var healthy = sum.healthy || 0;
        var total = sum.total || 0;
        this._status =
          total > 0 && healthy === total ? "ok" : healthy === 0 ? "down" : "warn";
        this._loaded = true;
        this._failedFresh = false;
        this.render();
      } catch (e) {
        if (this._abort && this._abort.signal.aborted) return; // superseded
        if (!this._loaded) {
          this._failedFresh = true;
          this.render();
        }
        // had prior success → keep showing last good values, never throw
      }
    }

    _uptime() {
      if (!this._loaded) return formatUptime(0); // em-dash while loading
      var elapsed = (Date.now() - this._at) / 1000;
      return formatUptime(this._base + elapsed);
    }

    render() {
      // Total failure before any success → identity mark only.
      if (this._failedFresh) {
        this.textContent = "akl, nz";
        return;
      }
      var status = this._status || "…"; // ellipsis while loading
      this.innerHTML =
        "<span>akl, nz</span>" +
        '<span class="sep">·</span>' +
        '<span>cluster <span class="gold">' +
        status +
        "</span></span>" +
        '<span class="sep">·</span>' +
        "<span>up " +
        this._uptime() +
        "</span>";
    }
  }

  customElements.define("nerdz-status", NerdzStatus);
})();
