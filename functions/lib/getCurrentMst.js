'use strict';

const { callFetchLawApi } = require('./fetchLawApiClient');

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

function extractLawEntries(rawData) {
  const root = rawData?.LawSearch || rawData?.lawSearch || rawData || {};
  const rawEntries = root.law ?? root.Law ?? [];
  return toArray(rawEntries);
}

// 개정 예정 건의 eflaw MST는 케이스마다 "현재 시행중인 MST"와 같을 수도, 다를 수도
// 있음을 실제 데이터로 확인했다 (예: 산업안전보건법 2026-02-19 공포 건은 283449로
// 현재 MST 287805와 다름). 그래서 "현행본" 조회에는 이 함수로 별도 조회한
// 법령ID의 현재 MST를 쓰고, "시행예정본" 조회에는 STEP 2/3에서 저장해 둔
// 그 개정 건 고유의 MST를 쓴다.
async function getCurrentMst({ baseUrl, lawId, logRaw = false }) {
  if (!lawId) {
    throw new Error('lawId가 필요합니다.');
  }

  const rawData = await callFetchLawApi(baseUrl, {
    endpoint: 'lawSearch',
    target: 'law',
    ID: lawId,
  });

  if (logRaw) {
    console.log(`[디버그] ${lawId} 현재 MST 조회 원본 응답 (target=law):`);
    console.log(JSON.stringify(rawData, null, 2));
  }

  const entries = extractLawEntries(rawData);
  if (entries.length === 0) {
    throw new Error(`법령ID ${lawId}의 현재 MST를 찾을 수 없습니다.`);
  }

  const mst = pick(entries[0], ['법령일련번호', 'MST', 'lawSerialNo']);
  if (!mst) {
    throw new Error(`법령ID ${lawId} 응답에 법령일련번호(MST) 필드가 없습니다.`);
  }

  return mst;
}

module.exports = { getCurrentMst };
