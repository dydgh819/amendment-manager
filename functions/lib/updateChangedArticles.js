'use strict';

const { getChangedArticles } = require('./getChangedArticles');
const { COLLECTION } = require('./savePendingAmendments');

function toYmd(dottedDate) {
  return String(dottedDate).replace(/\./g, '');
}

/**
 * STEP 3에서 새로 저장된 개정 건(newlyInserted) 각각에 대해 변경 조문을 조회하고
 * pendingAmendments 문서에 changedArticles 필드로 업데이트한다.
 *
 * @param {import('firebase-admin/firestore').Firestore} db
 * @param {string} baseUrl fetchLawApi 엔드포인트
 * @param {Array} newlyInserted savePendingAmendments()가 반환한 신규 저장 건 목록
 * @returns {Promise<Array<{docId, changedArticles: string[]|null, error?: string}>>}
 */
async function updateChangedArticles(db, baseUrl, newlyInserted) {
  const collection = db.collection(COLLECTION);
  const results = [];
  let loggedSample = false;

  for (const amendmentCase of newlyInserted) {
    try {
      const changedArticles = await getChangedArticles({
        baseUrl,
        lawId: amendmentCase.법령ID,
        proclDate: toYmd(amendmentCase.공포일),
        logRaw: !loggedSample,
      });
      loggedSample = true;

      await collection.doc(amendmentCase.docId).update({ changedArticles });
      results.push({ docId: amendmentCase.docId, changedArticles });
    } catch (err) {
      console.error(`[오류] ${amendmentCase.docId} 변경 조문 조회 실패: ${err.message}`);
      results.push({ docId: amendmentCase.docId, changedArticles: null, error: err.message });
    }
  }

  return results;
}

module.exports = { updateChangedArticles, toYmd };
