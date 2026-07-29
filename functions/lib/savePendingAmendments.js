'use strict';

const { FieldValue } = require('firebase-admin/firestore');

const COLLECTION = 'pendingAmendments';

// STEP 2의 결과는 (법령ID, 공포번호)가 같아도 시행일자가 여러 개면 행이 여러 개로
// 쪼개져 나온다 (부칙에서 조문별로 시행일을 다르게 정한 경우). 하지만 동일한
// 개정 건은 문서 하나로 저장해야 하므로, 저장 전에 (법령ID+공포번호) 기준으로
// 다시 묶고 시행예정일들을 배열로 합친다.
function groupByAmendmentCase(flatResults) {
  const groups = new Map();

  for (const row of flatResults) {
    const docId = `${row.법령ID}_${row.공포번호}`;
    if (!groups.has(docId)) {
      groups.set(docId, {
        docId,
        법령ID: row.법령ID,
        법령명: row.법령명,
        MST: row.MST, // 같은 공포번호면 eflaw MST도 동일 — STEP 5 시행예정본 조회에 사용
        공포번호: row.공포번호,
        공포일: row.공포일,
        시행예정일세트: new Set(),
      });
    }
    groups.get(docId).시행예정일세트.add(row.시행예정일);
  }

  return [...groups.values()].map(({ 시행예정일세트, ...rest }) => ({
    ...rest,
    시행예정일: [...시행예정일세트].sort(),
  }));
}

/**
 * STEP 2에서 감지된 결과를 pendingAmendments 컬렉션에 저장한다.
 * 문서 ID는 `${법령ID}_${공포번호}` — 동일 개정 건이면 이미 존재하는 문서를
 * 건드리지 않고 스킵한다 (중복 알림 방지).
 *
 * @param {import('firebase-admin/firestore').Firestore} db
 * @param {Array} flatResults detectPendingAmendments()의 반환값
 * @returns {Promise<Array>} 이번 실행에서 새로 저장된 개정 건 목록
 */
async function savePendingAmendments(db, flatResults) {
  const collection = db.collection(COLLECTION);
  const amendmentCases = groupByAmendmentCase(flatResults);
  const newlyInserted = [];

  for (const { docId, ...fields } of amendmentCases) {
    const docRef = collection.doc(docId);
    const existing = await docRef.get();

    if (existing.exists) {
      continue;
    }

    const record = {
      ...fields,
      감지일시: FieldValue.serverTimestamp(),
      처리상태: 'pending',
    };

    await docRef.set(record);
    newlyInserted.push({ docId, ...fields, 처리상태: 'pending' });
  }

  return newlyInserted;
}

/**
 * 처리상태가 'pending'인데 changedArticles가 비어 있는 건을 모두 반환한다.
 * STEP 4(변경조문 추출) API 계약 문제 등으로 한 번 실패하면, dedup 때문에
 * 다음 실행에서 새로 감지되지 않아 영원히 재시도되지 않는 문제를 막기 위함 —
 * 이번 실행에서 새로 저장된 건도 이 시점엔 이미 같은 상태이므로 함께 잡힌다.
 *
 * @param {import('firebase-admin/firestore').Firestore} db
 * @returns {Promise<Array>} docId를 포함한 미처리 건 목록
 */
async function findUnprocessedCases(db) {
  const collection = db.collection(COLLECTION);
  const snapshot = await collection.where('처리상태', '==', 'pending').get();
  return snapshot.docs
    .map((doc) => ({ docId: doc.id, ...doc.data() }))
    .filter((c) => !c.changedArticles || c.changedArticles.length === 0);
}

module.exports = { COLLECTION, groupByAmendmentCase, savePendingAmendments, findUnprocessedCases };
