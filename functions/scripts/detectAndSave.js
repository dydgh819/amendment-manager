#!/usr/bin/env node
'use strict';

require('dotenv').config();

const admin = require('firebase-admin');
const { detectPendingAmendments } = require('../lib/detectPendingAmendments');
const { savePendingAmendments } = require('../lib/savePendingAmendments');
const { updateChangedArticles } = require('../lib/updateChangedArticles');
const { updateArticleDiffs } = require('../lib/updateArticleDiffs');
const { updateSummaries } = require('../lib/updateSummaries');

// 사용법:
//   export LAW_OC=발급받은OC값
//   export GEMINI_API_KEY=발급받은Gemini키   (없으면 STEP 6만 건너뜀)
//   node scripts/detectAndSave.js
// (또는 functions/.env 파일에 값들을 넣어두면 dotenv가 자동으로 읽는다)
//
// Firestore 접속은 firebase-admin의 기본 인증을 사용한다:
//   - 로컬 에뮬레이터: FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 환경변수를 먼저 설정
//   - 실 프로젝트: GOOGLE_APPLICATION_CREDENTIALS로 서비스 계정 키 지정
//     (또는 `gcloud auth application-default login`으로 로그인해 둔 상태)
async function main() {
  if (!process.env.LAW_OC) {
    console.error('LAW_OC 환경변수가 필요합니다. (export LAW_OC=... 또는 functions/.env)');
    process.exitCode = 1;
    return;
  }

  admin.initializeApp();
  const db = admin.firestore();

  console.log('15개 감시 대상 법령에 대해 eflaw 조회를 시작합니다...\n');

  const flatResults = await detectPendingAmendments({ logRaw: true });
  console.log(`\neflaw 조회 결과: 시행대기 행 총 ${flatResults.length}개`);

  const newlyInserted = await savePendingAmendments(db, flatResults);

  console.log(`\n=== 신규 감지되어 Firestore에 저장된 개정 건: 총 ${newlyInserted.length}건 ===`);
  console.table(
    newlyInserted.map((c) => ({ ...c, 시행예정일: c.시행예정일.join(' / ') }))
  );

  if (newlyInserted.length === 0) {
    return;
  }

  console.log('\n신규 건에 대해 변경 조문을 조회합니다...\n');
  const articleResults = await updateChangedArticles(db, newlyInserted);

  console.log('\n=== 변경 조문 조회 결과 (changedArticles 필드로 저장됨) ===');
  console.table(
    articleResults.map((r) => ({
      docId: r.docId,
      changedArticles: r.changedArticles ? r.changedArticles.join(', ') : `(실패: ${r.error})`,
    }))
  );

  const docIdsWithArticles = articleResults
    .filter((r) => r.changedArticles && r.changedArticles.length > 0)
    .map((r) => r.docId);

  if (docIdsWithArticles.length === 0) {
    return;
  }

  console.log('\n변경 조문의 시행 전/후 본문을 조회합니다...\n');
  const diffResults = await updateArticleDiffs(db, docIdsWithArticles);

  console.log('\n=== 조문별 시행 전/후 본문 조회 결과 (articleDiffs 필드로 저장됨) ===');
  for (const r of diffResults) {
    if (r.error) {
      console.log(`- ${r.docId}: 실패 (${r.error})`);
      continue;
    }
    console.log(`- ${r.docId}: ${r.articleDiffs.length}개 조문`);
    console.table(r.articleDiffs);
  }

  const docIdsWithDiffs = diffResults
    .filter((r) => r.articleDiffs && r.articleDiffs.length > 0)
    .map((r) => r.docId);

  if (docIdsWithDiffs.length === 0) {
    return;
  }

  if (!process.env.GEMINI_API_KEY) {
    console.log('\nGEMINI_API_KEY가 없어 실무 영향 요약(STEP 6)은 건너뜁니다.');
    return;
  }

  console.log('\nGemini로 조문별 실무 영향 요약을 생성합니다...\n');
  const summaryResults = await updateSummaries(db, docIdsWithDiffs);

  console.log('\n=== 실무 영향 요약 결과 (summary 필드로 저장됨, 처리상태 -> summarized) ===');
  for (const r of summaryResults) {
    if (r.error) {
      console.log(`- ${r.docId}: 실패 (${r.error})`);
      continue;
    }
    console.log(`- ${r.docId}:`);
    console.table(r.summary.map((s) => ({ 조문번호: s.조문번호, 요약: s.요약 || `(실패: ${s.error})` })));
  }
}

main().catch((err) => {
  console.error('detectAndSave 실행 중 오류:', err);
  process.exitCode = 1;
});
