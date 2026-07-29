#!/usr/bin/env node
'use strict';

// runPipeline이 STEP 2~6을 순서대로 실행하고, 어떤 경우든 batchLogs에 기록을
// 남기는지 통합적으로 검증한다. 각 단계 자체의 상세 로직은 이미 개별
// selftest들이 검증했으므로, 여기서는 "단계 연결·집계·항상 로그 기록"만 본다.
//
// 시나리오:
//   1) 정상 경로: 법령 1건(산업안전보건법)만 시행대기 상태로 흘려서 탐지→저장→
//      변경조문추출→본문조회→요약까지 전부 성공하고 batchLogs에 5단계가 모두
//      기록되는지 확인.
//   2) 실패 경로: pendingAmendments 컬렉션 접근 자체가 던지도록(Firestore 장애
//      시뮬레이션) 만들어서, 저장 단계가 통째로 실패해도 runPipeline이 삼키고
//      batchLogs에는 여전히 기록을 남기는지 확인. (탐지는 법령 단위로 이미
//      try-catch되어 있어 LAW_OC가 없어도 "0건 성공"으로 끝나 버리므로, 이
//      시나리오에는 쓸 수 없다 — Firestore 장애가 더 현실적인 통째 실패 사례다)
//
// 실행: node scripts/runPipeline.selftest.js

const assert = require('node:assert/strict');
const { runPipeline } = require('../lib/runPipeline');

const LAW_ID = '001766';
const LAW_NAME = '산업안전보건법';
const PROCL_NO = '99001';
const PROCL_DATE = '20260101';
const EF_YD = '20271231'; // 오늘(테스트 기준일)보다 확실히 미래
const MST = '900001';

process.env.GEMINI_API_KEY = 'fake-key-for-test';

function createFakeFirestore() {
  const collections = new Map();
  let autoId = 0;

  function store(name) {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  }

  return {
    collection(name) {
      const s = store(name);
      return {
        doc(id) {
          return {
            async get() {
              return { exists: s.has(id), data: () => s.get(id) };
            },
            async set(data) {
              s.set(id, data);
            },
            async update(patch) {
              s.set(id, { ...s.get(id), ...patch });
            },
          };
        },
        async add(data) {
          const id = `auto_${++autoId}`;
          s.set(id, data);
          return { id };
        },
        where(field, op, value) {
          if (op !== '==') throw new Error(`지원하지 않는 연산자: ${op}`);
          return {
            async get() {
              const docs = [...s.entries()]
                .filter(([, data]) => data[field] === value)
                .map(([id, data]) => ({ id, data: () => data }));
              return { docs };
            },
          };
        },
      };
    },
    _dump(name) {
      return [...store(name).entries()];
    },
    _seed(name, id, data) {
      store(name).set(id, data);
    },
  };
}

function mockFetch(urlString, init, opts = {}) {
  const url = new URL(urlString);

  if (url.host.includes('generativelanguage.googleapis.com')) {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '테스트 요약입니다.' }] } }],
      }),
    });
  }

  // law.go.kr 직접 호출 (eflaw는 ID가 아니라 query=법령명으로 검색된다 —
  // 실제 API 호출로 확인한 동작을 그대로 흉내낸다)
  const target = url.searchParams.get('target');
  const query = url.searchParams.get('query');
  const mst = url.searchParams.get('MST');
  const jo = url.searchParams.get('jo');

  let data;
  if (target === 'eflaw') {
    data =
      !opts.eflawEmpty && query === LAW_NAME
        ? {
            LawSearch: {
              law: {
                법령ID: LAW_ID,
                법령명한글: LAW_NAME,
                법령일련번호: MST,
                공포번호: PROCL_NO,
                공포일자: PROCL_DATE,
                시행일자: EF_YD,
              },
            },
          }
        : { LawSearch: {} };
  } else if (target === 'lsJoHstInf') {
    data = {
      LsJoHstInf: {
        joHst: [{ 조문번호통합: '003800', 개정구분: '일부개정', 조문개정일자: PROCL_DATE }],
      },
    };
  } else if (target === 'law' && !jo) {
    data = { LawSearch: { law: { 법령일련번호: MST } } };
  } else if (target === 'law' && jo) {
    const efYdParam = url.searchParams.get('efYd');
    data = {
      Law: {
        조문단위: {
          조문제목: '안전조치',
          조문내용: efYdParam ? `[개정 MST=${mst}] ${jo}` : `[현행 MST=${mst}] ${jo}`,
        },
      },
    };
  } else {
    data = {};
  }

  return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify(data) });
}

async function runHappyPath() {
  process.env.LAW_OC = 'fake-oc-for-test';
  global.fetch = mockFetch;
  const db = createFakeFirestore();

  const log = await runPipeline({ db });

  console.log('정상 경로 로그:', JSON.stringify(log, null, 2));

  assert.equal(log.단계.탐지.성공, true);
  assert.equal(log.단계.탐지.행수, 1);
  assert.equal(log.단계.저장.신규건수, 1);
  assert.equal(log.단계.변경조문추출.성공건수, 1);
  assert.equal(log.단계.본문조회.성공건수, 1);
  assert.equal(log.단계.요약.성공건수, 1);
  assert.ok(log.시작시각 && log.종료시각);

  const docId = `${LAW_ID}_${PROCL_NO}`;
  const savedDoc = db._dump('pendingAmendments').find(([id]) => id === docId)?.[1];
  assert.ok(savedDoc, 'pendingAmendments 문서가 저장되어야 함');
  assert.equal(savedDoc.처리상태, 'summarized');
  assert.deepEqual(savedDoc.changedArticles, ['제38조']);
  assert.equal(savedDoc.summary[0].요약, '테스트 요약입니다.');

  const batchLogs = db._dump('batchLogs');
  assert.equal(batchLogs.length, 1, 'batchLogs에 1건 기록되어야 함');
}

async function runFailurePath() {
  process.env.LAW_OC = 'fake-oc-for-test'; // 유효한 값 — 탐지는 정상적으로 1건을 찾아야 한다
  global.fetch = mockFetch;

  // pendingAmendments 컬렉션 접근만 고장 나도록 만든 가짜 Firestore
  // (batchLogs는 정상 동작해야 기록 여부를 검증할 수 있다).
  const real = createFakeFirestore();
  const brokenDb = {
    collection(name) {
      if (name === 'pendingAmendments') {
        throw new Error('Firestore 연결 실패(테스트 시뮬레이션)');
      }
      return real.collection(name);
    },
  };

  const log = await runPipeline({ db: brokenDb });

  console.log('\n실패 경로 로그:', JSON.stringify(log, null, 2));

  assert.equal(log.단계.탐지.성공, true, '탐지 자체는 정상 성공해야 함');
  assert.equal(log.단계.저장.성공, false, '저장 단계는 Firestore 장애로 실패해야 함');
  assert.ok(log.단계.저장.error);
  assert.ok(!log.단계.변경조문추출, '저장 단계가 실패하면 다음 단계는 시도되지 않아야 함');

  const batchLogs = real._dump('batchLogs');
  assert.equal(batchLogs.length, 1, '실패해도 batchLogs에 1건 기록되어야 함');
}

// 실제로 겪은 사례: STEP 4(lsJoHstInf)가 파라미터 문제로 changedArticles를
// 빈 배열로 남긴 채 'pending' 상태로 멈춘 문서가 있었다. dedup 때문에 다음
// 실행에서 새로 감지되지 않아 영원히 재처리되지 않는 문제를, 이번 실행에
// 새로 감지된 건이 하나도 없어도 그 문서를 다시 집어서 완료까지 이어가는지
// 확인한다.
async function runStuckDocRetryPath() {
  process.env.LAW_OC = 'fake-oc-for-test';
  global.fetch = (urlString, init) => mockFetch(urlString, init, { eflawEmpty: true });

  const db = createFakeFirestore();
  const stuckDocId = `${LAW_ID}_${PROCL_NO}`;
  db._seed('pendingAmendments', stuckDocId, {
    법령ID: LAW_ID,
    법령명: LAW_NAME,
    MST,
    공포번호: PROCL_NO,
    공포일: '2026.01.01',
    시행예정일: [EF_YD],
    changedArticles: [],
    처리상태: 'pending',
  });

  const log = await runPipeline({ db });

  console.log('\n막힌 건 재시도 로그:', JSON.stringify(log, null, 2));

  assert.equal(log.단계.탐지.행수, 0, '이번 실행에서는 새로 감지된 건이 없어야 함');
  assert.equal(log.단계.저장.신규건수, 0);
  assert.equal(log.단계.저장.재시도건수, 1, '막혀 있던 건 1개가 재시도 대상으로 잡혀야 함');
  assert.equal(log.단계.변경조문추출.성공건수, 1, '막혀 있던 건의 변경조문 추출이 이번엔 성공해야 함');

  const stuckDoc = db._dump('pendingAmendments').find(([id]) => id === stuckDocId)?.[1];
  assert.equal(
    stuckDoc.처리상태,
    'summarized',
    '막혀 있던 건이 재처리를 통해 summarized까지 도달해야 함'
  );
}

async function main() {
  await runHappyPath();
  await runFailurePath();
  await runStuckDocRetryPath();
  console.log('\n✅ 모든 검증 통과 — 파이프라인 연결·집계·항상 배치로그 기록이 정상 동작합니다.');
}

main().catch((err) => {
  console.error('❌ 자체 테스트 실패:', err);
  process.exitCode = 1;
});
