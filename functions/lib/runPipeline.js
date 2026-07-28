'use strict';

const { detectPendingAmendments } = require('./detectPendingAmendments');
const { savePendingAmendments } = require('./savePendingAmendments');
const { updateChangedArticles } = require('./updateChangedArticles');
const { updateArticleDiffs } = require('./updateArticleDiffs');
const { updateSummaries } = require('./updateSummaries');
const { writeBatchLog } = require('./writeBatchLog');

// STEP 2~6(탐지 → 저장 → 변경조문 추출 → 본문조회 → 요약)을 이어서 한 번 실행한다.
//
// 개별 법령/개정 건/조문 단위의 실패는 각 단계(lib/*.js) 내부에서 이미
// try-catch로 처리되어 있어 한 건이 실패해도 나머지 건은 계속 처리된다.
// 이 함수는 그 위에서 "단계 자체"가 통째로 실패하는 경우(예: Firestore
// 연결 문제)까지 잡아서, 무슨 일이 있어도 batchLogs에는 기록을 남긴다.
//
// @param {object} options
// @param {import('firebase-admin/firestore').Firestore} options.db
// @returns {Promise<object>} 기록된 로그 객체
async function runPipeline({ db }) {
  const log = {
    시작시각: new Date().toISOString(),
    단계: {},
  };

  try {
    let flatResults;
    try {
      flatResults = await detectPendingAmendments({});
      log.단계.탐지 = { 성공: true, 행수: flatResults.length };
    } catch (err) {
      log.단계.탐지 = { 성공: false, error: err.message };
      return log;
    }

    let newlyInserted;
    try {
      newlyInserted = await savePendingAmendments(db, flatResults);
      log.단계.저장 = { 성공: true, 신규건수: newlyInserted.length };
    } catch (err) {
      log.단계.저장 = { 성공: false, error: err.message };
      return log;
    }

    if (newlyInserted.length === 0) {
      return log;
    }

    let articleResults;
    try {
      articleResults = await updateChangedArticles(db, newlyInserted);
      log.단계.변경조문추출 = {
        성공건수: articleResults.filter((r) => r.changedArticles && r.changedArticles.length > 0).length,
        실패건수: articleResults.filter((r) => !r.changedArticles).length,
      };
    } catch (err) {
      log.단계.변경조문추출 = { 성공: false, error: err.message };
      return log;
    }

    const docIdsWithArticles = articleResults
      .filter((r) => r.changedArticles && r.changedArticles.length > 0)
      .map((r) => r.docId);

    if (docIdsWithArticles.length === 0) {
      return log;
    }

    let diffResults;
    try {
      diffResults = await updateArticleDiffs(db, docIdsWithArticles);
      log.단계.본문조회 = {
        성공건수: diffResults.filter((r) => r.articleDiffs && r.articleDiffs.length > 0).length,
        실패건수: diffResults.filter((r) => !r.articleDiffs).length,
      };
    } catch (err) {
      log.단계.본문조회 = { 성공: false, error: err.message };
      return log;
    }

    const docIdsWithDiffs = diffResults
      .filter((r) => r.articleDiffs && r.articleDiffs.length > 0)
      .map((r) => r.docId);

    if (docIdsWithDiffs.length === 0) {
      return log;
    }

    try {
      const summaryResults = await updateSummaries(db, docIdsWithDiffs);
      log.단계.요약 = {
        성공건수: summaryResults.filter((r) => r.summary && !r.error).length,
        실패건수: summaryResults.filter((r) => r.error).length,
      };
    } catch (err) {
      log.단계.요약 = { 성공: false, error: err.message };
    }

    return log;
  } finally {
    log.종료시각 = new Date().toISOString();
    try {
      await writeBatchLog(db, log);
    } catch (err) {
      // 로그 기록 자체의 실패는 배치 결과에 영향을 주지 않도록 콘솔에만 남긴다.
      console.error(`[오류] batchLogs 기록 실패: ${err.message}`);
    }
  }
}

module.exports = { runPipeline };
