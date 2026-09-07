// The terminal never hands an image to the program running inside it. Every
// terminal drops image flavours on paste and sends text or nothing at all, so
// the only way to reach a screenshot sitting on the clipboard is to go and read
// the clipboard ourselves. macOS has no command-line tool that returns image
// bytes — pbpaste is text only — so this asks AppKit through osascript, which
// ships with the system and needs nothing installed.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { home } from "./paths.js";

const run = promisify(execFile);

export const attachmentDir = join(home, "attachments");

// PNG first, because that is what a screenshot puts there. Anything else that
// draws (a TIFF from Preview, a JPEG from a browser) goes through a bitmap rep
// and comes back out as PNG, so the rest of Pilo only ever sees one format.
const READ_MACOS = `
ObjC.import('AppKit');
function run(argv) {
  const pb = $.NSPasteboard.generalPasteboard;
  const types = ObjC.deepUnwrap(pb.types) || [];
  const image = ['public.png', 'public.tiff', 'public.jpeg'].some((t) => types.indexOf(t) >= 0);
  if (!image) return types.indexOf('public.utf8-plain-text') >= 0 ? 'text' : 'empty';
  let data = types.indexOf('public.png') >= 0 ? pb.dataForType('public.png') : null;
  if (!data) {
    const img = $.NSImage.alloc.initWithPasteboard(pb);
    const rep = $.NSBitmapImageRep.imageRepWithData(img.TIFFRepresentation);
    data = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary);
  }
  const rep = $.NSBitmapImageRep.imageRepWithData(data);
  data.writeToFileAtomically(argv[0], true);
  return 'image ' + rep.pixelsWide + ' ' + rep.pixelsHigh + ' ' + data.length;
}
`;

// Linux keeps its clipboard in the display server, so the tool depends on which
// one is running. Both write the bytes straight to stdout.
const LINUX = [
  { cmd: "wl-paste", args: ["--type", "image/png", "--no-newline"] },
  { cmd: "xclip", args: ["-selection", "clipboard", "-t", "image/png", "-o"] }
];

async function readLinux(file) {
  const { writeFileSync } = await import("node:fs");
  for (const { cmd, args } of LINUX) {
    try {
      const { stdout } = await run(cmd, args, { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
      if (!stdout?.length || stdout.slice(0, 4).toString("latin1") !== "\x89PNG") continue;
      writeFileSync(file, stdout);
      return { file, bytes: stdout.length, width: 0, height: 0 };
    } catch {
      // The tool is missing or the clipboard holds no image; try the next one.
    }
  }
  return null;
}

// Anything older than a fortnight is a screenshot nobody came back for.
const KEEP_MS = 14 * 24 * 60 * 60 * 1000;

export function prune(now = Date.now()) {
  let gone = 0;
  try {
    for (const name of readdirSync(attachmentDir)) {
      const path = join(attachmentDir, name);
      try {
        if (now - statSync(path).mtimeMs <= KEEP_MS) continue;
        unlinkSync(path);
        gone += 1;
      } catch {
        // A file that vanished under us needs no deleting.
      }
    }
  } catch {
    // No directory yet, so nothing to prune.
  }
  return gone;
}

// A drop puts the file's path into the prompt as text. Terminals quote it three
// different ways, so all three are unpicked before the path is looked up.
const IMAGE = /\.(png|jpe?g|gif|webp|heic|bmp|tiff?)$/i;

export function droppedPaths(text, exists = existsSync) {
  const trimmed = String(text).trim();
  if (!trimmed || trimmed.includes("\n")) return [];
  const found = [];
  let current = "";
  let quote = "";
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === "\\" && !quote) {
      current += trimmed[++i] ?? "";
    } else if (quote) {
      if (ch === quote) quote = "";
      else current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === " ") {
      if (current) found.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) found.push(current);
  if (!found.length || !found.every((f) => f.startsWith("/") && IMAGE.test(f) && exists(f))) return [];
  return found;
}

// sips ships with macOS and reads the header without decoding the image.
export async function imageSize(file) {
  if (process.platform !== "darwin") return { width: 0, height: 0 };
  try {
    const { stdout } = await run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file]);
    const width = /pixelWidth:\s*(\d+)/.exec(stdout);
    const height = /pixelHeight:\s*(\d+)/.exec(stdout);
    return { width: Number(width?.[1]) || 0, height: Number(height?.[1]) || 0 };
  } catch {
    return { width: 0, height: 0 };
  }
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");

// Returns the saved image, or a word saying why there was none: "text" when the
// clipboard holds text the terminal has already pasted, "empty" otherwise.
export async function clipboardImage() {
  mkdirSync(attachmentDir, { recursive: true });
  prune();
  const file = join(attachmentDir, `${stamp()}-${process.pid}-${Math.floor(Math.random() * 1e4)}.png`);
  if (process.platform !== "darwin") {
    const found = await readLinux(file);
    return found || { miss: "empty" };
  }
  try {
    const { stdout } = await run("osascript", ["-l", "JavaScript", "-e", READ_MACOS, file]);
    const out = stdout.trim();
    if (!out.startsWith("image ")) return { miss: out || "empty" };
    const [, width, height, bytes] = out.split(" ");
    return { file, width: Number(width), height: Number(height), bytes: Number(bytes) };
  } catch (err) {
    return { miss: "empty", error: err.message };
  }
}
