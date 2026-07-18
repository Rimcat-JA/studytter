import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { openPdf, planPdfPageRanges } from "./pdf";

describe("planPdfPageRanges", () => {
  it("physically plans an entire document in bounded chunks", () => {
    expect(planPdfPageRanges(51, null, null, 20, 150)).toEqual([
      { start: 1, end: 20 },
      { start: 21, end: 40 },
      { start: 41, end: 51 },
    ]);
  });

  it("preserves original page numbers for a selected range", () => {
    expect(planPdfPageRanges(80, 15, 44, 20, 150)).toEqual([
      { start: 15, end: 34 },
      { start: 35, end: 44 },
    ]);
  });

  it("supports one-sided ranges", () => {
    expect(planPdfPageRanges(30, 26, null, 20, 150)).toEqual([
      { start: 26, end: 30 },
    ]);
    expect(planPdfPageRanges(30, null, 5, 20, 150)).toEqual([
      { start: 1, end: 5 },
    ]);
  });

  it("rejects out-of-bounds and oversized selections", () => {
    expect(() => planPdfPageRanges(10, 11, null, 20, 150)).toThrow(
      "総ページ数",
    );
    expect(() => planPdfPageRanges(10, 8, 7, 20, 150)).toThrow(
      "終了ページ",
    );
    expect(() => planPdfPageRanges(151, null, null, 20, 150)).toThrow(
      "150ページ",
    );
  });
});

describe("openPdf", () => {
  it("creates real PDF excerpts with the requested physical pages", async () => {
    const source = await PDFDocument.create();
    for (let index = 0; index < 45; index++)
      source.addPage([300 + index, 400 + index]);

    const opened = await openPdf(await source.save());
    expect(opened.pageCount).toBe(45);
    const ranges = planPdfPageRanges(opened.pageCount, null, null, 20, 150);
    const chunks = await Promise.all(
      ranges.map(async (range) =>
        PDFDocument.load(await opened.createChunk(range)),
      ),
    );

    expect(chunks.map((chunk) => chunk.getPageCount())).toEqual([20, 20, 5]);
    expect(chunks[0].getPage(0).getWidth()).toBe(300);
    expect(chunks[1].getPage(0).getWidth()).toBe(320);
    expect(chunks[2].getPage(4).getWidth()).toBe(344);
  });

  it("reports malformed PDFs as a material error", async () => {
    await expect(openPdf(new Uint8Array([1, 2, 3]))).rejects.toThrow(
      "PDFを開けませんでした",
    );
  });
});
