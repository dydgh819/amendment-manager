'use strict';

const BATCH_LOG_COLLECTION = 'batchLogs';

/**
 * 배치 실행 로그를 batchLogs 컬렉션에 기록한다. 로그 자체 기록 실패는
 * 파이프라인 전체를 막지 않도록 호출부에서 에러를 삼키는 것을 권장한다.
 *
 * @param {import('firebase-admin/firestore').Firestore} db
 * @param {object} log
 */
async function writeBatchLog(db, log) {
  await db.collection(BATCH_LOG_COLLECTION).add(log);
}

module.exports = { writeBatchLog, BATCH_LOG_COLLECTION };
