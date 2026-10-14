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


  /* 언어 전환. 이 페이지가 두 언어를 다 담고 있으면 문서를 떠나지 않는다 —
     속성 하나를 바꾸고 주소만 고쳐 쓴다. 테마 토글과 같은 조건이다.
     두 언어가 없는 페이지에서는 링크를 링크로 둔다. */
  function setLang(want) {
    root.setAttribute("data-lang", want);
    root.setAttribute("lang", want === "ko" ? "ko" : "en");
    var m = document.querySelector('meta[name="pirep:title-' + want + '"]');
    if (m) document.title = m.getAttribute("content");
    each("[data-site-lang]", function (a) {
      if (a.getAttribute("data-site-lang") === want) a.setAttribute("data-active", "");
      else a.removeAttribute("data-active");
      a.setAttribute("aria-current", a.getAttribute("data-site-lang") === want ? "true" : "false");
    });
  }
  each("[data-site-lang]", function (el) {
    el.addEventListener("click", function (ev) {
      var want = el.getAttribute("data-site-lang");
      if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button) return;
      if (!document.querySelector(".l-ko")) return;
      ev.preventDefault();
      /* 두 언어의 글 높이가 달라서 스크롤 값을 붙잡으면 글이 눈 밑으로 밀린다.
         화면 맨 위에 걸린 섹션을 잡아 두고, 바꾼 뒤 그 자리에 오게 맞춘다. */
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
      /* 주소는 지금 열려 있는 주소에서 만든다 — 링크에 적힌 값이 아니라. */
      var path = location.pathname.replace(/(^|\/)en\//, "$1");
      if (want === "en") path = path.replace(/[^/]*$/, "en/$&").replace(/\/en\/$/, "/en/index.html");
      try { history.replaceState(null, "", path + location.search + location.hash); } catch (e) {}
      try { localStorage.setItem("garamnoh-system-lang", want); } catch (e) {}
    });
  });
  setLang(root.getAttribute("data-lang") === "ko" ? "ko" : "en");

  /* gn-toc:start - 페이지 안 목차(.gn-page-nav)의 지금 읽는 절 표시. 원본: design-system/toc.js
     이 블록은 deploy.js · panels.js · 단독 HTML 문서에 글자 그대로 들어간다. 고치면 여기만 고치고
     tools/check-toc.mjs --copies 로 사본이 같은지 확인한다(다르면 경고).

     규칙(2026-10-14, task 3547):
     - 목차를 누르거나 주소의 해시로 열면 그 항목이 바로 활성이고, 사용자가 다시 스크롤할 때까지 유지된다.
       브라우저가 절을 scroll-margin-top 자리로 옮기면 절 윗변이 판정선에 소수점 차이로 걸쳐
       바로 앞 절이 남던 문제(누른 항목이 아니라 그 앞 항목이 켜짐)를 이걸로 없앤다.
     - 스크롤 중 판정선 = 그 절의 실제 scroll-margin-top + 2px. 선 위치를 css 와 따로 계산하지 않는다.
       scroll-margin-top 이 0 인 문서는 --topbar-h(없으면 54) + 24.
     - 페이지 끝에 닿으면 마지막 절(짧은 절이 판정선까지 못 올라오는 경우).
     - 목차가 여럿이거나 숨은 탭 안에 있어도 보이는 목차만 계산. 다시 계산: window.gnToc.update().
     - 목차 상자가 길어 안에서 스크롤되면 활성 항목을 상자 가운데로(바뀔 때만). */
  (function () {
    if (window.gnToc) return;
    var navs = [], pinned = null, ticking = false;
    function collect() {
      navs = [].slice.call(document.querySelectorAll(".gn-page-nav")).map(function (nav) {
        var items = [];
        [].slice.call(nav.querySelectorAll("a")).forEach(function (a) {
          var href = a.getAttribute("href") || "", id = href.charAt(0) === "#" ? href.slice(1) : (a.dataset.sec || "");
          var el = id && document.getElementById(decodeURIComponent(id));
          if (el) items.push({ a: a, el: el, id: el.id });
        });
        return { nav: nav, items: items };
      }).filter(function (n) { return n.items.length; });
    }
    function visible(el) { return !!(el.offsetParent || el.getClientRects().length); }
    function line(el) {
      var m = parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
      if (!m) m = (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--topbar-h")) || 54) + 24;
      return m + 2;
    }
    function pick(items) {
      if (pinned) for (var i = 0; i < items.length; i++) if (items[i].id === pinned) return items[i];
      var best = items[0];
      items.forEach(function (t) { if (visible(t.el) && t.el.getBoundingClientRect().top <= line(t.el)) best = t; });
      var doc = document.documentElement;
      if (window.innerHeight + window.scrollY >= Math.max(doc.scrollHeight, document.body.scrollHeight) - 2) best = items[items.length - 1];
      return best;
    }
    function update() {
      ticking = false;
      navs.forEach(function (n) {
        if (!visible(n.nav)) return;
        var cur = pick(n.items);
        n.items.forEach(function (t) {
          var on = t === cur ? "true" : "false";
          if (t.a.getAttribute("aria-current") !== on) t.a.setAttribute("aria-current", on);
        });
        /* a long nav scrolls in its own box: bring the marked entry into it, only on change */
        if (cur === n.last) return;
        n.last = cur;
        var box = n.nav;
        if (box.scrollHeight > box.clientHeight + 1)
          box.scrollTop = Math.max(0, Math.min(box.scrollHeight - box.clientHeight, cur.a.offsetTop - box.offsetTop - (box.clientHeight - cur.a.offsetHeight) / 2));
      });
    }
    function soon() { if (!ticking) { ticking = true; requestAnimationFrame(update); } }
    function pin(id) {
      var known = navs.some(function (n) { return n.items.some(function (t) { return t.id === id; }); });
      pinned = known ? id : null; update();
    }
    function start() {
      collect();
      if (!navs.length) return;
      document.addEventListener("click", function (e) {
        var a = e.target.closest && e.target.closest(".gn-page-nav a");
        if (!a) return;
        var href = a.getAttribute("href") || "";
        pin(href.charAt(0) === "#" ? decodeURIComponent(href.slice(1)) : (a.dataset.sec || ""));
      });
      window.addEventListener("hashchange", function () { pin(decodeURIComponent(location.hash.slice(1))); });
      /* the reader scrolls again: let the position decide */
      ["wheel", "touchmove", "keydown", "mousedown"].forEach(function (ev) {
        window.addEventListener(ev, function (e) {
          if (ev === "mousedown" && e.target.closest && e.target.closest(".gn-page-nav")) return;
          if (pinned) { pinned = null; soon(); }
        }, { passive: true });
      });
      window.addEventListener("scroll", soon, { passive: true });
      window.addEventListener("resize", soon);
      if (location.hash) pin(decodeURIComponent(location.hash.slice(1)));
      update();
    }
    window.gnToc = { update: function () { collect(); update(); } };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
  })();
  /* gn-toc:end */
})();
