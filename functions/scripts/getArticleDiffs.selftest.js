#!/usr/bin/env node
'use strict';

// 실제 law.go.kr 네트워크/OC 키 없이 getArticleDiffs의 "MST 라우팅"이 올바른지
// 검증한다: 현행본은 currentMst + efYd 없이, 개정본은 pendingMst + efYd로
// 각각 호출해야 한다 (두 MST가 실제로 다를 수 있음을 STEP 5 조사에서 확인했다 —
// 예: 산업안전보건법 2026-02-19 공포 건은 현재 MST 287805가 아니라 283449를
// 시행예정본 조회에 써야 한다). 조문 본문 그 자체는 실 데이터로 검증하지 못했으므로
// 가상 텍스트로 라우팅/파싱 로직만 검증한다.
//
// 실행: node scripts/getArticleDiffs.selftest.js

const assert = require('node:assert/strict');
const { getArticleDiffs } = require('../lib/getArticleDiffs');

const CURRENT_MST = '287805';
const PENDING_MST = '283449';
const EF_YD = '20260801';

global.fetch = async (urlString) => {
  const url = new URL(urlString);
  const mst = url.searchParams.get('MST');
  const jo = url.searchParams.get('jo');
  const efYd = url.searchParams.get('efYd');

  let 조문내용;
  if (mst === CURRENT_MST && !efYd) {
    조문내용 = `[현행] ${jo} 본문`;
  } else if (mst === PENDING_MST && efYd === EF_YD) {
    조문내용 = `[개정] ${jo} 본문`;
  } else {
    // 잘못된 조합으로 호출되면 라우팅 버그이므로 테스트가 실패하도록 에러를 던진다.
    throw new Error(`예상치 못한 파라미터 조합: mst=${mst}, jo=${jo}, efYd=${efYd}`);
  }

  return {
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      data: { Law: { 조문단위: { 조문제목: `${jo} 제목`, 조문내용 } } },
    }),
  };
};

async function main() {
  const diffs = await getArticleDiffs({
    baseUrl: 'http://mock/fetchLawApi',
    currentMst: CURRENT_MST,
    pendingMst: PENDING_MST,
    efYd: EF_YD,
    changedArticles: ['제38조', '제110조'],
  });

  console.table(diffs);

  assert.equal(diffs.length, 2);

  const jo38 = diffs.find((d) => d.조문번호 === '제38조');
  assert.equal(jo38.현행본문, '[현행] 003800 본문', '현행본은 currentMst로, efYd 없이 조회되어야 함');
  assert.equal(jo38.개정본문, '[개정] 003800 본문', '개정본은 pendingMst + efYd로 조회되어야 함');
  assert.equal(jo38.조문제목, '003800 제목');

  const jo110 = diffs.find((d) => d.조문번호 === '제110조');
  assert.equal(jo110.현행본문, '[현행] 011000 본문');
  assert.equal(jo110.개정본문, '[개정] 011000 본문');

  console.log('\n✅ 모든 검증 통과 — 현행본/개정본이 올바른 MST·efYd 조합으로 조회됩니다.');
}

main().catch((err) => {
  console.error('❌ 자체 테스트 실패:', err);
  process.exitCode = 1;
});
