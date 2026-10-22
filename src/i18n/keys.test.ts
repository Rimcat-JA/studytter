import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../db/database", () => ({ getSetting: async () => null }));
const { resources } = await import("./index");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("i18n resources", () => {
  it("define every literal t() key in every language", () => {
    const used = new Set<string>();
    for (const file of [...sourceFiles("app"), ...sourceFiles("src")])
      for (const match of readFileSync(file, "utf8").matchAll(/\bt\(\s*["']([A-Za-z0-9_.]+)["']/g))
        used.add(match[1]);
    expect(used.size).toBeGreaterThan(50);
    for (const [lang, { translation }] of Object.entries(resources)) {
      const missing = [...used].filter((key) => !(key in translation));
      expect(missing, lang).toEqual([]);
    }
  });
});
