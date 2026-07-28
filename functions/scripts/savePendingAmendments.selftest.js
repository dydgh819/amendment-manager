#!/usr/bin/env node
'use strict';

// 실제 Firestore 없이 savePendingAmendments의 그룹핑·중복 방지 로직을
// 메모리 기반 가짜 Firestore로 검증한다.
//
// 실행: node scripts/savePendingAmendments.selftest.js

const assert = require('node:assert/strict');
const { groupByAmendmentCase, savePendingAmendments } = require('../lib/savePendingAmendments');

// STEP 2 selftest와 동일한 6행 (산업안전보건법 3건 — 그중 1건은 시행일자 2개라
// 행이 2개 — + LPG법 1건 + 도시가스법 1건 = PRD 부록 5건).
const FLAT_RESULTS = [
  { 법령ID: '001766', 법령명: '산업안전보건법', MST: '287805', 공포번호: '21853', 공포일: '2026.07.07', 시행예정일: '2027.01.08' },
  { 법령ID: '001766', 법령명: '산업안전보건법', MST: '283449', 공포번호: '21374', 공포일: '2026.02.19', 시행예정일: '2026.08.01' },
  { 법령ID: '001766', 법령명: '산업안전보건법', MST: '283449', 공포번호: '21374', 공포일: '2026.02.19', 시행예정일: '2027.01.01' },
  { 법령ID: '001766', 법령명: '산업안전보건법', MST: '285379', 공포번호: '21534', 공포일: '2026.04.07', 시행예정일: '2026.12.08' },
  {
    법령ID: '001849',
    법령명: '액화석유가스의 안전관리 및 사업법',
    MST: '281893',
    공포번호: '21252',
    공포일: '2025.12.30',
    시행예정일: '2026.12.31',
  },
  { 법령ID: '001851', 법령명: '도시가스사업법', MST: '286287', 공포번호: '21682', 공포일: '2026.05.26', 시행예정일: '2026.11.27' },
];

function createFakeFirestore() {
  const store = new Map(); // key: `${collection}/${docId}` -> data

  return {
    collection(name) {
      return {
        doc(id) {
          const key = `${name}/${id}`;
          return {
            async get() {
              return { exists: store.has(key), data: () => store.get(key) };
            },
            async set(data) {
              store.set(key, data);
            },
          };
        },
      };
    },
    _dump() {
      return [...store.entries()].map(([key, value]) => ({ key, value }));
    },
  };
}

async function main() {
  // 1) 그룹핑: 6행 -> 5건(케이스)
  const grouped = groupByAmendmentCase(FLAT_RESULTS);
  assert.equal(grouped.length, 5, `기대: 5건, 실제: ${grouped.length}건`);

  const case21374 = grouped.find((c) => c.docId === '001766_21374');
  assert.deepEqual(
    case21374.시행예정일,
    ['2026.08.01', '2027.01.01'],
    '21374건은 시행예정일이 2개(2026.08.01, 2027.01.01)로 합쳐져야 함'
  );
  assert.equal(case21374.MST, '283449', 'MST가 그룹핑 후에도 유지되어야 함 (STEP 5에서 필요)');

  // 2) 최초 저장: 5건 모두 신규로 저장되어야 함
  const db = createFakeFirestore();
  const firstRun = await savePendingAmendments(db, FLAT_RESULTS);
  assert.equal(firstRun.length, 5, `최초 실행: 기대 5건 신규 저장, 실제 ${firstRun.length}건`);
  assert.ok(
    firstRun.every((c) => c.처리상태 === 'pending'),
    '신규 저장 건의 처리상태는 pending 이어야 함'
  );

  const savedDocIds = db._dump().map((d) => d.key);
  assert.equal(savedDocIds.length, 5, 'Firestore에 문서 5개가 저장되어야 함');
  assert.ok(
    savedDocIds.includes('pendingAmendments/001766_21374'),
    '문서 ID가 법령ID_공포번호 형식이어야 함'
  );

  // 3) 재실행(중복 방지): 이미 저장된 5건은 스킵되고, 신규 0건이어야 함
  const secondRun = await savePendingAmendments(db, FLAT_RESULTS);
  assert.equal(secondRun.length, 0, `재실행: 기대 0건(중복 스킵), 실제 ${secondRun.length}건`);
  assert.equal(db._dump().length, 5, '재실행 후에도 문서 개수는 그대로 5개여야 함 (덮어쓰기 없음)');

  // 4) 신규 개정 건 1개가 추가로 감지되면 그 건만 저장되어야 함
  const withNewCase = [
    ...FLAT_RESULTS,
    {
      법령ID: '001850',
      법령명: '고압가스 안전관리법',
      공포번호: '99999',
      공포일: '2026.07.20',
      시행예정일: '2027.03.01',
    },
  ];
  const thirdRun = await savePendingAmendments(db, withNewCase);
  assert.equal(thirdRun.length, 1, `기존 5건은 스킵되고 신규 1건만 저장되어야 함, 실제 ${thirdRun.length}건`);
  assert.equal(thirdRun[0].docId, '001850_99999');

  console.log('✅ 모든 검증 통과 — 그룹핑(5건)·최초저장·중복스킵·증분감지가 모두 정상 동작합니다.');
}

main().catch((err) => {
  console.error('❌ 자체 테스트 실패:', err);
  process.exitCode = 1;
});
