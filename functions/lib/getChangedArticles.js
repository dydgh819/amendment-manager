'use strict';

const { callFetchLawApi } = require('./fetchLawApiClient');

// 국가법령정보 Open API의 "조문별 개정이력" 엔드포인트는 공식 문서상 정확한
// target 파라미터명이 확인되지 않아 최선의 추정치를 기본값으로 둔다.
// (PRD 리스크 항목: "조문별 변경 이력 API의 정확한 응답 필드명·구조는 실제
//  호출 테스트로 확정 필요") 실제 OC 키로 처음 호출할 때 logRaw로 원본 구조를
// 확인하고, 다르면 이 값과 아래 pick() 후보 목록을 보정한다.
const ARTICLE_HISTORY_TARGET = 'lsJoHstInf';

function toArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function pick(entry, candidateKeys) {
  for (const key of candidateKeys) {
    const value = entry[key];
    if (value !== undefined && value !== null && value !== '') return String(value);
  }
  return undefined;
}

function extractHistoryEntries(rawData) {
  const root = rawData?.LsJoHstInf || rawData?.lsJoHstInf || rawData || {};
  const rawEntries = root.joHst ?? root.law ?? root.item ?? [];
  return toArray(rawEntries);
}

// "003800" -> "제38조", "003102" -> "제31조의2"
function formatArticleNumber(rawJo) {
  if (!rawJo) return undefined;
  const digits = String(rawJo).padStart(6, '0');
  const article = parseInt(digits.slice(0, 4), 10);
  const branch = parseInt(digits.slice(4, 6), 10);
  if (Number.isNaN(article)) return undefined;
  return branch > 0 ? `제${article}조의${branch}` : `제${article}조`;
}

// "제31조의2" -> "003102", "제38조" -> "003800"
function parseArticleNumber(label) {
  const m = String(label).match(/^제(\d+)조(?:의(\d+))?$/);
  if (!m) return undefined;
  const article = String(m[1]).padStart(4, '0');
  const branch = String(m[2] || 0).padStart(2, '0');
  return `${article}${branch}`;
}

function normalizeEntry(entry) {
  const combinedJo = pick(entry, ['조문번호통합', 'jo']);
  const articleOnly = pick(entry, ['조문번호']);
  const branchOnly = pick(entry, ['조문가지번호']);

  const articleNumber = combinedJo
    ? formatArticleNumber(combinedJo)
    : formatArticleNumber(
        `${String(articleOnly ?? '0').padStart(4, '0')}${String(branchOnly ?? '0').padStart(2, '0')}`
      );

  return {
    조문번호: articleNumber,
    개정구분: pick(entry, ['개정구분', '개정구분명']),
    변경사유: pick(entry, ['변경사유', '변경사유명']),
    공포일자: pick(entry, ['공포일자', '공포일']),
    조문개정일자: pick(entry, ['조문개정일자', '조문개정일']),
  };
}

function sortArticleNumbers(articleNumbers) {
  const parse = (label) => {
    const m = label.match(/제(\d+)조(?:의(\d+))?/);
    return m ? [Number(m[1]), Number(m[2] || 0)] : [Infinity, 0];
  };
  return [...articleNumbers].sort((a, b) => {
    const [a1, a2] = parse(a);
    const [b1, b2] = parse(b);
    return a1 - b1 || a2 - b2;
  });
}

/**
 * 특정 개정 건(법령ID + 공포일자)에서 실제로 바뀐 조문 번호만 추출한다.
 * 조문별 개정이력 전체 목록을 받아온 뒤, 조문개정일자(없으면 공포일자)가
 * 이번 개정의 공포일자와 일치하는 항목만 걸러낸다.
 *
 * @param {object} options
 * @param {string} options.baseUrl fetchLawApi 엔드포인트
 * @param {string} options.lawId 법령ID
 * @param {string} [options.mst] 법령일련번호(있으면 함께 전달)
 * @param {string} options.proclDate 이번 개정의 공포일자 YYYYMMDD
 * @param {boolean} [options.logRaw] 원본 응답을 콘솔에 출력할지 여부
 * @returns {Promise<string[]>} 예: ["제31조의2", "제33조", "제117조", "제175조"]
 */
async function getChangedArticles({ baseUrl, lawId, mst, proclDate, logRaw = false }) {
  if (!lawId || !proclDate) {
    throw new Error('lawId와 proclDate(공포일자)는 필수입니다.');
  }

  const rawData = await callFetchLawApi(baseUrl, {
    endpoint: 'lawService',
    target: ARTICLE_HISTORY_TARGET,
    ID: lawId,
    ...(mst ? { MST: mst } : {}),
  });

  if (logRaw) {
    console.log(`[디버그] ${lawId} 조문별 개정이력 원본 응답 (target=${ARTICLE_HISTORY_TARGET}):`);
    console.log(JSON.stringify(rawData, null, 2));
  }

  const entries = extractHistoryEntries(rawData).map(normalizeEntry);

  const changed = entries.filter(
    (entry) => entry.조문번호 && (entry.조문개정일자 || entry.공포일자) === proclDate
  );

  const unique = [...new Set(changed.map((entry) => entry.조문번호))];
  return sortArticleNumbers(unique);
}

module.exports = {
  getChangedArticles,
  formatArticleNumber,
  parseArticleNumber,
  sortArticleNumbers,
  ARTICLE_HISTORY_TARGET,
};
