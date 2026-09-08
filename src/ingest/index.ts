import { Directory, File, Paths } from "expo-file-system";
import { CONFIG } from "../core/config";
import { assertDatabaseGeneration, captureDatabaseGeneration, createId, getDb, getDbForGeneration, withDbTransaction } from "../db/database";
import { getPurposeRoute } from "../llm/config";
import {
  extractMaterialChunk,
  jaccard,
  mergeExtractionChunks,
} from "../llm/extract";
import type { ExtractionChunk } from "../llm/schemas";
import { openPdf, planPdfPageRanges, type PdfPageRange } from "./pdf";

export type PickedMaterial = {
  uri: string;
  name: string;
  mimeType: string;
  pageStart?: number;
  pageEnd?: number;
};
export type ExtractionProgress = {
  completed: number;
  total: number;
  label: string;
};

export async function copyMaterials(
  subjectId: string,
  files: readonly PickedMaterial[],
): Promise<string[]> {
  const directory = new Directory(Paths.document, "materials", subjectId);
  directory.create({ intermediates: true, idempotent: true });
  const db = await getDb();
  const ids: string[] = [];
  for (const picked of files) {
    const materialId = createId("material");
    const safeName = picked.name.replace(/[^\p{L}\p{N}._-]+/gu, "_");
    const destination = new File(directory, `${materialId}-${safeName}`);
    await new File(picked.uri).copy(destination);
    await db.runAsync(
      "INSERT INTO materials(material_id,subject_id,filename,file_uri,mime_type,page_count,page_start,page_end,status,added_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      materialId,
      subjectId,
      picked.name,
      destination.uri,
      picked.mimeType,
      null,
      picked.pageStart ?? null,
      picked.pageEnd ?? null,
      "pending",
      Date.now(),
    );
    ids.push(materialId);
  }
  return ids;
}

export async function extractSubject(
  subjectId: string,
  onProgress?: (progress: ExtractionProgress) => void,
  generation = captureDatabaseGeneration(),
): Promise<void> {
  const db = await getDbForGeneration(generation);
  const { providerId, model } = await getPurposeRoute("extraction");
  if (providerId === "ollama")
    throw new Error("Extraction requires OpenAI or Anthropic.");
  type MaterialRow = {
    material_id: string;
    filename: string;
    file_uri: string;
    mime_type: string;
    page_start: number | null;
    page_end: number | null;
  };
  type MaterialPlan = {
    material: MaterialRow;
    ranges: ({ start?: number; end?: number } | PdfPageRange)[];
    error?: string;
  };
  const materials = await db.getAllAsync<MaterialRow>(
    "SELECT material_id,filename,file_uri,mime_type,page_start,page_end FROM materials WHERE subject_id=? AND status IN ('pending','failed')",
    subjectId,
  );

  const plans: MaterialPlan[] = [];
  for (const material of materials) {
    if (material.mime_type !== "application/pdf") {
      plans.push({ material, ranges: [{}] });
      continue;
    }
    try {
      const pdf = await openPdf(await new File(material.file_uri).bytes());
      const ranges = planPdfPageRanges(
        pdf.pageCount,
        material.page_start,
        material.page_end,
        CONFIG.pdfChunkPages,
        CONFIG.pdfMaxPages,
      );
      await db.runAsync(
        "UPDATE materials SET page_count=? WHERE material_id=?",
        pdf.pageCount,
        material.material_id,
      );
      plans.push({ material, ranges });
    } catch (error) {
      plans.push({
        material,
        ranges: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const total = plans.reduce(
    (count, plan) => count + (plan.error ? 1 : plan.ranges.length),
    0,
  );
  const successful: ExtractionChunk[] = [];
  let completed = 0;
  const failedMaterials = new Set<string>();
  for (const material of materials)
    await db.runAsync(
      "UPDATE materials SET status='extracting',error_message=NULL WHERE material_id=?",
      material.material_id,
    );

  const advanceProgress = () => {
    completed++;
    onProgress?.({
      completed,
      total,
      label: `教材を読んでいます… ${completed}/${total}`,
    });
  };
  const recordFailure = async (material: MaterialRow, error: unknown) => {
    failedMaterials.add(material.material_id);
    await db.runAsync(
      "UPDATE materials SET status='failed',error_message=? WHERE material_id=? AND status!='replaced'",
      error instanceof Error ? error.message : String(error),
      material.material_id,
    );
  };
  const extractInput = async (
    material: MaterialRow,
    input: {
      fileUri: string;
      filename: string;
      pageStart?: number;
      pageEnd?: number;
    },
  ) => {
    try {
      const chunk = await extractMaterialChunk({
        providerId,
        model,
        fileUri: input.fileUri,
        filename: input.filename,
        mimeType: material.mime_type,
        pageStart: input.pageStart,
        pageEnd: input.pageEnd,
        firstChunk: successful.length === 0,
        databaseGeneration: generation,
      });
      await withDbTransaction(async (db) => {
      const activeMaterial = await db.getFirstAsync<{ material_id: string }>(
        "SELECT m.material_id FROM materials m JOIN subjects s ON s.subject_id=m.subject_id WHERE m.material_id=? AND m.subject_id=? AND m.status='extracting'",
        material.material_id,
        subjectId,
      );
      if (!activeMaterial) throw new Error("教材または科目が変更されたため、抽出結果を保存できませんでした。");
      for (const atom of chunk.atoms) {
        const existing = await db.getAllAsync<{ core: string }>(
          "SELECT core FROM atoms WHERE subject_id=? AND lower(trim(topic_label))=lower(trim(?))",
          subjectId,
          atom.topicLabel,
        );
        if (existing.some((row) => jaccard(row.core, atom.core) > 0.8))
          continue;
        const atomId = createId("atom");
        await db.runAsync(
          "INSERT INTO atoms(atom_id,subject_id,material_id,topic_label,kind,difficulty,core,note,source_anchor,enabled,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
          atomId,
          subjectId,
          material.material_id,
          atom.topicLabel.trim(),
          atom.kind,
          atom.difficulty,
          atom.core,
          atom.note ?? null,
          atom.sourceAnchor,
          1,
          Date.now(),
        );
        await db.runAsync(
          "INSERT OR IGNORE INTO atom_memory(atom_id) VALUES(?)",
          atomId,
        );
      }
      }, generation);
      successful.push(chunk);
      advanceProgress();
    } catch (error) {
      // A request-level failure (503, rate limit, auth/config, timeout, or an
      // invalid model response) applies to the selected provider, not just one
      // page chunk. Persist the material error, then abort this attempt so the
      // durable job can back off or ask for configuration instead of sending
      // every remaining chunk into the same outage.
      await recordFailure(material, error);
      advanceProgress();
      throw error;
    }
  };

  const temporaryDirectory = new Directory(
    Paths.cache,
    "learnstream-pdf-chunks",
    subjectId,
  );
  try {
    for (const plan of plans) {
      const { material } = plan;
      if (plan.error) {
        await recordFailure(material, plan.error);
        advanceProgress();
        continue;
      }
      if (material.mime_type !== "application/pdf") {
        await extractInput(material, {
          fileUri: material.file_uri,
          filename: material.filename,
        });
        continue;
      }

      let pdf;
      try {
        pdf = await openPdf(await new File(material.file_uri).bytes());
      } catch (error) {
        await recordFailure(material, error);
        for (let index = 0; index < plan.ranges.length; index++)
          advanceProgress();
        continue;
      }
      temporaryDirectory.create({ intermediates: true, idempotent: true });
      const basename = material.filename.replace(/\.pdf$/i, "");
      for (const range of plan.ranges as PdfPageRange[]) {
        const temporaryFile = new File(
          temporaryDirectory,
          `${material.material_id}-${range.start}-${range.end}.pdf`,
        );
        try {
          try {
            temporaryFile.create({ overwrite: true });
            temporaryFile.write(await pdf.createChunk(range));
          } catch (error) {
            // Local PDF/chunk creation errors can be isolated to this material
            // and should not be mistaken for a provider outage.
            await recordFailure(material, error);
            advanceProgress();
            continue;
          }
          await extractInput(material, {
            fileUri: temporaryFile.uri,
            filename: `${basename}.pages-${range.start}-${range.end}.pdf`,
            pageStart: range.start,
            pageEnd: range.end,
          });
        } finally {
          if (temporaryFile.exists) temporaryFile.delete();
        }
      }
    }
  } finally {
    if (temporaryDirectory.exists) temporaryDirectory.delete();
  }
  for (const material of materials)
    if (!failedMaterials.has(material.material_id))
      await db.runAsync(
        "UPDATE materials SET status='done' WHERE material_id=?",
        material.material_id,
      );
  if (successful.length) {
    const merged = mergeExtractionChunks(successful);
    const profile = merged.profile;
    if (profile) {
      const total =
        Object.values(profile.formatWeights).reduce((a, b) => a + b, 0) || 1;
      const normalized = Object.fromEntries(
        Object.entries(profile.formatWeights).map(([k, v]) => [k, v / total]),
      );
      await db.runAsync(
        "UPDATE subjects SET display_name=?,handle=?,content_lang=?,domain_style=?,format_weights_json=? WHERE subject_id=?",
        profile.suggestedDisplayName,
        profile.suggestedHandle.startsWith("@")
          ? profile.suggestedHandle
          : `@${profile.suggestedHandle}`,
        profile.contentLang,
        profile.domainStyle,
        JSON.stringify(normalized),
        subjectId,
      );
    }
  }
}

export async function removeMaterial(
  materialId: string,
  replacement?: PickedMaterial,
): Promise<string | null> {
  const generation = captureDatabaseGeneration();
  const db = await getDb();
  const material = await db.getFirstAsync<{ subject_id: string }>(
    "SELECT subject_id FROM materials WHERE material_id=?",
    materialId,
  );
  if (!material) return null;
  await withDbTransaction(async (db) => {
    await db.runAsync(
      "UPDATE atoms SET enabled=0 WHERE material_id=?",
      materialId,
    );
    await db.runAsync(
      "UPDATE posts SET status='discarded' WHERE status='unread' AND atom_id IN (SELECT atom_id FROM atoms WHERE material_id=?)",
      materialId,
    );
    await db.runAsync(
      "UPDATE materials SET status='replaced' WHERE material_id=?",
      materialId,
    );
  }, generation);
  if (replacement) {
    assertDatabaseGeneration(generation);
    await copyMaterials(material.subject_id, [replacement]);
  }
  return material.subject_id;
}
