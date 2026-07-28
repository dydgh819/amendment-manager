'use strict';

const { summarizeArticleImpact } = require('./summarizeArticleImpact');
const { COLLECTION } = require('./savePendingAmendments');

/**
 * STEP 5에서 articleDiffs가 채워진 pendingAmendments 문서들에 대해 조문별로
 * Gemini 요약을 생성하고 summary 필드로 저장한 뒤, 처리상태를 'summarized'로
 * 바꾼다. 조문 하나의 요약이 실패해도 나머지 조문 처리는 계속하고, 실패한
 * 조문은 summary 배열에 error와 함께 남긴다 (PRD: 조문별로 배열 저장).
 *
 * @param {import('firebase-admin/firestore').Firestore} db
 * @param {string[]} docIds STEP 5에서 articleDiffs가 채워진 문서 ID 목록
 * @returns {Promise<Array<{docId, summary: Array|null, error?: string}>>}
 */
async function updateSummaries(db, docIds) {
  const collection = db.collection(COLLECTION);
  const results = [];
  let loggedSample = false;

  for (const docId of docIds) {
    try {
      const snapshot = await collection.doc(docId).get();
      const data = snapshot.data();

      if (!data) {
        throw new Error('문서를 찾을 수 없습니다.');
      }
      if (!data.articleDiffs || data.articleDiffs.length === 0) {
        results.push({ docId, summary: [] });
        continue;
      }

      const summary = [];
      for (const diff of data.articleDiffs) {
        try {
          summary.push(await summarizeArticleImpact(diff, { logRaw: !loggedSample }));
        } catch (err) {
          console.error(`[오류] ${docId} ${diff.조문번호} 요약 실패: ${err.message}`);
          summary.push({
            조문번호: diff.조문번호,
            조문제목: diff.조문제목,
            요약: null,
            error: err.message,
          });
        } finally {
          loggedSample = true;
        }
      }

      await collection.doc(docId).update({ summary, 처리상태: 'summarized' });
      results.push({ docId, summary });
    } catch (err) {
      console.error(`[오류] ${docId} 요약 처리 실패: ${err.message}`);
      results.push({ docId, summary: null, error: err.message });
    }
  }

  return results;
}

module.exports = { updateSummaries };
