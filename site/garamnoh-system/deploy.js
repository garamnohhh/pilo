/* deploy.js — the vanilla behaviour layer for the static build.
   The authoring pages run on a component runtime; the deployed pages must not
   ship it. Everything the templates expressed as bindings is expressed here as
   data attributes, so the HTML stays static and this file stays small.

     [data-gn-toggle="theme|lang"]      a segmented control
     [data-gn-opt-theme="dark|light"]   one option inside it
     [data-gn-opt-lang="en|ko"]
     [data-gn-val="--token"]            printed value of a live custom property
     [data-gn-copy]                     copy the <pre> in the nearest [data-snippet]
     [data-gn-dialog="open|close"]      the demo dialog
     [data-gn-toast]                    push the demo toast
     [data-gn-mock-fit]                 scale mockups to the measured column
     [data-gn-slide="N"]                deck carousel thumbnail

   boot.js has already applied theme and language before first paint. This file
   only reacts to clicks and reflects state. */
(function () {
  var root = document.documentElement;
  var KO = function () { return root.getAttribute("data-lang") === "ko"; };

  /* ---------------------------------------------------------------- state */
  function reflect() {
    var theme = root.getAttribute("data-theme") || "dark";
    var lang = root.getAttribute("data-lang") || "en";
    each("[data-gn-opt-theme]", function (el) {
      el.setAttribute("aria-selected", el.getAttribute("data-gn-opt-theme") === theme ? "true" : "false");
    });
    each("[data-gn-opt-lang]", function (el) {
      el.setAttribute("aria-selected", el.getAttribute("data-gn-opt-lang") === lang ? "true" : "false");
    });
  }
  function each(sel, fn) {
    var n = document.querySelectorAll(sel);
    for (var i = 0; i < n.length; i++) fn(n[i]);
  }
  function set(kind, value) {
    if (kind === "theme") {
      root.setAttribute("data-theme", value);
      try { localStorage.setItem("garamnoh-system-mode", value); } catch (e) {}
    } else {
      root.setAttribute("data-lang", value);
      root.setAttribute("lang", value === "ko" ? "ko" : "en");
      try { localStorage.setItem("garamnoh-system-lang", value); } catch (e) {}
    }
    reflect();
    values();
    placeholders();
  }

  /* --------------------------------------------------------- placeholders
     A placeholder lives in an attribute, so it cannot hold the two-span
     bilingual pattern. Carry both and swap. */
  function placeholders() {
    var ko = KO();
    each("[data-ph-en]", function (el) {
      el.setAttribute("placeholder", el.getAttribute(ko ? "data-ph-ko" : "data-ph-en") || "");
    });
  }

  /* ------------------------------------------------------- token readout
     The specimen page prints the values it is styled by, so they cannot drift
     from what renders. Re-read on every theme change. */
  function values() {
    var cs = getComputedStyle(root);
    each("[data-gn-val]", function (el) {
      var v = (cs.getPropertyValue(el.getAttribute("data-gn-val")) || "").trim();
      el.textContent = v || "—";
    });
  }

  /* --------------------------------------------------------------- clicks */
  document.addEventListener("click", function (e) {
    var seg = e.target.closest ? e.target.closest("[data-gn-toggle]") : null;
    if (seg) {
      var kind = seg.getAttribute("data-gn-toggle");
      var opt = e.target.closest("[data-gn-opt-" + kind + "]");
      if (opt) return set(kind, opt.getAttribute("data-gn-opt-" + kind));
      /* clicking the control anywhere else flips it */
      var cur = root.getAttribute(kind === "theme" ? "data-theme" : "data-lang");
      if (kind === "theme") return set("theme", cur === "dark" ? "light" : "dark");
      return set("lang", cur === "en" ? "ko" : "en");
    }

    var copy = e.target.closest ? e.target.closest("[data-gn-copy]") : null;
    if (copy) return doCopy(copy);

    var dlg = e.target.closest ? e.target.closest("[data-gn-dialog]") : null;
    if (dlg) return dialog(dlg.getAttribute("data-gn-dialog") === "open");

    if (e.target.closest && e.target.closest("[data-gn-toast]")) return toast();

    var thumb = e.target.closest ? e.target.closest("[data-gn-slide]") : null;
    if (thumb) return goTo(parseInt(thumb.getAttribute("data-gn-slide"), 10));
  });

  /* ----------------------------------------------------------------- copy */
  function doCopy(btn) {
    /* a snippet block on the components page, or a .gn-code card in an install
       column — both hold exactly one <pre> */
    var box = btn.closest("[data-snippet]") || btn.closest(".gn-code");
    var code = box && box.querySelector("pre");
    if (!code) return;
    var text = code.textContent.trim();
    var label = '<span class="t-en">Copy</span><span class="t-ko">복사</span>';
    var flash = function (t) {
      btn.textContent = t;
      setTimeout(function () { btn.innerHTML = label; }, 1400);
    };
    var legacy = function () {
      var ta = document.createElement("textarea");
      ta.value = text; ta.setAttribute("readonly", "");
      ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select(); ta.setSelectionRange(0, text.length);
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (err) { ok = false; }
      document.body.removeChild(ta);
      if (ok) { flash(KO() ? "복사됨" : "Copied"); return true; }
      return false;
    };
    var selectCode = function () {
      try {
        var r = document.createRange();
        r.selectNodeContents(code);
        var sel = window.getSelection();
        sel.removeAllRanges(); sel.addRange(r);
      } catch (err) {}
      flash(KO() ? "직접 복사 ⌘C" : "Press ⌘C");
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { flash(KO() ? "복사됨" : "Copied"); },
        function () { if (!legacy()) selectCode(); }
      );
    } else if (!legacy()) selectCode();
  }

  /* --------------------------------------------------------------- dialog */
  function dialog(open) {
    var host = document.querySelector("[data-gn-dialog-host]");
    if (host) host.hidden = !open;
  }

  /* ---------------------------------------------------------------- toast
     One at a time, four seconds — the system's own rule. */
  var seq = 0;
  function toast() {
    var host = document.querySelector("[data-gn-toast-host]");
    if (!host) return;
    var id = ++seq;
    host.innerHTML =
      '<div class="gn-toast gn-toast-success">' +
        '<span class="gn-toast-icon">&#10003;</span>' +
        '<div><div class="gn-toast-title">' +
          '<span class="t-en">Deployed</span><span class="t-ko">배포 완료</span>' +
        '</div><div class="gn-toast-desc">e96ecaf · ' + (10 + id) + 's</div></div>' +
      '</div>';
    setTimeout(function () { if (seq === id) host.innerHTML = ""; }, 4000);
  }

  /* ------------------------------------------------------------- mock fit
     A screen mock is authored at --container and scaled to whatever the doc
     column gives it. zoom, not transform: zoom participates in layout, so the
     wrapper reserves the scaled height. Observe the element actually MEASURED —
     a body-bound observer never fires when only a grid column resizes. */
  var fitZoom = null, ro = null, observed = null;
  function fit() {
    var col = document.querySelector("[data-gn-mock-fit]");
    if (!col || !col.clientWidth) return;
    if (col !== observed) {
      if (ro) ro.disconnect();
      ro = new ResizeObserver(function () { requestAnimationFrame(fit); });
      ro.observe(col);
      observed = col;
    }
    var design = parseFloat(getComputedStyle(root).getPropertyValue("--container")) || 1120;
    var next = Math.round(Math.min(1, col.clientWidth / design) * 1000) / 1000;
    if (next === fitZoom) return;
    fitZoom = next;
    root.style.setProperty("--mock-zoom", next);
  }

  /* ----------------------------------------------------------- deck stage */
  function goTo(i) {
    var stage = document.querySelector("deck-stage");
    if (stage && typeof stage.goTo === "function") stage.goTo(i);
  }
  function deckWatch() {
    var secs = document.querySelectorAll("section[data-label]");
    if (!secs.length) return;
    var pos = document.querySelector("[data-gn-slide-pos]");
    var total = document.querySelector("[data-gn-slide-total]");
    if (total) total.textContent = pad(secs.length);
    var read = function () {
      var cur = 0;
      for (var i = 0; i < secs.length; i++) if (secs[i].hasAttribute("data-deck-active")) cur = i;
      if (pos) pos.textContent = pad(cur + 1);
      each("[data-gn-slide]", function (el) {
        el.setAttribute("aria-current", parseInt(el.getAttribute("data-gn-slide"), 10) === cur ? "true" : "false");
      });
      var active = document.querySelector('[data-gn-slide][aria-current="true"]');
      var rail = document.querySelector("[data-gn-rail]");
      if (active && rail) {
        var want = active.offsetLeft - (rail.clientWidth - active.offsetWidth) / 2;
        var max = rail.scrollWidth - rail.clientWidth;
        rail.scrollTo({ left: Math.max(0, Math.min(max, want)), behavior: "smooth" });
      }
    };
    var mo = new MutationObserver(read);
    for (var i = 0; i < secs.length; i++) {
      mo.observe(secs[i], { attributes: true, attributeFilter: ["data-deck-active"] });
    }
    read();
  }
  function pad(n) { return n < 10 ? "0" + n : String(n); }

  /* ------------------------------------------------------------------ run */
  function start() {
    reflect();
    values();
    placeholders();
    fit();
    requestAnimationFrame(fit);
    deckWatch();
    /* the deck stage upgrades asynchronously */
    setTimeout(deckWatch, 400);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else start();

  /* The language control is a pair of links so it still works without
     scripting and so each language has a real address. With scripting it never
     navigates: the document carries both languages, so the click swaps one
     attribute and rewrites the address in place. Nothing reloads, nothing
     moves — the same deal as the theme toggle. */
  each("[data-site-lang]", function (el) {
    el.addEventListener("click", function (ev) {
      var want = el.getAttribute("data-site-lang");
      if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button) return;
      /* Only the pages that carry both languages can swap in place. The rest
         still have a twin to walk to, so let the link be a link. */
      if (!document.querySelector(".l-ko")) return;
      ev.preventDefault();
      /* The two languages do not set to the same height, so holding the scroll
         offset would let the text slide under the reader. Hold the thing being
         looked at instead: the section at the top edge keeps its place, and the
         swap is one synchronous paint, so nothing is seen to move. */
      var mark = null, best = -1e9;
      each("[id]", function (sec) {
        var top = sec.getBoundingClientRect().top;
        if (top <= 1 && top > best) { best = top; mark = sec; }
      });
      setLang(want);
      if (mark) {
        var now = mark.getBoundingClientRect().top;
        if (Math.round(now - best)) window.scrollBy(0, now - best);
      }
      /* The address is worked out from the one in the bar, not from the
         link: after a swap the page is no longer where the link was written. */
      var path = location.pathname.replace(/(^|\/)en\//, "$1");
      if (want === "en") path = path.replace(/[^/]*$/, "en/$&").replace(/\/en\/$/, "/en/index.html");
      try { history.replaceState(null, "", path + location.search + location.hash); } catch (e) {}
      try { localStorage.setItem("garamnoh-system-lang", want); } catch (e) {}
    });
  });

  function setLang(want) {
    root.setAttribute("data-lang", want);
    root.setAttribute("lang", want === "ko" ? "ko" : "en");
    var m = document.querySelector('meta[name="pirep:title-' + want + '"]');
    if (m) document.title = m.getAttribute("content");
    each("[data-site-lang]", function (a) {
      if (a.getAttribute("data-site-lang") === want) a.setAttribute("data-active", "");
      else a.removeAttribute("data-active");
    });
  }
  setLang(root.getAttribute("data-lang") === "ko" ? "ko" : "en");
})();
