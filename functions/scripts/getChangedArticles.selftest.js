#!/usr/bin/env node
'use strict';

// 실제 law.go.kr 네트워크/OC 키 없이 getChangedArticles의 필터링 로직을 검증한다.
// 목업 데이터는 korean-law-mcp(신구대조표 기능)로 실제 확인한 산업안전보건법
// 2026-07-07 공포 개정 건의 실제 변경 조문(제31조의2 신설, 제33조·제117조·제175조
// 일부개정)을 기준으로 만들었다. 오래된 무관 개정(2006년 제38조 개정 등)도 섞어서
// 공포일자 필터링이 실제로 걸러내는지 함께 확인한다.
//
// 실행: node scripts/getChangedArticles.selftest.js

const assert = require('node:assert/strict');
const { getChangedArticles, formatArticleNumber } = require('../lib/getChangedArticles');

const TARGET_PROCL_DATE = '20260707';

// 응답 필드는 조문번호를 "조문번호통합"(6자리: 조문4자리+가지2자리) 또는
// "조문번호"+"조문가지번호" 분리 필드로 줄 수 있어 두 표현을 섞어서 검증한다.
const MOCK_HISTORY_ENTRIES = [
  // 무관한 과거 개정 (필터에서 제외되어야 함)
  {
    조문번호통합: '003800',
    개정구분: '일부개정',
    변경사유: '조문변경',
    공포일자: '20060324',
    조문개정일자: '20060324',
  },
  // 이번 개정(20260707)으로 변경된 조문들
  { 조문번호통합: '003102', 개정구분: '일부개정', 변경사유: '본조신설', 조문개정일자: TARGET_PROCL_DATE },
  { 조문번호: '33', 조문가지번호: '0', 개정구분: '일부개정', 변경사유: '조문변경', 조문개정일자: TARGET_PROCL_DATE },
  { 조문번호통합: '011700', 개정구분: '일부개정', 변경사유: '조문변경', 조문개정일자: TARGET_PROCL_DATE },
  { 조문번호통합: '017500', 개정구분: '일부개정', 변경사유: '조문변경', 공포일자: TARGET_PROCL_DATE }, // 조문개정일자 없이 공포일자만
  // 중복 행(같은 조문이 두 번 내려오는 경우도 있을 수 있음 - 중복 제거 확인용)
  { 조문번호통합: '003102', 개정구분: '일부개정', 변경사유: '본조신설', 조문개정일자: TARGET_PROCL_DATE },
];

process.env.LAW_OC = 'fake-oc-for-test';

// 실제 GitHub Actions 실행에서 updateChangedArticles.js가 MST를 넘기지 않고
// ID만 보내 lsJoHstInf가 totalCnt:0을 반환한 사례가 있었다 — MST가 실제로
// 요청 URL에 포함되는지 회귀 방지용으로 캡처해서 확인한다.
let lastRequestedUrl;

// parseUpstreamBody는 응답 텍스트가 '{'로 시작하면 XML 대신 JSON으로 그대로
// 파싱하므로, 목업은 XML을 흉내낼 필요 없이 JSON 문자열을 바로 돌려주면 된다.
global.fetch = async (urlString) => {
  lastRequestedUrl = urlString;
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ LsJoHstInf: { joHst: MOCK_HISTORY_ENTRIES } }),
  };
};

async function main() {
  // 1) 6자리 조문코드 포맷 변환 확인
  assert.equal(formatArticleNumber('003800'), '제38조');
  assert.equal(formatArticleNumber('003102'), '제31조의2');

  // 2) 공포일자 필터링 + 중복 제거 + 정렬
  const changed = await getChangedArticles({
    lawId: '001766',
    mst: '287805',
    proclDate: TARGET_PROCL_DATE,
  });

  console.log(`2026-07-07 공포 건의 변경 조문: ${changed.join(', ')}`);

  assert.deepEqual(
    changed,
    ['제31조의2', '제33조', '제117조', '제175조'],
    `기대: [제31조의2, 제33조, 제117조, 제175조], 실제: [${changed.join(', ')}]`
  );

  // 3) 무관한 과거 개정(제38조, 2006년)은 포함되지 않아야 함
  assert.ok(!changed.includes('제38조'), '과거(2006년) 개정 건이 필터링되지 않고 포함됨');

  // 4) mst를 넘기면 실제 요청 URL에 MST 파라미터가 포함되어야 함 —
  //    updateChangedArticles.js가 MST를 넘기지 않아 실서비스에서 lsJoHstInf가
  //    totalCnt:0을 반환한 사례의 회귀 방지.
  assert.ok(
    new URL(lastRequestedUrl).searchParams.get('MST') === '287805',
    `요청 URL에 MST 파라미터가 누락됨: ${lastRequestedUrl}`
  );

  console.log('\n✅ 모든 검증 통과 — 공포일자 필터링·중복제거·정렬이 정상 동작합니다.');
}

main().catch((err) => {
  console.error('❌ 자체 테스트 실패:', err);
  process.exitCode = 1;
});
