#!/usr/bin/env node
'use strict';

const { detectPendingAmendments } = require('../lib/detectPendingAmendments');

// 사용법:
//   node scripts/detectPendingAmendments.js [fetchLawApi URL]
//   FETCH_LAW_API_URL=... node scripts/detectPendingAmendments.js
const DEFAULT_LOCAL_URL = 'http://127.0.0.1:5001/<project-id>/asia-northeast3/fetchLawApi';

async function main() {
  const baseUrl = process.argv[2] || process.env.FETCH_LAW_API_URL || DEFAULT_LOCAL_URL;

  if (baseUrl === DEFAULT_LOCAL_URL) {
    console.warn(
      '[안내] <project-id>를 실제 Firebase 프로젝트 ID로 바꾼 URL을 인자나 FETCH_LAW_API_URL로 전달하세요.\n'
    );
  }

  console.log(`fetchLawApi 엔드포인트: ${baseUrl}`);
  console.log('15개 감시 대상 법령에 대해 eflaw(시행일 법령 목록) 조회를 시작합니다...\n');

  const results = await detectPendingAmendments({ baseUrl, logRaw: true });

  console.log(`\n=== 시행 대기 중인 개정 건: 총 ${results.length}건 ===`);
  console.table(results);
}

main().catch((err) => {
  console.error('detectPendingAmendments 실행 중 오류:', err);
  process.exitCode = 1;
});
