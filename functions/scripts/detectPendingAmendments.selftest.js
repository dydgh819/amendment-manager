#!/usr/bin/env node
'use strict';

// 실제 law.go.kr 네트워크/OC 키 없이 detectPendingAmendments의 파싱·필터링
// 로직을 검증하는 자체 테스트. eflaw 응답 형태를 흉내 낸 목업 XML을 사용하고,
// PRD 부록의 "현재(2026-07-26 기준) 감지된 시행예정 개정 5건"이 그대로
// 검출되는지 확인한다. (실데이터는 korean-law-mcp로 2026-07-28 기준 재확인함)
//
// 주의: 산업안전보건법 공포번호 21374 건은 시행일자가 2개(2026-08-01, 2027-01-01)라
// eflaw 원본에서는 행이 2개로 내려온다. 따라서 이 테스트가 확인하는 "행 개수"는
// 6개이며, 이 6개 행이 (법령ID+공포번호) 기준으로 묶이면 PRD 부록의 5건(케이스)이
// 된다 — 케이스 단위 묶기는 STEP 3(savePendingAmendments)에서 검증한다.
//
// 실행: node scripts/detectPendingAmendments.selftest.js

const assert = require('node:assert/strict');
const { detectPendingAmendments } = require('../lib/detectPendingAmendments');
const { TARGET_LAWS } = require('../lib/lawIds');

// eflaw는 법령ID로 직접 필터링을 못 하고 법령명(query)으로만 검색된다는 걸
// 실제 GitHub Actions 실행으로 확인했다 (ID 파라미터를 보내면 조용히 무시되고
// query=* 기본 검색으로 빠져버림). 그래서 목업도 법령명 기준으로 준다.
// 법령일련번호(MST)는 korean-law-mcp로 실제 확인한 값을 그대로 사용한다.
const MOCK_EFLAW_XML = {
  '산업안전보건법': `<LawSearch>
    <totalCnt>5</totalCnt>
    <law>
      <법령ID>001766</법령ID>
      <법령명한글>산업안전보건법</법령명한글>
      <법령일련번호>287805</법령일련번호>
      <공포번호>21853</공포번호>
      <공포일자>20260707</공포일자>
      <시행일자>20270108</시행일자>
    </law>
    <law>
      <법령ID>001766</법령ID>
      <법령명한글>산업안전보건법</법령명한글>
      <법령일련번호>283449</법령일련번호>
      <공포번호>21374</공포번호>
      <공포일자>20260219</공포일자>
      <시행일자>20260801</시행일자>
    </law>
    <law>
      <법령ID>001766</법령ID>
      <법령명한글>산업안전보건법</법령명한글>
      <법령일련번호>283449</법령일련번호>
      <공포번호>21374</공포번호>
      <공포일자>20260219</공포일자>
      <시행일자>20270101</시행일자>
    </law>
    <law>
      <법령ID>001766</법령ID>
      <법령명한글>산업안전보건법</법령명한글>
      <법령일련번호>285379</법령일련번호>
      <공포번호>21534</공포번호>
      <공포일자>20260407</공포일자>
      <시행일자>20261208</시행일자>
    </law>
    <law>
      <법령ID>003786</법령ID>
      <법령명한글>산업안전보건법 시행령</법령명한글>
      <법령일련번호>999999</법령일련번호>
      <공포번호>99999</공포번호>
      <공포일자>20260101</공포일자>
      <시행일자>20271231</시행일자>
    </law>
  </LawSearch>`,
  '액화석유가스의 안전관리 및 사업법': `<LawSearch>
    <totalCnt>1</totalCnt>
    <law>
      <법령ID>001849</법령ID>
      <법령명한글>액화석유가스의 안전관리 및 사업법</법령명한글>
      <법령일련번호>281893</법령일련번호>
      <공포번호>21252</공포번호>
      <공포일자>20251230</공포일자>
      <시행일자>20261231</시행일자>
    </law>
  </LawSearch>`,
  '도시가스사업법': `<LawSearch>
    <totalCnt>1</totalCnt>
    <law>
      <법령ID>001851</법령ID>
      <법령명한글>도시가스사업법</법령명한글>
      <법령일련번호>286287</법령일련번호>
      <공포번호>21682</공포번호>
      <공포일자>20260526</공포일자>
      <시행일자>20261127</시행일자>
    </law>
  </LawSearch>`,
};

// PRD 부록 시나리오 기준 "이미 시행된" 과거 개정 건도 하나 섞어서
// (시행일자가 오늘 이전) 필터에서 제대로 걸러지는지 함께 검증한다.
const MOCK_PAST_ENTRY_LAW_NAME = '산업안전보건법 시행규칙';
MOCK_EFLAW_XML[MOCK_PAST_ENTRY_LAW_NAME] = `<LawSearch>
  <totalCnt>1</totalCnt>
  <law>
    <법령ID>007364</법령ID>
    <법령명한글>산업안전보건법 시행규칙</법령명한글>
    <공포번호>9999</공포번호>
    <공포일자>20240101</공포일자>
    <시행일자>20240101</시행일자>
  </law>
</LawSearch>`;

const EMPTY_EFLAW_XML = `<LawSearch><totalCnt>0</totalCnt></LawSearch>`;

function xmlToFakeUpstreamText(query) {
  return MOCK_EFLAW_XML[query] || EMPTY_EFLAW_XML;
}

// law.go.kr을 직접 호출하는 구조이므로, fetch가 반환하는 XML 원문 텍스트를
// 그대로 흉내낸다 (파싱은 fetchLawApiClient.js가 담당).
process.env.LAW_OC = 'fake-oc-for-test';

global.fetch = async (urlString) => {
  const url = new URL(urlString);
  const query = url.searchParams.get('query');
  const xml = xmlToFakeUpstreamText(query);
  return {
    ok: true,
    status: 200,
    text: async () => xml,
  };
};

async function main() {
  const results = await detectPendingAmendments({
    today: '20260728', // 오늘 날짜(2026-07-28) 기준
  });

  console.log('검출 결과:');
  console.table(results);

  // 1) 총 6행이어야 한다 (산업안전보건법 21374건이 시행일자 2개라 행이 2개로 쪼개짐)
  assert.equal(results.length, 6, `기대: 6행, 실제: ${results.length}행`);

  // 2) 과거에 이미 시행된 건(007364, 20240101)은 결과에 없어야 한다
  assert.ok(
    !results.some((r) => r.법령ID === '007364'),
    '이미 시행된 과거 건이 필터링되지 않고 포함됨'
  );

  // 2-1) query 부분일치로 섞여 들어온 다른 법령ID(003786, 시행령)는 법령ID
  //      정확 매칭 필터로 걸러져야 한다 — 실제 API가 ID 파라미터를 무시하고
  //      법령명으로만 검색하는 것을 확인한 뒤 추가한 회귀 방지 테스트.
  assert.ok(
    !results.some((r) => r.법령ID === '003786'),
    '법령명 부분일치로 섞여 들어온 다른 법령ID가 걸러지지 않고 포함됨'
  );

  // 3) PRD 부록의 5건(산업안전보건법 3건 + LPG법 1건 + 도시가스법 1건) 대응 확인
  //    산업안전보건법 21374건은 시행일자가 2개라 행으로는 2개가 나온다.
  const expected = [
    { 법령ID: '001766', 법령명: '산업안전보건법', 공포일: '2026.07.07', 시행예정일: '2027.01.08' },
    { 법령ID: '001766', 법령명: '산업안전보건법', 공포일: '2026.02.19', 시행예정일: '2026.08.01' },
    { 법령ID: '001766', 법령명: '산업안전보건법', 공포일: '2026.02.19', 시행예정일: '2027.01.01' },
    { 법령ID: '001766', 법령명: '산업안전보건법', 공포일: '2026.04.07', 시행예정일: '2026.12.08' },
    {
      법령ID: '001849',
      법령명: '액화석유가스의 안전관리 및 사업법',
      공포일: '2025.12.30',
      시행예정일: '2026.12.31',
    },
    { 법령ID: '001851', 법령명: '도시가스사업법', 공포일: '2026.05.26', 시행예정일: '2026.11.27' },
  ];

  for (const exp of expected) {
    const found = results.some(
      (r) =>
        r.법령ID === exp.법령ID && r.공포일 === exp.공포일 && r.시행예정일 === exp.시행예정일
    );
    assert.ok(found, `PRD 기대 건 누락: ${JSON.stringify(exp)}`);
  }

  // 4) 법령ID 앞자리 0이 살아있는지 (fast-xml-parser 숫자 자동변환 버그 재발 방지)
  assert.ok(
    results.every((r) => /^\d{6}$/.test(r.법령ID)),
    '법령ID가 6자리 0-패딩 문자열이 아님 (앞자리 0 손실 가능성)'
  );

  // 5) MST가 함께 추출되는지 (STEP 5에서 시행예정본 조회에 필요)
  const case21374 = results.find((r) => r.공포번호 === '21374');
  assert.equal(case21374.MST, '283449', '21374건의 MST가 eflaw 응답에서 정상 추출되어야 함');

  // 15개 법령을 전부 순회했는지 확인 (import 목적, side-effect 없음)
  assert.equal(TARGET_LAWS.length, 15);

  console.log('\n✅ 모든 검증 통과 — PRD 부록 5건(행 기준 6개)과 결과가 일치합니다.');
}

main().catch((err) => {
  console.error('❌ 자체 테스트 실패:', err);
  process.exitCode = 1;
});
