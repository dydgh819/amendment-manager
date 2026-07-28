#!/usr/bin/env node
'use strict';

require('dotenv').config();

const admin = require('firebase-admin');
const { runPipeline } = require('../lib/runPipeline');

// GitHub Actions(스케줄 cron 또는 수동 workflow_dispatch)에서 실행되는 진입점.
// STEP 2~6 전체 파이프라인을 한 번 실행하고 batchLogs에 기록한다.
//
// 필요한 환경변수:
//   LAW_OC                       국가법령정보 Open API 인증키 (필수)
//   GEMINI_API_KEY                Gemini API 키 (없으면 요약 단계만 개별 실패로 기록됨)
//   FIREBASE_SERVICE_ACCOUNT_KEY   Firestore 접근용 서비스 계정 JSON 전체 (문자열)
//                                  로컬에서는 생략하고 `gcloud auth application-default
//                                  login`으로 인증해도 된다.
async function main() {
  if (!process.env.LAW_OC) {
    console.error('LAW_OC 환경변수가 필요합니다.');
    process.exitCode = 1;
    return;
  }

  if (!admin.apps.length) {
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (serviceAccountJson) {
      admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(serviceAccountJson)),
      });
    } else {
      admin.initializeApp();
    }
  }

  const db = admin.firestore();
  const log = await runPipeline({ db });

  console.log('\n=== 파이프라인 실행 결과 ===');
  console.log(JSON.stringify(log, null, 2));

  const hasStageFailure = Object.values(log.단계 || {}).some((stage) => stage.성공 === false);
  if (hasStageFailure) {
    console.error('\n일부 단계가 통째로 실패했습니다. batchLogs 문서를 확인하세요.');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('runPipelineOnce 실행 중 알 수 없는 오류:', err);
  process.exitCode = 1;
});
