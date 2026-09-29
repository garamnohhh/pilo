/* pilo 첫 화면 모션 — 데스크 한 사이클. <div class="pmo" id="pmo"></div> 바로 뒤에서 불러 채운다(docs/motion/index.html).
   순서·상태 이름은 격리 데모 pilo 에서 실제로 돌려 받아 적은 그대로(queued → running → done · final_reply).
   ko/en 두 문서가 같은 파일을 쓴다. 마크업 원본은 여기 하나. */
(function () {
  var root = document.getElementById("pmo");
  if (!root) return;
  var IMG = '<img class="rt" src="claude.png" alt="Claude Code">';
  root.innerHTML =
'<div class="desk" id="pmo-d" aria-hidden="true">' +
 '<div class="d-top">' +
  '<span class="brand" data-product="pilo"><span class="pilo-wordmark"><b>❯</b>pilo</span></span>' +
  '<span class="st"><span class="spin" style="color:var(--ok)">●</span><span class="n">3</span> agents</span>' +
  '<span class="st" id="pmo-wait" style="opacity:0"><span class="n">1</span> waiting</span>' +
  '<span class="right"><span class="k">⌘K</span><span>updated 15:18</span></span>' +
 '</div>' +
 '<div class="shell">' +
  '<div class="rail">' +
   '<div class="railbtn" data-now><span class="i"></span><span class="l">work</span></div>' +
   '<div class="railbtn"><span class="i"></span><span class="l">agents</span></div>' +
   '<div class="railbtn" id="pmo-req"><span class="i"></span><span class="l">requests</span><span class="badge">1</span></div>' +
   '<div class="railbtn"><span class="i"></span><span class="l">schedules</span></div>' +
   '<div class="railbtn"><span class="i"></span><span class="l">events</span></div>' +
  '</div>' +
  '<div class="right-of-rail">' +
   '<div class="desk-strip">' +
    '<div class="stat"><span class="k">REQUESTS TODAY</span><span class="v"><b id="pmo-s-req">0</b><small id="pmo-s-req2">0 answered</small></span></div>' +
    '<div class="stat"><span class="k">IN FLIGHT</span><span class="v"><b id="pmo-s-fly">0</b><small id="pmo-s-fly2">nothing on</small></span></div>' +
    '<div class="stat"><span class="k">TOKENS</span><span class="v"><b id="pmo-s-tok">0</b><small>today</small></span></div>' +
    '<div class="stat"><span class="k">NEEDS YOU</span><span class="v"><b class="red">0</b><small>nothing waiting</small></span></div>' +
   '</div>' +
   '<div class="below">' +
    '<div class="agents">' +
     '<div class="hd"><span class="t">agents</span><span class="c">1 pilo · 2 pm · 0 worker</span></div>' +
     '<div class="list">' +
      '<div class="ag" data-ag="pilo" data-role="pilo"><span class="spin"></span>' + IMG + '<span class="nm">pilo</span><span class="chip">PILO</span></div>' +
      '<div class="ag child" data-ag="shop"><span class="tee">└</span><span class="spin"></span>' + IMG + '<span class="nm">shop</span><span class="chip">PM</span></div>' +
      '<div class="ag child" data-ag="notes"><span class="tee">└</span><span class="spin"></span>' + IMG + '<span class="nm">notes</span><span class="chip">PM</span></div>' +
     '</div>' +
    '</div>' +
    '<div class="main">' +
     '<div class="feed">' +
      '<div class="row" data-r="1"><div class="ask" id="pmo-posted"></div></div>' +
      '<div class="row" data-r="2"><div class="meta"><span>PILO · 15:18</span></div>' +
       '<div class="said"><span class="l-en">received · the desk agent is looking</span><span class="l-ko">요청 접수 · 대표 agent 확인 중</span></div></div>' +
      '<div class="row" data-r="3"><div class="meta"><span>PILO · 15:18</span><span class="l-en">↳ handed to shop</span><span class="l-ko">↳ shop 에 넘김</span></div>' +
       '<div class="said work"><span class="l-en">working · waiting on the result</span><span class="l-ko">작업 중 · 결과 대기</span></div></div>' +
      '<div class="row" data-r="4"><div class="meta"><span>SHOP ·</span><span class="amber">running</span><span>· 15:18</span></div>' +
       '<div class="said work"><span class="l-en">going through the listings with no image</span><span class="l-ko">이미지 없는 상품 훑는 중</span></div></div>' +
      '<div class="row" data-r="5"><div class="meta"><span>PILO · 15:18</span><span class="green">↳ final reply</span></div>' +
       '<div class="said ans"><span class="l-en">Listed the 27 listings with no image. 9 of them are already off sale.</span><span class="l-ko">이미지 없는 상품 27개를 목록으로 남겼어요. 그중 9개는 이미 판매 중지 상태입니다.</span></div></div>' +
     '</div>' +
     '<div class="composer" id="pmo-cmp">' +
      '<span class="p">❯</span><span class="typed" id="pmo-typed"></span><span class="cur"></span>' +
      '<span class="ghostbox"><span class="l-en">Type what you want done</span><span class="l-ko">무엇이든 물어보세요</span></span>' +
      '<span class="send">ENTER to send</span>' +
     '</div>' +
    '</div>' +
   '</div>' +
  '</div>' +
 '</div>' +
'</div>' +
'<p class="gn-mono cap" style="font-size:11px;color:var(--text-3)">' +
 '<span><span class="l-en">a drawing of the real screen</span><span class="l-ko">실제 화면을 옮긴 그림이에요</span></span>' +
 '<button type="button" class="replay" id="pmo-play"><span class="l-en">play again</span><span class="l-ko">다시 보기</span></button>' +
'</p>';

  var ASK = { ko: "이미지 없는 상품을 목록으로 뽑아 줘.", en: "List the listings with no image." };
  var reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  function lang() { return document.documentElement.getAttribute("data-lang") === "ko" ? "ko" : "en"; }
  function $(s) { return root.querySelector(s); }
  function all(s) { return root.querySelectorAll(s); }

  var T = [];
  function reset() {
    T.forEach(clearTimeout); T = [];
    all(".row").forEach(function (r) { r.removeAttribute("data-on"); });
    all(".ag").forEach(function (a) { a.removeAttribute("data-s"); });
    $("#pmo-typed").textContent = "";
    // 높이 고정: 올라갈 글을 처음부터 넣어 둔다. 줄은 숨겨져 있어도 자리는 차지하니 엔터 전후 높이가 같다.
    $("#pmo-posted").textContent = ASK[lang()];
    stat(0, 0, 0, "0"); $("#pmo-req").removeAttribute("data-n"); $("#pmo-wait").style.opacity = 0;
    $("#pmo-cmp").removeAttribute("data-sent"); $("#pmo-cmp").removeAttribute("data-typing");
  }
  function on(n) { $('.row[data-r="' + n + '"]').setAttribute("data-on", ""); }
  function agent(name, s) { $('.ag[data-ag="' + name + '"]').setAttribute("data-s", s); }
  function stat(req, ans, fly, tok) {
    $("#pmo-s-req").textContent = req; $("#pmo-s-req2").textContent = ans + " answered";
    $("#pmo-s-fly").textContent = fly; $("#pmo-s-fly2").textContent = fly ? "in flight" : "nothing on";
    $("#pmo-s-tok").textContent = tok;
  }

  function play() {
    reset();
    var text = ASK[lang()];
    var at = function (ms, fn) { T.push(setTimeout(fn, ms)); };
    if (reduce) {                       // 움직임 줄이기 — 마지막 상태로
      [1, 2, 3, 4, 5].forEach(on);
      stat(1, 1, 0, "5.1k"); agent("pilo", "done"); agent("shop", "done");
      $("#pmo-cmp").setAttribute("data-sent", "");
      return;
    }
    // 1. 아래 입력칸에 타이핑
    $("#pmo-cmp").setAttribute("data-typing", "");
    var i = 0, step = 45, el = $("#pmo-typed");
    (function type() {
      el.textContent = text.slice(0, i);
      if (i++ <= text.length) T.push(setTimeout(type, step));
    })();
    var typed = text.length * step + 300;
    // 2. 엔터 — 입력칸이 비고 그 글이 피드로 올라감
    at(typed, function () {
      el.textContent = "";
      $("#pmo-cmp").removeAttribute("data-typing"); $("#pmo-cmp").setAttribute("data-sent", "");
      on(1); stat(1, 0, 0, "0"); $("#pmo-req").setAttribute("data-n", "");
    });
    // 3. 데스크가 접수 (inbox queued)
    at(typed + 700, function () { agent("pilo", "running"); on(2); });
    // 4. 담당에게 넘김 (inbox dispatched · task queued)
    at(typed + 2000, function () { agent("shop", "queued"); on(3); stat(1, 0, 1, "0"); $("#pmo-wait").style.opacity = 1; });
    // 5. PM 이 돌기 시작 (task running)
    at(typed + 3400, function () { agent("shop", "running"); on(4); stat(1, 0, 1, "2.4k"); });
    // 6. 끝나고 최종 답은 pilo 가 (task done · inbox replied)
    at(typed + 6200, function () { agent("shop", "done"); });
    at(typed + 6700, function () {
      agent("pilo", "done"); on(5); stat(1, 1, 0, "5.1k");
      $("#pmo-wait").style.opacity = 0; $("#pmo-req").removeAttribute("data-n");
    });
  }

  reset();
  $("#pmo-play").addEventListener("click", play);
  /* KO/EN 전환은 문서를 떠나지 않고 data-lang 만 바꾼다. 그 언어로 다시 돌린다. */
  new MutationObserver(play).observe(document.documentElement, { attributes: true, attributeFilter: ["data-lang"] });
  /* 자동 재생은 한 번만 */
  var io = new IntersectionObserver(function (es) {
    if (es[0].isIntersecting) { io.disconnect(); play(); }
  }, { threshold: .35 });
  io.observe($("#pmo-d"));
})();
