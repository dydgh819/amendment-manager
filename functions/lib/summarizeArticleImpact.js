'use strict';

const { callGemini } = require('./geminiClient');

// PRD 4장: "대상 사업장(울산 1·2·3공장) 맥락"
const WORKPLACE_CONTEXT = '울산 1·2·3공장, 석유화학 공정 안전보건 실무';

function buildPrompt({ 조문번호, 조문제목, 현행본문, 개정본문 }) {
  return `다음은 한국 법령의 개정 조문입니다. 대상 사업장 맥락: ${WORKPLACE_CONTEXT}.

조문: ${조문번호}${조문제목 ? ` (${조문제목})` : ''}

[현행 조문]
${현행본문 || '(내용 없음)'}

[개정 조문]
${개정본문 || '(내용 없음)'}

이 조문 개정이 실무에 어떤 영향을 주는지 3~5문장으로 요약해줘. 특히 담당자가 시행 전 준비해야 할 액션이 있으면 명시해줘.`;
}

/**
 * 조문 하나의 시행 전/후 본문을 Gemini에 넘겨 실무 영향 요약을 받는다.
 *
 * @param {{조문번호: string, 조문제목?: string, 현행본문?: string, 개정본문?: string}} articleDiff
 * @param {{logRaw?: boolean}} [options]
 * @returns {Promise<{조문번호: string, 조문제목?: string, 요약: string}>}
 */
async function summarizeArticleImpact(articleDiff, { logRaw = false } = {}) {
  const prompt = buildPrompt(articleDiff);
  const 요약 = await callGemini({ prompt, logRaw });

  return {
    조문번호: articleDiff.조문번호,
    조문제목: articleDiff.조문제목,
    요약,
  };
}

module.exports = { summarizeArticleImpact, buildPrompt, WORKPLACE_CONTEXT };
