// SketchyBar, when this Mac has it, hears from Pilo the moment something
// changes (`--trigger pilo_change`) instead of on its own fifteen-second clock.
// A Mac without it is asked once and never again; a failed trigger is dropped.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

const CANDIDATES = ["/opt/homebrew/bin/sketchybar", "/usr/local/bin/sketchybar"];
const GAP_MS = 300;
let bin;
let last = 0;
let queued = null;

export function ping(now = Date.now()) {
  if (bin === undefined) bin = process.env.PILO_SKETCHYBAR ?? CANDIDATES.find((p) => existsSync(p)) ?? "";
  if (!bin || queued) return;
  // a burst of changes is one trigger, at most one each GAP_MS
  queued = setTimeout(() => {
    queued = null;
    last = Date.now();
    execFile(bin, ["--trigger", "pilo_change"], { timeout: 2000 }, () => {});
  }, Math.max(0, last + GAP_MS - now));
  queued.unref?.();
}
