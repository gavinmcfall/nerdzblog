/* Theme toggle for the Hugo blog. Vanilla JS equivalent of nerdz-landing's
   ThemeToggle.tsx — same localStorage key ('nerdz-theme') and same html
   [data-theme] attribute so the no-flash script + the toggle stay in sync
   across both surfaces. */
(function () {
  // The sun/moon SVGs in /partials/theme-toggle.html are visible/hidden via
  // CSS based on [data-theme] — see static/css/shell.css. This script only
  // mutates the attribute + persists the choice.
  function applyTheme(t) {
    if (t === "light") {
      document.documentElement.setAttribute("data-theme", "light");
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
    try { localStorage.setItem("nerdz-theme", t); } catch (e) { /* private mode */ }
  }
  window.toggleTheme = function () {
    var current = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
    applyTheme(current === "light" ? "dark" : "light");
  };
})();
