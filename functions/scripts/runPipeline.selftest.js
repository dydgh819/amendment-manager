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
//   2) 실패 경로: baseUrl을 비워서 탐지 단계 자체가 던지는 예외를 runPipeline이
//      삼키고, 그래도 batchLogs에 실패 기록을 남기는지 확인.
//
// 실행: node scripts/runPipeline.selftest.js

const assert = require('node:assert/strict');
const { runPipeline } = require('../lib/runPipeline');

const LAW_ID = '001766';
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
      };
    },
    _dump(name) {
      return [...store(name).entries()];
    },
  };
}

function mockFetch(urlString, init) {
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

  // fetchLawApi 프록시 호출
  const target = url.searchParams.get('target');
  const id = url.searchParams.get('ID');
  const mst = url.searchParams.get('MST');
  const jo = url.searchParams.get('jo');

  let data;
  if (target === 'eflaw') {
    data =
      id === LAW_ID
        ? {
            LawSearch: {
              law: {
                법령ID: LAW_ID,
                법령명한글: '산업안전보건법',
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

  return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, data }) });
}

async function runHappyPath() {
  global.fetch = mockFetch;
  const db = createFakeFirestore();

  const log = await runPipeline({ baseUrl: 'http://mock/fetchLawApi', db });

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
  global.fetch = mockFetch;
  const db = createFakeFirestore();

  // baseUrl을 비워서 detectPendingAmendments가 즉시 던지도록 유도
  const log = await runPipeline({ baseUrl: '', db });

  console.log('\n실패 경로 로그:', JSON.stringify(log, null, 2));

  assert.equal(log.단계.탐지.성공, false);
  assert.ok(log.단계.탐지.error);
  assert.ok(!log.단계.저장, '탐지 단계가 실패하면 저장 단계는 시도되지 않아야 함');

  const batchLogs = db._dump('batchLogs');
  assert.equal(batchLogs.length, 1, '실패해도 batchLogs에 1건 기록되어야 함');
}

async function main() {
  await runHappyPath();
  await runFailurePath();
  console.log('\n✅ 모든 검증 통과 — 파이프라인 연결·집계·항상 배치로그 기록이 정상 동작합니다.');
}

main().catch((err) => {
  console.error('❌ 자체 테스트 실패:', err);
  process.exitCode = 1;
});
