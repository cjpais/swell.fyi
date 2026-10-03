#!/usr/bin/env node
// Upload a large file to R2 in parts through the temporary swell-upload Worker.
//   UPLOAD_TOKEN=... node scripts/r2-upload.mjs tiles/taiwan.pmtiles taiwan.pmtiles
import { open, stat } from "node:fs/promises";

const [file, key] = process.argv.slice(2);
const BASE = process.env.UPLOAD_URL ?? "https://upload.swell.fyi";
const TOKEN = process.env.UPLOAD_TOKEN;
const PART = 64 * 1024 * 1024; // R2 needs equal-sized parts (except the last); Workers accept ≤100 MB bodies
if (!file || !key || !TOKEN) throw new Error("usage: UPLOAD_TOKEN=... node scripts/r2-upload.mjs <file> <key>");

const call = async (method, path, body, params = {}) => {
  const q = new URLSearchParams({ key, ...params });
  const res = await fetch(`${BASE}${path}?${q}`, { method, body, headers: { "x-upload-token": TOKEN }, duplex: "half" });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
};

const size = (await stat(file)).size;
const type = key.endsWith(".pmtiles") ? "application/vnd.pmtiles" : "application/octet-stream";
const { uploadId } = await call("POST", "/create", undefined, { type });
const fh = await open(file);
const parts = [];
try {
  for (let n = 1, off = 0; off < size; n++, off += PART) {
    const len = Math.min(PART, size - off);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, off);
    for (let attempt = 1; ; attempt++) {
      try {
        parts.push(await call("PUT", "/part", buf, { uploadId, n: String(n) }));
        break;
      } catch (e) {
        if (attempt >= 3) throw e;
        console.warn(`part ${n} failed (${e.message}), retrying`);
      }
    }
    console.log(`part ${n}: ${((off + len) / 1e6).toFixed(0)} / ${(size / 1e6).toFixed(0)} MB`);
  }
  console.log(await call("POST", "/complete", JSON.stringify(parts), { uploadId }));
} catch (e) {
  await call("POST", "/abort", undefined, { uploadId }).catch(() => {});
  throw e;
} finally {
  await fh.close();
}
