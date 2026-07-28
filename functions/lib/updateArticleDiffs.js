'use strict';

const { getCurrentMst } = require('./getCurrentMst');
const { getArticleDiffs } = require('./getArticleDiffs');
const { COLLECTION } = require('./savePendingAmendments');

function toYmd(dottedDate) {
  return String(dottedDate).replace(/\./g, '');
}

/**
 * STEP 4에서 changedArticles가 채워진 pendingAmendments 문서들에 대해
 * 조문별 시행 전/후 본문을 조회하고 articleDiffs 필드로 저장한다.
 *
 * @param {import('firebase-admin/firestore').Firestore} db
 * @param {string[]} docIds STEP 4에서 changedArticles가 채워진 문서 ID 목록
 * @returns {Promise<Array<{docId, articleDiffs: Array|null, error?: string}>>}
 */
async function updateArticleDiffs(db, docIds) {
  const collection = db.collection(COLLECTION);
  const currentMstCache = new Map();
  const results = [];
  let loggedSample = false;

  for (const docId of docIds) {
    try {
      const snapshot = await collection.doc(docId).get();
      const data = snapshot.data();

      if (!data) {
        throw new Error('문서를 찾을 수 없습니다.');
      }
      if (!data.changedArticles || data.changedArticles.length === 0) {
        results.push({ docId, articleDiffs: [] });
        continue;
      }

      if (!currentMstCache.has(data.법령ID)) {
        currentMstCache.set(
          data.법령ID,
          await getCurrentMst({ lawId: data.법령ID, logRaw: !loggedSample })
        );
        loggedSample = true;
      }
      const currentMst = currentMstCache.get(data.법령ID);

      // 시행예정일이 여러 개인 경우(부칙상 조문별로 시행일이 다른 경우) 가장 빠른
      // 날짜를 사용한다. 조문마다 정확한 개별 시행일을 매핑하려면 STEP 4의
      // 조문별 개정이력에서 조문시행일까지 함께 가져와야 하는데, 이번 단계 범위를
      // 벗어나 단순화했다 — 알려진 한계로 남겨둔다.
      const efYd = toYmd([...data.시행예정일].sort()[0]);

      const articleDiffs = await getArticleDiffs({
        currentMst,
        pendingMst: data.MST,
        efYd,
        changedArticles: data.changedArticles,
      });

      await collection.doc(docId).update({ articleDiffs });
      results.push({ docId, articleDiffs });
    } catch (err) {
      console.error(`[오류] ${docId} 조문 본문 조회 실패: ${err.message}`);
      results.push({ docId, articleDiffs: null, error: err.message });
    }
  }

  return results;
}

module.exports = { updateArticleDiffs };
