/* blog-index.js — vanilla equivalent of blog-index.jsx's IndexPage interactivity:
   live search, category filter, cursor pagination ("load N more"). Reads all
   posts as DOM rendered by Hugo (each .post carries data-cat, data-title,
   data-subtitle, data-cat-display); JS toggles [hidden] to filter. */
(function () {
  const PAGE_SIZE = 8;

  const root      = document.getElementById("idx-root");
  if (!root) return;
  const input     = document.getElementById("idx-search");
  const clearBtn  = document.getElementById("idx-clear");
  const kbd       = document.getElementById("idx-kbd");
  const tagsEl    = document.getElementById("idx-tags");
  const wytEl     = document.getElementById("idx-wyt");
  const countEl   = document.getElementById("idx-count");
  const cursorEl  = document.getElementById("idx-cursor");
  const cursorBtn = document.getElementById("idx-cursor-btn");
  const cursorMeta= document.getElementById("idx-cursor-meta");
  const cursorEnd = document.getElementById("idx-cursor-end");
  const emptyEl   = document.getElementById("idx-empty");
  const tailEl    = document.getElementById("idx-tail-right");

  // Ordered (most recent first) — matches Hugo's RegularPages iteration.
  const posts = Array.from(root.querySelectorAll(".post"));
  const yrs   = Array.from(root.querySelectorAll(".yr"));
  const total = posts.length;

  let query  = "";
  let tag    = "all";
  let cursor = PAGE_SIZE;

  const isFiltering = () => !!query.trim() || tag !== "all";

  function matches(post) {
    if (tag !== "all" && post.dataset.cat !== tag) return false;
    if (query) {
      const hay = (post.dataset.title + " " + (post.dataset.subtitle || "") + " " + post.dataset.catDisplay).toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  }

  function render() {
    const filtering = isFiltering();
    let shown = 0;
    let matched = 0;
    for (const p of posts) {
      if (!matches(p)) {
        p.hidden = true;
        continue;
      }
      matched++;
      if (!filtering && shown >= cursor) {
        p.hidden = true;
        continue;
      }
      p.hidden = false;
      shown++;
    }
    // Hide year sections with no visible posts.
    for (const yr of yrs) {
      const anyVisible = yr.querySelector(".post:not([hidden])");
      yr.hidden = !anyVisible;
    }
    // Worth-your-time only when not filtering.
    if (wytEl) wytEl.hidden = filtering;
    // Empty state.
    if (emptyEl) emptyEl.hidden = matched > 0;
    // Counts.
    if (countEl) {
      countEl.innerHTML = filtering
        ? `<span class="gold">${matched}</span> of <span class="strike">${total}</span> match`
        : `showing <span class="gold">${shown}</span> of ${total}`;
    }
    // Cursor pagination.
    if (cursorEl && cursorBtn && cursorMeta && cursorEnd) {
      if (filtering) {
        cursorEl.hidden = true;
        cursorEnd.hidden = true;
      } else if (shown < total) {
        cursorEl.hidden = false;
        cursorEnd.hidden = true;
        const next = Math.min(PAGE_SIZE, total - shown);
        cursorBtn.firstChild && (cursorBtn.firstChild.nodeValue = "load " + next + " more");
        const lastVisible = posts.find((p) => !p.hidden && posts.indexOf(p) === shown - 1);
        cursorMeta.innerHTML = `<span><span class="gold">${shown}</span> of ${total} · cursor at ${lastVisible ? lastVisible.dataset.date : "—"}</span><span>oldest entry · ${posts[posts.length - 1].dataset.date}·${posts[posts.length - 1].dataset.year}</span>`;
      } else {
        cursorEl.hidden = true;
        cursorEnd.hidden = false;
      }
    }
    // Tail right caption.
    if (tailEl) {
      tailEl.textContent = filtering
        ? `filtered · ${matched} of ${total}`
        : `register · ${total} entries · since 2024`;
    }
    // Find input UI: show clear button or kbd hint.
    if (clearBtn && kbd) {
      clearBtn.hidden = !query;
      kbd.hidden = !!query;
    }
  }

  // Search input.
  if (input) {
    input.addEventListener("input", function (e) {
      query = e.target.value.trim().toLowerCase();
      cursor = PAGE_SIZE;
      render();
    });
  }
  if (clearBtn) {
    clearBtn.addEventListener("click", function () {
      query = "";
      if (input) input.value = "";
      render();
    });
  }

  // Tag chips.
  if (tagsEl) {
    tagsEl.addEventListener("click", function (e) {
      const btn = e.target.closest(".idx__tag");
      if (!btn) return;
      tag = btn.dataset.tag;
      cursor = PAGE_SIZE;
      Array.from(tagsEl.querySelectorAll(".idx__tag")).forEach(function (b) {
        b.classList.toggle("is-active", b.dataset.tag === tag);
        b.setAttribute("aria-selected", String(b.dataset.tag === tag));
      });
      render();
    });
  }

  // Cursor pagination.
  if (cursorBtn) {
    cursorBtn.addEventListener("click", function () {
      cursor += PAGE_SIZE;
      render();
    });
  }

  // `/` keyboard shortcut focuses the search input.
  document.addEventListener("keydown", function (e) {
    if (e.key === "/" && document.activeElement !== input && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      if (input) input.focus();
    }
  });

  // Reset buttons inside the empty state.
  if (emptyEl) {
    emptyEl.addEventListener("click", function (e) {
      if (e.target.matches("button[data-reset]")) {
        query = "";
        tag = "all";
        if (input) input.value = "";
        if (tagsEl) {
          Array.from(tagsEl.querySelectorAll(".idx__tag")).forEach(function (b) {
            b.classList.toggle("is-active", b.dataset.tag === "all");
          });
        }
        render();
      }
    });
  }

  render();
})();
