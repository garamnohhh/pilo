// Images the dashboard hands over. A browser can read its own clipboard and its
// own drops, so it sends the bytes here; they land beside the TUI's pasted
// screenshots and come back as a path, which is what an agent can open.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { attachmentDir, imageSize, prune } from "./clipboard.js";

export const MAX_BYTES = Number(process.env.PILO_ATTACH_MAX_BYTES || 10 * 1024 * 1024);

// What the bytes are, not what the request says they are.
const SIGNATURES = [
  ["png", (b) => b.length > 8 && b[0] === 0x89 && b.toString("latin1", 1, 4) === "PNG"],
  ["jpg", (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["gif", (b) => b.length > 6 && b.toString("latin1", 0, 4) === "GIF8"],
  ["webp", (b) => b.length > 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP"]
];

export function kindOf(buffer) {
  const hit = SIGNATURES.find(([, looks]) => looks(buffer));
  return hit ? hit[0] : null;
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");

// The server names the file; nothing the browser sends ends up in the path.
export const uploadName = (kind, rand = Math.floor(Math.random() * 1e6)) => `${stamp()}-dash-${rand}.${kind}`;

const tooBig = (max) => Object.assign(new Error(`an image can be at most ${Math.round(max / 1048576)}MB`), { status: 413 });

// Reads the body up to the limit. Past it the rest is drained, not kept, so the
// refusal can still be answered.
export function readUpload(req, max = MAX_BYTES) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers?.["content-length"] || 0) > max) {
      req.resume?.();
      return reject(tooBig(max));
    }
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size <= max) chunks.push(chunk);
    });
    req.on("end", () => (size > max ? reject(tooBig(max)) : resolve(Buffer.concat(chunks))));
    req.on("error", reject);
  });
}

export async function saveUpload(req) {
  if (!String(req.headers["content-type"] || "").startsWith("image/")) {
    req.resume();
    throw Object.assign(new Error("only images can be attached"), { status: 415 });
  }
  const buffer = await readUpload(req);
  const kind = kindOf(buffer);
  if (!kind) throw Object.assign(new Error("that is not a png, jpeg, gif or webp image"), { status: 415 });
  mkdirSync(attachmentDir, { recursive: true });
  prune();
  const file = join(attachmentDir, uploadName(kind));
  writeFileSync(file, buffer, { mode: 0o600 });
  const { width, height } = await imageSize(file);
  return { file, kind, bytes: buffer.length, width, height };
}
