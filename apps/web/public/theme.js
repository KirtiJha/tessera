// Applies the saved theme before the stylesheet paints, so a light console never flashes dark.
// Served as a file (not inline) because the server's Content-Security-Policy is script-src 'self'.
// Dark is the default; the landing page (/) is always light-on-paper and is left alone.
// Keep in step with resolveTheme in src/lib/theme.tsx.
(function () {
  try {
    var t = localStorage.getItem("tessera.theme");
    var light = t === '"light"' || (t === '"system"' && matchMedia("(prefers-color-scheme: light)").matches);
    if (light && location.pathname !== "/") document.documentElement.dataset.theme = "light";
  } catch (e) {}
})();
