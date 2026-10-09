// Web-only stand-in for expo-file-system (demo use). Files live in memory for
// the lifetime of the tab, so a reload drops materials that were not extracted.
const store = new Map(); // uri -> Uint8Array
const dirs = new Set();

const join = (parts) =>
  parts
    .map((p) => (typeof p === "string" ? p : p.uri))
    .reduce((a, b) => (a ? a.replace(/\/+$/, "") + "/" + String(b).replace(/^\/+/, "") : String(b)), "");

const toBytes = (v) => (typeof v === "string" ? new TextEncoder().encode(v) : new Uint8Array(v));

function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function load(uri) {
  if (store.has(uri)) return store.get(uri);
  if (/^(blob:|data:|https?:)/.test(uri)) {
    const bytes = new Uint8Array(await (await fetch(uri)).arrayBuffer());
    store.set(uri, bytes);
    return bytes;
  }
  throw new Error(`File not found: ${uri}`);
}

export class File {
  constructor(...parts) { this.uri = join(parts); }
  get name() { return this.uri.split("/").pop(); }
  get exists() { return store.has(this.uri) || /^(blob:|data:)/.test(this.uri); }
  get size() { return store.get(this.uri)?.length ?? 0; }
  create() { store.set(this.uri, new Uint8Array()); }
  write(content) { store.set(this.uri, toBytes(content)); }
  delete() { store.delete(this.uri); }
  async bytes() { return load(this.uri); }
  async base64() { return toBase64(await load(this.uri)); }
  async text() { return new TextDecoder().decode(await load(this.uri)); }
  textSync() { return new TextDecoder().decode(store.get(this.uri) ?? new Uint8Array()); }
  async copy(dest) {
    const target = dest instanceof Directory ? new File(dest, this.name) : dest;
    store.set(target.uri, await load(this.uri));
  }
}

export class Directory {
  constructor(...parts) { this.uri = join(parts); }
  get exists() { return dirs.has(this.uri); }
  create() { dirs.add(this.uri); }
  delete() {
    dirs.delete(this.uri);
    for (const k of [...store.keys()]) if (k.startsWith(this.uri + "/")) store.delete(k);
  }
  list() { return [...store.keys()].filter((k) => k.startsWith(this.uri + "/")).map((k) => new File(k)); }
}

export const Paths = {
  document: new Directory("mem://document"),
  cache: new Directory("mem://cache"),
};
