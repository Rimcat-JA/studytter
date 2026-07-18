import { PDFDocument } from "pdf-lib";

export type PdfPageRange = { start: number; end: number };

export type OpenedPdf = {
  pageCount: number;
  createChunk(range: PdfPageRange): Promise<Uint8Array>;
};

const positiveInteger = (value: number, label: string) => {
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`${label}は1以上の整数で指定してください。`);
  return value;
};

/**
 * Builds inclusive, one-based page ranges without ever sending more than one
 * configured chunk to the model. The caller can pass only one end of the
 * range; the missing end is resolved to the beginning/end of the document.
 */
export function planPdfPageRanges(
  pageCount: number,
  requestedStart: number | null | undefined,
  requestedEnd: number | null | undefined,
  chunkSize: number,
  maxSelectedPages: number,
): PdfPageRange[] {
  positiveInteger(pageCount, "PDFのページ数");
  positiveInteger(chunkSize, "PDFのチャンクサイズ");
  positiveInteger(maxSelectedPages, "PDFの最大ページ数");

  const start =
    requestedStart == null
      ? 1
      : positiveInteger(requestedStart, "開始ページ");
  const end =
    requestedEnd == null
      ? pageCount
      : positiveInteger(requestedEnd, "終了ページ");

  if (start > pageCount)
    throw new Error(
      `開始ページ（${start}）がPDFの総ページ数（${pageCount}）を超えています。`,
    );
  if (end > pageCount)
    throw new Error(
      `終了ページ（${end}）がPDFの総ページ数（${pageCount}）を超えています。`,
    );
  if (end < start)
    throw new Error("終了ページは開始ページ以降にしてください。");

  const selectedPages = end - start + 1;
  if (selectedPages > maxSelectedPages)
    throw new Error(
      `一度に選択できるPDFは${maxSelectedPages}ページまでです。ページ範囲を指定してください。`,
    );

  const ranges: PdfPageRange[] = [];
  for (let page = start; page <= end; page += chunkSize)
    ranges.push({ start: page, end: Math.min(end, page + chunkSize - 1) });
  return ranges;
}

/** Loads a PDF once and exposes a sequential physical-page chunk creator. */
export async function openPdf(bytes: Uint8Array): Promise<OpenedPdf> {
  let source: PDFDocument;
  try {
    source = await PDFDocument.load(bytes);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `PDFを開けませんでした。破損またはパスワード保護を確認してください。 (${detail})`,
    );
  }

  const pageCount = source.getPageCount();
  positiveInteger(pageCount, "PDFのページ数");

  return {
    pageCount,
    async createChunk(range) {
      if (
        !Number.isInteger(range.start) ||
        !Number.isInteger(range.end) ||
        range.start < 1 ||
        range.end < range.start ||
        range.end > pageCount
      )
        throw new Error(
          `PDFのページ範囲 ${range.start}–${range.end} が正しくありません。`,
        );

      const chunk = await PDFDocument.create();
      const indices = Array.from(
        { length: range.end - range.start + 1 },
        (_, index) => range.start - 1 + index,
      );
      const pages = await chunk.copyPages(source, indices);
      for (const page of pages) chunk.addPage(page);
      return chunk.save({ useObjectStreams: false });
    },
  };
}
