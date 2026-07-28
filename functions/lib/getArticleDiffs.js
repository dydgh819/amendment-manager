'use strict';

const { callFetchLawApi } = require('./fetchLawApiClient');
const { parseArticleNumber } = require('./getChangedArticles');

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

function extractArticleEntry(rawData) {
  const root = rawData?.Law || rawData?.LawService || rawData || {};
  const rawEntries = root.조문단위 ?? root.조문 ?? root.Article ?? [];
  return toArray(rawEntries)[0];
}

async function fetchArticleText({ baseUrl, mst, jo, efYd, logRaw }) {
  const rawData = await callFetchLawApi(baseUrl, {
    endpoint: 'lawService',
    target: 'law',
    MST: mst,
    jo,
    ...(efYd ? { efYd } : {}),
  });

  if (logRaw) {
    console.log(`[디버그] MST=${mst} jo=${jo}${efYd ? ` efYd=${efYd}` : ''} 조문 본문 원본 응답:`);
    console.log(JSON.stringify(rawData, null, 2));
  }

  const entry = extractArticleEntry(rawData);
  if (!entry) return { 조문제목: undefined, 조문내용: undefined };

  return {
    조문제목: pick(entry, ['조문제목', 'joSubject']),
    조문내용: pick(entry, ['조문내용', 'joContent', '조문시행문']),
  };
}

/**
 * 변경된 조문들의 시행 전(현행)/시행 후(개정예정) 본문을 각각 조회한다.
 *
 * 현행본은 법령ID의 "현재(현행) MST"로, 개정본은 이 개정 건(공포번호) 고유의
 * eflaw MST + efYd로 조회한다. 두 MST는 케이스에 따라 같을 수도 다를 수도
 * 있음을 실제 데이터로 확인했다 (getCurrentMst.js 주석 참고).
 *
 * @param {object} options
 * @param {string} options.baseUrl
 * @param {string} options.currentMst 법령ID의 현재(현행) MST
 * @param {string} options.pendingMst 이 개정 건(공포번호) 고유의 eflaw MST
 * @param {string} options.efYd 시행예정일 YYYYMMDD (개정본 조회에 사용)
 * @param {string[]} options.changedArticles STEP 4에서 추출한 변경 조문 목록 (예: ["제38조"])
 * @param {boolean} [options.logRaw]
 * @returns {Promise<Array<{조문번호, 조문제목, 현행본문, 개정본문}>>}
 */
async function getArticleDiffs({
  baseUrl,
  currentMst,
  pendingMst,
  efYd,
  changedArticles,
  logRaw = false,
}) {
  if (!currentMst || !pendingMst || !efYd) {
    throw new Error('currentMst, pendingMst, efYd는 모두 필수입니다.');
  }

  const results = [];
  let loggedSample = false;

  for (const articleNumber of changedArticles) {
    const jo = parseArticleNumber(articleNumber);
    if (!jo) {
      console.error(`[오류] 조문번호 형식을 해석할 수 없습니다: ${articleNumber}`);
      continue;
    }

    try {
      const [before, after] = await Promise.all([
        fetchArticleText({ baseUrl, mst: currentMst, jo, logRaw: logRaw && !loggedSample }),
        fetchArticleText({ baseUrl, mst: pendingMst, jo, efYd, logRaw: false }),
      ]);
      loggedSample = true;

      results.push({
        조문번호: articleNumber,
        조문제목: before.조문제목 || after.조문제목,
        현행본문: before.조문내용,
        개정본문: after.조문내용,
      });
    } catch (err) {
      console.error(`[오류] ${articleNumber} 본문 조회 실패: ${err.message}`);
      results.push({
        조문번호: articleNumber,
        조문제목: undefined,
        현행본문: null,
        개정본문: null,
        error: err.message,
      });
    }
  }

  return results;
}

module.exports = { getArticleDiffs };
