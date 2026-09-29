// README GIF 녹화. 가상 시계로 한 칸씩 넘기며 찍어서 프레임 간격이 정확하다.
//   python3 -m http.server -d . 4186 &            (저장소 루트에서)
//   NODE_PATH=<puppeteer 있는 node_modules> node docs/motion/record.cjs light|dark <frames 폴더>
//   그다음 GIF 는 파일 끝의 ffmpeg 명령.
const puppeteer = require("puppeteer");
const theme = process.argv[2] || "light", out = process.argv[3] || "frames-" + theme;
const FPS = 10, STEP = 1000 / FPS;
const CYCLE = 8440, HOLD = 3500; // 타이핑 32자×45ms+300 → 최종 답 +6700ms. 끝에서 3.5초 멈춤.

(async () => {
  require("fs").mkdirSync(out, { recursive: true });
  const b = await puppeteer.launch({ headless: "new" });
  const p = await b.newPage();
  await p.setViewport({ width: 900, height: 800, deviceScaleFactor: 2 });
  await p.goto(`http://127.0.0.1:4186/docs/motion/?theme=${theme}`, { waitUntil: "networkidle0" });
  await p.evaluate(() => document.fonts.ready);
  const clip = await p.evaluate(() => {
    const r = document.getElementById("pmo-d").getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const cdp = await p.target().createCDPSession();
  await cdp.send("Emulation.setVirtualTimePolicy", { policy: "pause" });
  await p.evaluate(() => document.getElementById("pmo-play").click());
  const n = Math.round((CYCLE + HOLD) / STEP);
  for (let i = 0; i < n; i++) {
    await p.screenshot({ path: `${out}/f${String(i).padStart(4, "0")}.png`, clip });
    const done = new Promise((r) => cdp.once("Emulation.virtualTimeBudgetExpired", r));
    await cdp.send("Emulation.setVirtualTimePolicy", { policy: "advance", budget: STEP });
    await done;
  }
  console.log(`${n} frames · ${clip.width}×${clip.height} css px ×2`);
  await b.close();
})();

// 가끔 첫 스크린샷이 timeout 으로 멈춘다 — 다시 돌리면 된다.
// ffmpeg -framerate 10 -i frames-light/f%04d.png -vf "split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle" -loop 0 docs/screenshots/cycle-light.gif
