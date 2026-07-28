#!/usr/bin/env node
'use strict';

// updateArticleDiffs의 Firestore 연동을 가짜 Firestore + 가짜 fetch로 검증한다:
// - 문서에 저장된 법령ID로 현재 MST를 조회(target=law, jo 없음)하고,
// - 문서의 MST(그 개정 건 고유값) + 시행예정일 중 가장 빠른 날로 개정본을 조회하고,
// - 결과를 articleDiffs 필드로 문서에 업데이트한다.
// 같은 법령ID를 가진 문서가 여러 개면 현재 MST 조회가 캐시되어 한 번만 호출되는지도 확인한다.
//
// 실행: node scripts/updateArticleDiffs.selftest.js

const assert = require('node:assert/strict');
const { updateArticleDiffs } = require('../lib/updateArticleDiffs');

const CURRENT_MST = '287805';

process.env.LAW_OC = 'fake-oc-for-test';

let currentMstLookupCount = 0;

global.fetch = async (urlString) => {
  const url = new URL(urlString);
  const target = url.searchParams.get('target');
  const jo = url.searchParams.get('jo');

  if (target === 'law' && !jo) {
    // getCurrentMst 조회
    currentMstLookupCount += 1;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ LawSearch: { law: { 법령일련번호: CURRENT_MST } } }),
    };
  }

  // getArticleDiffs의 조문 본문 조회
  const mst = url.searchParams.get('MST');
  const efYd = url.searchParams.get('efYd');
  const 조문내용 = efYd ? `[개정 MST=${mst} efYd=${efYd}] ${jo}` : `[현행 MST=${mst}] ${jo}`;
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ Law: { 조문단위: { 조문제목: `${jo} 제목`, 조문내용 } } }),
  };
};

function createFakeFirestore(seedDocs) {
  const store = new Map(Object.entries(seedDocs));

  return {
    collection() {
      return {
        doc(id) {
          return {
            async get() {
              return { exists: store.has(id), data: () => store.get(id) };
            },
            async update(patch) {
              store.set(id, { ...store.get(id), ...patch });
            },
          };
        },
      };
    },
    _get(id) {
      return store.get(id);
    },
  };
}

async function main() {
  const db = createFakeFirestore({
    '001766_21374': {
      법령ID: '001766',
      MST: '283449', // 이 개정 건 고유 MST (현재 MST 287805와 다름)
      시행예정일: ['2027.01.01', '2026.08.01'], // 정렬 전 순서 섞어서 넣음
      changedArticles: ['제38조'],
    },
    '001766_21534': {
      법령ID: '001766', // 같은 법령ID -> 현재 MST 조회가 캐시되어야 함
      MST: '285379',
      시행예정일: ['2026.12.08'],
      changedArticles: ['제175조'],
    },
    '001849_21252': {
      법령ID: '001849',
      MST: '281893',
      시행예정일: ['2026.12.31'],
      changedArticles: [], // 변경 조문이 없는 경우 -> 스킵되어야 함
    },
  });

  const results = await updateArticleDiffs(db, ['001766_21374', '001766_21534', '001849_21252']);

  console.log('결과:', JSON.stringify(results, null, 2));

  // 1) changedArticles가 있는 두 건은 articleDiffs가 채워져야 함
  const case21374 = results.find((r) => r.docId === '001766_21374');
  assert.equal(case21374.articleDiffs.length, 1);
  assert.equal(case21374.articleDiffs[0].현행본문, '[현행 MST=287805] 003800');
  // 시행예정일 중 가장 빠른 날(2026.08.01 -> 20260801)이 사용되어야 함
  assert.equal(case21374.articleDiffs[0].개정본문, '[개정 MST=283449 efYd=20260801] 003800');

  const case21534 = results.find((r) => r.docId === '001766_21534');
  assert.equal(case21534.articleDiffs[0].개정본문, '[개정 MST=285379 efYd=20261208] 017500');

  // 2) changedArticles가 빈 배열인 건은 조회 없이 빈 배열로 스킵되어야 함
  const caseEmpty = results.find((r) => r.docId === '001849_21252');
  assert.deepEqual(caseEmpty.articleDiffs, []);

  // 3) 같은 법령ID(001766)를 가진 두 문서에 대해 현재 MST 조회는 한 번만 캐시되어야 함
  assert.equal(currentMstLookupCount, 1, `현재 MST 조회는 1회여야 함, 실제: ${currentMstLookupCount}회`);

  // 4) Firestore 문서 자체가 articleDiffs로 업데이트됐는지 확인
  assert.ok(db._get('001766_21374').articleDiffs, 'Firestore 문서에 articleDiffs가 저장되어야 함');

  console.log('\n✅ 모든 검증 통과 — MST 캐싱·efYd 선택·빈 changedArticles 스킵이 정상 동작합니다.');
}

main().catch((err) => {
  console.error('❌ 자체 테스트 실패:', err);
  process.exitCode = 1;
});
