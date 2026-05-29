/* atmosphere.js — vanilla port of nerdz-landing/src/components/Atmosphere.tsx.

   Behaviour matches the React component:
     <body data-atm-default="all">       default ON, all layers
     <body data-atm-default="">          default OFF (no layers)
     ?atm=all                            every layer on
     ?atm=noise                          just film grain
     ?atm=aurora,grid                    subset (csv)
     ?atm=none                           explicit off (overrides default)

   Layers are injected into <main.page-stage> only if enabled.
   Runs on DOMContentLoaded — minimal flash on a dark velvet body. */
(function () {
  function build() {
    const main = document.querySelector("main.page-stage");
    if (!main) return;
    const params = new URLSearchParams(location.search);
    const queryAtm = params.get("atm");
    const defaultAtm = document.body.dataset.atmDefault || "";
    const atm =
      queryAtm === "none" ? "" : queryAtm != null ? queryAtm : defaultAtm;
    const enabled = new Set(
      atm.split(",").map(function (s) { return s.trim(); }).filter(Boolean)
    );
    if (!enabled.size) return;
    const all = enabled.has("all");
    const show = function (k) { return all || enabled.has(k); };

    const frag = document.createDocumentFragment();
    if (show("aurora")) {
      const a = document.createElement("div");
      a.className = "aurora"; a.setAttribute("aria-hidden", "true");
      a.innerHTML =
        '<div class="aurora__band aurora__band--a"></div>' +
        '<div class="aurora__band aurora__band--b"></div>' +
        '<div class="aurora__band aurora__band--c"></div>';
      frag.appendChild(a);
    }
    if (show("spotlight")) {
      const s = document.createElement("div");
      s.className = "spotlight"; s.setAttribute("aria-hidden", "true");
      frag.appendChild(s);
    }
    if (show("grid")) {
      const g = document.createElement("div");
      g.className = "gridfloor"; g.setAttribute("aria-hidden", "true");
      g.innerHTML =
        '<div class="gridfloor__lines"></div>' +
        '<div class="gridfloor__glow"></div>';
      frag.appendChild(g);
    }
    if (show("noise")) {
      const n = document.createElement("div");
      n.className = "noise"; n.setAttribute("aria-hidden", "true");
      frag.appendChild(n);
    }
    // Prepend so atmosphere paints under the main content.
    main.insertBefore(frag, main.firstChild);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", build);
  } else {
    build();
  }
})();
