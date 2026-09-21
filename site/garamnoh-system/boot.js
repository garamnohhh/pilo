/* Theme and language, settled BEFORE first paint.
   Applying them from a component's mount is what makes page-to-page
   navigation flash. Loaded with a plain <script src> in <head> so it is
   synchronous: the attributes are on <html> before the first frame.
   Storage keys are shared across every page of the system. */
(function () {
  var r = document.documentElement, t, l;
  try { t = localStorage.getItem("garamnoh-system-mode"); } catch (e) {}
  try { l = localStorage.getItem("garamnoh-system-lang"); } catch (e) {}
  r.setAttribute("data-theme", t === "light" || t === "dark" ? t : "light");

  var inEn = /(^|\/)en\//.test(location.pathname);
  var both = r.hasAttribute("data-bilingual");
  var twin = function () {
    return location.pathname.replace(/[^/]*$/, "en/$&").replace(/\/en\/$/, "/en/index.html");
  };

  if (inEn) {
    l = "en";
  } else if (both) {
    /* Both languages are in this page: the address says which one shows, and a
       first visit gets English. Correct the address in place — no navigation,
       no history entry — so returning to it later reads the same. */
    l = l === "ko" || l === "en" ? l : "en";
    /* Correcting the address has to wait for the parser. Every asset on this
       page is a relative path, so rewriting the address from here would make
       the browser resolve them against /en/ — a folder that does not hold
       them — and the page would come up unstyled. By DOMContentLoaded every
       URL has been resolved and the swap is safe. */
    if (l === "en") {
      document.addEventListener("DOMContentLoaded", function () {
        try { history.replaceState(null, "", twin() + location.search + location.hash); } catch (e) {}
      });
    }
  } else if (!l) {
    /* Pages that still keep their languages in two files have a twin to walk
       to. A first visit goes to the English one. */
    location.replace(twin() + location.search + location.hash);
    return;
  } else {
    l = l === "ko" ? "ko" : "en";
  }

  r.setAttribute("data-lang", l);
  r.setAttribute("lang", l === "ko" ? "ko" : "en");
})();
