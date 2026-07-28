'use strict';

// Google AI Studio(Gemini API)의 무료 티어 모델을 사용한다. API 키는
// https://aistudio.google.com 에서 무료로 발급받을 수 있다. 프론트에는
// 노출하지 않고 서버(스크립트/Cloud Function) 환경변수로만 관리한다.
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// gemini-2.0-flash는 이 문서 작성 시점 기준 Google AI Studio 무료 티어에
// 포함되는 모델이다. 유료 모델로 바꾸고 싶지 않다면 GEMINI_MODEL 환경변수로
// 다른 무료 모델(예: gemini-2.5-flash-lite)을 지정하면 된다.
const DEFAULT_MODEL = 'gemini-2.0-flash';

/**
 * Gemini generateContent API를 호출해서 텍스트 응답을 받는다.
 *
 * @param {object} options
 * @param {string} options.prompt
 * @param {string} [options.apiKey] 기본값: process.env.GEMINI_API_KEY
 * @param {string} [options.model] 기본값: process.env.GEMINI_MODEL || DEFAULT_MODEL
 * @param {boolean} [options.logRaw]
 * @returns {Promise<string>}
 */
async function callGemini({
  prompt,
  apiKey = process.env.GEMINI_API_KEY,
  model = process.env.GEMINI_MODEL || DEFAULT_MODEL,
  logRaw = false,
} = {}) {
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY가 설정되어 있지 않습니다.');
  }
  if (!prompt) {
    throw new Error('prompt가 필요합니다.');
  }

  const url = `${GEMINI_API_BASE}/${model}:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });

  const body = await response.json().catch(() => null);

  if (logRaw) {
    console.log(`[디버그] Gemini(${model}) 원본 응답:`);
    console.log(JSON.stringify(body, null, 2));
  }

  if (!response.ok) {
    const message = body?.error?.message || `HTTP ${response.status}`;
    throw new Error(`Gemini API 호출 실패: ${message}`);
  }

  const text = body?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    const blockReason = body?.promptFeedback?.blockReason;
    throw new Error(
      blockReason
        ? `Gemini 응답이 차단되었습니다 (${blockReason})`
        : 'Gemini 응답에서 텍스트를 찾을 수 없습니다.'
    );
  }

  return text.trim();
}

module.exports = { callGemini, DEFAULT_MODEL, GEMINI_API_BASE };
