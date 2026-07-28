#!/usr/bin/env node
'use strict';

// updateSummaries의 Firestore 연동을 가짜 Firestore + 가짜 Gemini 응답으로 검증한다:
// - articleDiffs가 있는 문서는 조문별로 요약을 만들어 summary 배열로 저장하고 처리상태를 summarized로 바꾼다.
// - articleDiffs가 빈 문서는 Gemini를 호출하지 않고 스킵한다.
// - 조문 하나의 요약이 실패해도(예: Gemini 오류) 나머지는 계속 처리되고, 실패건은 summary에 error로 남되
//   문서 전체는 그래도 summarized로 표시된다 (부분 실패가 전체를 막지 않음).
//
// 실행: node scripts/updateSummaries.selftest.js

const assert = require('node:assert/strict');
const { updateSummaries } = require('../lib/updateSummaries');

process.env.GEMINI_API_KEY = 'fake-key-for-test';

global.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  const prompt = body.contents[0].parts[0].text;

  if (prompt.includes('제110조')) {
    // 이 조문만 실패하도록 시뮬레이션
    return { ok: false, status: 500, json: async () => ({ error: { message: '일시적 오류' } }) };
  }

  const articleMatch = prompt.match(/조문: (제\d+조(?:의\d+)?)/);
  const articleNumber = articleMatch ? articleMatch[1] : '알수없음';

  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: `${articleNumber} 요약 텍스트` }] } }],
    }),
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
    '001766_21534': {
      articleDiffs: [{ 조문번호: '제175조', 조문제목: '과태료', 현행본문: '현행', 개정본문: '개정' }],
      처리상태: 'pending',
    },
    '001766_21374': {
      articleDiffs: [
        { 조문번호: '제38조', 조문제목: '안전조치', 현행본문: '현행', 개정본문: '개정' },
        { 조문번호: '제110조', 조문제목: 'MSDS', 현행본문: '현행', 개정본문: '개정' },
      ],
      처리상태: 'pending',
    },
    '001849_21252': { articleDiffs: [], 처리상태: 'pending' },
  });

  const results = await updateSummaries(db, ['001766_21534', '001766_21374', '001849_21252']);

  console.log('결과:', JSON.stringify(results, null, 2));

  // 1) 정상 케이스: summary 채워지고 처리상태 summarized로 변경
  const case21534 = results.find((r) => r.docId === '001766_21534');
  assert.equal(case21534.summary.length, 1);
  assert.equal(case21534.summary[0].요약, '제175조 요약 텍스트');
  assert.equal(db._get('001766_21534').처리상태, 'summarized');

  // 2) 부분 실패 케이스: 제38조는 성공, 제110조는 실패해도 문서는 summarized
  const case21374 = results.find((r) => r.docId === '001766_21374');
  assert.equal(case21374.summary.length, 2);
  const jo38 = case21374.summary.find((s) => s.조문번호 === '제38조');
  const jo110 = case21374.summary.find((s) => s.조문번호 === '제110조');
  assert.equal(jo38.요약, '제38조 요약 텍스트');
  assert.equal(jo110.요약, null);
  assert.ok(jo110.error, '실패한 조문에는 error가 기록되어야 함');
  assert.equal(
    db._get('001766_21374').처리상태,
    'summarized',
    '일부 조문이 실패해도 문서 처리상태는 summarized로 바뀌어야 함'
  );

  // 3) articleDiffs가 빈 문서는 Gemini 호출 없이 스킵
  const caseEmpty = results.find((r) => r.docId === '001849_21252');
  assert.deepEqual(caseEmpty.summary, []);
  assert.notEqual(
    db._get('001849_21252').처리상태,
    'summarized',
    'articleDiffs가 없는 문서는 처리상태가 바뀌면 안 됨'
  );

  console.log('\n✅ 모든 검증 통과 — 요약 저장·부분실패 허용·빈 articleDiffs 스킵이 정상 동작합니다.');
}

main().catch((err) => {
  console.error('❌ 자체 테스트 실패:', err);
  process.exitCode = 1;
});
