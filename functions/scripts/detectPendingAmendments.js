#!/usr/bin/env node
'use strict';

require('dotenv').config();

const { detectPendingAmendments } = require('../lib/detectPendingAmendments');

// 사용법:
//   export LAW_OC=발급받은OC값
//   node scripts/detectPendingAmendments.js
// (또는 functions/.env 파일에 LAW_OC=... 를 넣어두면 dotenv가 자동으로 읽는다)
async function main() {
  if (!process.env.LAW_OC) {
    console.error('LAW_OC 환경변수가 필요합니다. (export LAW_OC=... 또는 functions/.env)');
    process.exitCode = 1;
    return;
  }

  console.log('15개 감시 대상 법령에 대해 eflaw(시행일 법령 목록) 조회를 시작합니다...\n');

  const results = await detectPendingAmendments({ logRaw: true });

  console.log(`\n=== 시행 대기 중인 개정 건: 총 ${results.length}건 ===`);
  console.table(results);
}

main().catch((err) => {
  console.error('detectPendingAmendments 실행 중 오류:', err);
  process.exitCode = 1;
});
