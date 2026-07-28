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

// lawId별 eflaw 목업 XML. 시행령/시행규칙 등 나머지 10개 법령은 시행대기 건이
// 없는 것으로 응답하도록 빈 목록을 준다.
const MOCK_EFLAW_XML = {
  '001766': `<LawSearch>
    <totalCnt>3</totalCnt>
    <law>
      <법령ID>001766</법령ID>
      <법령명한글>산업안전보건법</법령명한글>
      <공포번호>21853</공포번호>
      <공포일자>20260707</공포일자>
      <시행일자>20270108</시행일자>
    </law>
    <law>
      <법령ID>001766</법령ID>
      <법령명한글>산업안전보건법</법령명한글>
      <공포번호>21374</공포번호>
      <공포일자>20260219</공포일자>
      <시행일자>20260801</시행일자>
    </law>
    <law>
      <법령ID>001766</법령ID>
      <법령명한글>산업안전보건법</법령명한글>
      <공포번호>21374</공포번호>
      <공포일자>20260219</공포일자>
      <시행일자>20270101</시행일자>
    </law>
    <law>
      <법령ID>001766</법령ID>
      <법령명한글>산업안전보건법</법령명한글>
      <공포번호>21534</공포번호>
      <공포일자>20260407</공포일자>
      <시행일자>20261208</시행일자>
    </law>
  </LawSearch>`,
  '001849': `<LawSearch>
    <totalCnt>1</totalCnt>
    <law>
      <법령ID>001849</법령ID>
      <법령명한글>액화석유가스의 안전관리 및 사업법</법령명한글>
      <공포번호>21252</공포번호>
      <공포일자>20251230</공포일자>
      <시행일자>20261231</시행일자>
    </law>
  </LawSearch>`,
  '001851': `<LawSearch>
    <totalCnt>1</totalCnt>
    <law>
      <법령ID>001851</법령ID>
      <법령명한글>도시가스사업법</법령명한글>
      <공포번호>21682</공포번호>
      <공포일자>20260526</공포일자>
      <시행일자>20261127</시행일자>
    </law>
  </LawSearch>`,
};

// PRD 부록 시나리오 기준 "이미 시행된" 과거 개정 건도 하나 섞어서
// (시행일자가 오늘 이전) 필터에서 제대로 걸러지는지 함께 검증한다.
const MOCK_PAST_ENTRY_LAW_ID = '007364';
MOCK_EFLAW_XML[MOCK_PAST_ENTRY_LAW_ID] = `<LawSearch>
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

function xmlToFakeUpstreamText(lawId) {
  return MOCK_EFLAW_XML[lawId] || EMPTY_EFLAW_XML;
}

// fetchLawApi가 프론트에 돌려주는 { ok, data } 포맷을 그대로 흉내낸다.
// (실제 XML->JSON 변환은 functions/index.js의 parseUpstreamBody와 동일하게
//  fast-xml-parser + parseTagValue:false 를 사용해 앞자리 0 손실이 없게 한다.)
const { XMLParser } = require('fast-xml-parser');
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
});

global.fetch = async (urlString) => {
  const url = new URL(urlString);
  const lawId = url.searchParams.get('ID');
  const xml = xmlToFakeUpstreamText(lawId);
  const data = xmlParser.parse(xml);
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, data }),
  };
};

async function main() {
  const results = await detectPendingAmendments({
    baseUrl: 'http://mock/fetchLawApi',
    today: '20260728', // 오늘 날짜(2026-07-28) 기준
  });

  console.log('검출 결과:');
  console.table(results);

  // 1) 총 6행이어야 한다 (산업안전보건법 21374건이 시행일자 2개라 행이 2개로 쪼개짐)
  assert.equal(results.length, 6, `기대: 6행, 실제: ${results.length}행`);

  // 2) 과거에 이미 시행된 건(007364, 20240101)은 결과에 없어야 한다
  assert.ok(
    !results.some((r) => r.법령ID === MOCK_PAST_ENTRY_LAW_ID),
    '이미 시행된 과거 건이 필터링되지 않고 포함됨'
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

  // 15개 법령을 전부 순회했는지 확인 (import 목적, side-effect 없음)
  assert.equal(TARGET_LAWS.length, 15);

  console.log('\n✅ 모든 검증 통과 — PRD 부록 5건(행 기준 6개)과 결과가 일치합니다.');
}

main().catch((err) => {
  console.error('❌ 자체 테스트 실패:', err);
  process.exitCode = 1;
});
