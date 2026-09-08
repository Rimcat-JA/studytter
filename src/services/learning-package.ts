import { withDbTransaction } from "../db/database";
import { LearningPackageSchema } from "./learning-package-schema";

export async function importLearningPackage(input: unknown) {
  // Validate everything before acquiring the write lock or adding any records.
  const data = LearningPackageSchema.parse(input);
  const subjectId = `pc_${data.packageId}`;
  const materialId = (id: string) => `${subjectId}_material_${id}`;
  const atomId = (id: string) => `${subjectId}_atom_${id}`;
  const postId = (id: string) => `${subjectId}_post_${id}`;
  return withDbTransaction(async (db) => {
    const existing = await db.getFirstAsync(
      "SELECT subject_id FROM subjects WHERE subject_id=?", subjectId,
    );
    if (existing) return { subjectId, alreadyImported: true };
    const now = Date.now();
    await db.runAsync(
      "INSERT INTO subjects(subject_id,display_name,handle,avatar_seed,content_lang,domain_style,format_weights_json,enabled,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      subjectId, data.subject.displayName, `@${data.subject.id}`, subjectId,
      data.subject.contentLang, data.subject.domainStyle, JSON.stringify(data.subject.formatWeights), 1, now,
    );
    for (const material of data.materials) {
      await db.runAsync(
        "INSERT INTO materials(material_id,subject_id,filename,file_uri,mime_type,page_count,status,added_at) VALUES(?,?,?,?,?,?,?,?)",
        materialId(material.id), subjectId, material.filename,
        `studytter-package://${data.packageId}/${material.id}`,
        material.mimeType, material.pageCount ?? null, "done", now,
      );
    }
    const atoms = new Map(data.atoms.map((atom) => [atom.id, atom]));
    for (const atom of data.atoms) {
      const note = [atom.note, atom.sourceExcerpt ? `出典の抜粋:\n${atom.sourceExcerpt}` : ""].filter(Boolean).join("\n\n");
      await db.runAsync(
        "INSERT INTO atoms(atom_id,subject_id,material_id,topic_label,kind,difficulty,core,note,source_anchor,enabled,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        atomId(atom.id), subjectId, materialId(atom.materialId), atom.topicLabel,
        atom.kind, atom.difficulty, atom.core, note || null, atom.sourceAnchor, 1, now,
      );
    }
    for (const post of data.posts) {
      const atom = atoms.get(post.atomId)!;
      await db.runAsync(
        "INSERT INTO posts(id,subject_id,atom_id,topic_key,format,persona_id,text,quiz_json,difficulty_b,status,is_rare_card,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        postId(post.id), subjectId, atomId(post.atomId), `${subjectId}:${atom.topicLabel}`,
        post.format, subjectId, post.text, post.quiz ? JSON.stringify(post.quiz) : null,
        post.difficulty ?? atom.difficulty, "unread", 0, now,
      );
    }
    return { subjectId, alreadyImported: false };
  });
}
