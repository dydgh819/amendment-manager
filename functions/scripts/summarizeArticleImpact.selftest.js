#!/usr/bin/env node
'use strict';

// 실제 Gemini API 호출 없이 프롬프트 구성과 응답 파싱을 검증한다.
//
// 실행: node scripts/summarizeArticleImpact.selftest.js

const assert = require('node:assert/strict');
const { summarizeArticleImpact, buildPrompt, WORKPLACE_CONTEXT } = require('../lib/summarizeArticleImpact');

const SAMPLE_DIFF = {
  조문번호: '제38조',
  조문제목: '안전조치',
  현행본문: '(현행) 사업주는 안전조치를 하여야 한다.',
  개정본문: '(개정) 사업주는 안전조치를 하여야 하며, 추가로 위험성평가를 실시하여야 한다.',
};

async function main() {
  // 1) 프롬프트에 필요한 정보가 모두 포함되는지
  const prompt = buildPrompt(SAMPLE_DIFF);
  assert.ok(prompt.includes(WORKPLACE_CONTEXT), '프롬프트에 사업장 맥락이 포함되어야 함');
  assert.ok(prompt.includes('제38조'), '프롬프트에 조문번호가 포함되어야 함');
  assert.ok(prompt.includes(SAMPLE_DIFF.현행본문), '프롬프트에 현행본문이 포함되어야 함');
  assert.ok(prompt.includes(SAMPLE_DIFF.개정본문), '프롬프트에 개정본문이 포함되어야 함');
  assert.ok(prompt.includes('3~5문장'), '프롬프트에 3~5문장 요약 지시가 포함되어야 함');

  // 2) Gemini 응답 파싱
  process.env.GEMINI_API_KEY = 'fake-key-for-test';
  let capturedUrl;
  let capturedBody;
  global.fetch = async (urlString, init) => {
    capturedUrl = urlString;
    capturedBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [{ text: '위험성평가 실시 의무가 추가되므로 시행 전 절차를 마련해야 합니다.' }],
            },
          },
        ],
      }),
    };
  };

  const result = await summarizeArticleImpact(SAMPLE_DIFF);

  assert.ok(capturedUrl.includes('generativelanguage.googleapis.com'), 'Gemini 엔드포인트로 호출되어야 함');
  assert.ok(capturedUrl.includes('gemini-2.0-flash'), '기본 모델(gemini-2.0-flash)이 사용되어야 함');
  assert.equal(capturedBody.contents[0].parts[0].text, prompt);

  assert.equal(result.조문번호, '제38조');
  assert.equal(result.조문제목, '안전조치');
  assert.equal(result.요약, '위험성평가 실시 의무가 추가되므로 시행 전 절차를 마련해야 합니다.');

  console.log('요약 결과:', result);
  console.log('\n✅ 모든 검증 통과 — 프롬프트 구성과 Gemini 응답 파싱이 정상 동작합니다.');
}

main().catch((err) => {
  console.error('❌ 자체 테스트 실패:', err);
  process.exitCode = 1;
});
