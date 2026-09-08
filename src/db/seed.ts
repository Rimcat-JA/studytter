import demo from "../../assets/demo-subject.json";
import { createId, withDbTransaction } from "./database";

export async function seedDemoIfNeeded(): Promise<void> {
  await withDbTransaction(async (db) => {
  const existing = await db.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) count FROM subjects",
  );
  if ((existing?.count ?? 0) > 0) return;
  const now = Date.now();
  const s = demo.subject;
    await db.runAsync(
      "INSERT INTO subjects VALUES(?,?,?,?,?,?,?,?,?)",
      s.subjectId,
      s.displayName,
      s.handle,
      s.avatarSeed,
      s.contentLang,
      s.domainStyle,
      JSON.stringify(s.formatWeights),
      1,
      now,
    );
    await db.runAsync(
      "INSERT INTO materials(material_id,subject_id,filename,file_uri,mime_type,status,added_at) VALUES(?,?,?,?,?,?,?)",
      "demo-material",
      s.subjectId,
      "LearnStreamデモ教材",
      "asset://demo",
      "application/json",
      "done",
      now,
    );
    for (const atom of demo.atoms) {
      await db.runAsync(
        "INSERT INTO atoms(atom_id,subject_id,material_id,topic_label,kind,difficulty,core,note,source_anchor,enabled,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        atom.atomId,
        s.subjectId,
        "demo-material",
        atom.topicLabel,
        atom.kind,
        atom.difficulty,
        atom.core,
        atom.note,
        atom.sourceAnchor,
        1,
        now,
      );
      await db.runAsync(
        "INSERT OR IGNORE INTO atom_memory(atom_id) VALUES(?)",
        atom.atomId,
      );
      for (let index = 0; index < demo.postTemplates.length; index++) {
        const template = demo.postTemplates[index];
        const quiz =
          template.format === "quiz"
            ? JSON.stringify({
                question: `正しい説明はどれ？`,
                choices: [atom.core, atom.note, "どちらともいえない"],
                answerIndex: 0,
                answerText: atom.core,
                explanation: atom.core,
              })
            : null;
        const body =
          template.format === "quiz"
            ? `${template.prefix} 「${atom.topicLabel}」について答えてみよう。`
            : `${template.prefix} ${atom.core}${index === 3 ? ` ${atom.note}` : ""}`;
        await db.runAsync(
          "INSERT INTO posts(id,subject_id,atom_id,topic_key,format,persona_id,text,quiz_json,difficulty_b,status,is_rare_card,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
          createId("demo"),
          s.subjectId,
          atom.atomId,
          `${s.subjectId}:${atom.topicLabel}`,
          template.format,
          s.subjectId,
          body.slice(0, 280),
          quiz,
          atom.difficulty,
          "unread",
          atom.atomId === "demo-a07" && index === 0 ? 1 : 0,
          now - (index * 10 + Number(atom.atomId.slice(-2))) * 60_000,
        );
      }
    }
    const breaks = [
      "30秒だけ遠くを見て、目と頭をリセットしよう。",
      "いま覚えたことを、ひとことで言い直せる？",
      "肩の力を抜いて深呼吸。次の1枚へ。",
      "学ぶ速度より、思い出す回数が味方になる。",
      "小休止。今日わかったことを1つだけ数えてみよう。",
    ];
    for (const text of breaks)
      await db.runAsync(
        "INSERT INTO posts(id,subject_id,atom_id,topic_key,format,persona_id,text,quiz_json,difficulty_b,status,is_rare_card,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        createId("break"),
        s.subjectId,
        "_entertainment",
        "_entertainment",
        "entertainment",
        "entertainer",
        text,
        null,
        0,
        "unread",
        0,
        now - Math.random() * 3_000_000,
      );
  });
}
