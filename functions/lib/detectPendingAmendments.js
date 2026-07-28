'use strict';

const { TARGET_LAWS } = require('./lawIds');
const { callFetchLawApi } = require('./fetchLawApiClient');

// 국가법령정보 Open API "시행일 법령 목록 조회"(target=eflaw) 응답은
// 루트 엘리먼트(LawSearch) 아래 law 항목이 결과가 1건이면 객체, 여러 건이면
// 배열로 내려온다. XML->JSON 변환 특성상 둘 다 처리해야 한다.
function toArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

// 실제 open.law.go.kr 필드명은 한글이지만, 문서마다 표기가 다를 수 있어
// 후보 필드명을 여러 개 시도한다. (PRD 리스크 항목: 응답 구조는 실제 호출로 확정 필요)
function pick(entry, candidateKeys) {
  for (const key of candidateKeys) {
    const value = entry[key];
    if (value !== undefined && value !== null && value !== '') return String(value);
  }
  return undefined;
}

function extractEflawEntries(rawData) {
  const root = rawData?.LawSearch || rawData?.lawSearch || rawData || {};
  const rawEntries = root.law ?? root.Law ?? root.eflaw ?? [];
  return toArray(rawEntries);
}

function normalizeEntry(entry, fallbackLawId, fallbackName) {
  return {
    법령ID: pick(entry, ['법령ID', 'lawId', 'LSID']) || fallbackLawId,
    법령명: pick(entry, ['법령명한글', '법령명', 'lawName']) || fallbackName,
    공포번호: pick(entry, ['공포번호', 'proclNo']),
    공포일자: pick(entry, ['공포일자', 'proclDate']), // YYYYMMDD 원본
    시행일자: pick(entry, ['시행일자', 'efYd']), // YYYYMMDD 원본
  };
}

function formatYmd(ymd) {
  if (!ymd || ymd.length !== 8) return ymd || '';
  return `${ymd.slice(0, 4)}.${ymd.slice(4, 6)}.${ymd.slice(6, 8)}`;
}

function todayYmd(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/**
 * 15개 감시 대상 법령에 대해 target=eflaw 조회 → 시행일이 오늘 이후인
 * (= 공포됐지만 아직 시행 전인) 개정 건만 정리해서 반환한다.
 *
 * @param {object} options
 * @param {string} options.baseUrl fetchLawApi 엔드포인트 URL (필수)
 * @param {string} [options.today] 기준일 YYYYMMDD (기본: 실행 시점 오늘)
 * @param {boolean} [options.logRaw] 첫 번째 응답의 원본 구조를 콘솔에 출력할지 여부
 * @returns {Promise<Array<{법령ID, 법령명, 공포번호, 공포일, 시행예정일}>>}
 */
async function detectPendingAmendments({ baseUrl, today = todayYmd(), logRaw = false } = {}) {
  if (!baseUrl) {
    throw new Error('baseUrl(fetchLawApi 엔드포인트)이 필요합니다.');
  }

  const results = [];
  let loggedSample = false;

  for (const { lawId, name } of TARGET_LAWS) {
    try {
      const rawData = await callFetchLawApi(baseUrl, {
        endpoint: 'lawSearch',
        target: 'eflaw',
        ID: lawId,
      });

      if (logRaw && !loggedSample) {
        console.log(`[디버그] ${name}(${lawId}) eflaw 원본 응답 구조:`);
        console.log(JSON.stringify(rawData, null, 2));
        loggedSample = true;
      }

      const entries = extractEflawEntries(rawData).map((entry) =>
        normalizeEntry(entry, lawId, name)
      );

      const pending = entries.filter((entry) => entry.시행일자 && entry.시행일자 > today);

      for (const entry of pending) {
        results.push({
          법령ID: entry.법령ID,
          법령명: entry.법령명,
          공포번호: entry.공포번호,
          공포일: formatYmd(entry.공포일자),
          시행예정일: formatYmd(entry.시행일자),
        });
      }
    } catch (err) {
      console.error(`[오류] ${name}(${lawId}) eflaw 조회 실패: ${err.message}`);
    }
  }

  return results;
}

module.exports = { detectPendingAmendments, todayYmd, formatYmd };
