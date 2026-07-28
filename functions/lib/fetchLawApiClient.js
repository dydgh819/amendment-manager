'use strict';

const { XMLParser } = require('fast-xml-parser');

// GitHub Actions 등 신뢰된 서버 환경에서 직접 실행되므로, 더 이상 Cloud Function
// 프록시를 거치지 않고 open.law.go.kr을 바로 호출한다. OC 키는 process.env.LAW_OC로
// 관리하며 프론트에는 절대 노출하지 않는다 (GitHub Secrets에만 보관).
const LAW_BASE_URLS = {
  lawSearch: 'http://www.law.go.kr/DRF/lawSearch.do',
  lawService: 'http://www.law.go.kr/DRF/lawService.do',
};

const REQUEST_TIMEOUT_MS = 15000;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  // 법령ID·공포번호 등 앞자리 0이 있는 값이 숫자로 변환되며 0을 잃지 않도록
  // 모든 태그/속성 값을 문자열로 유지한다.
  parseTagValue: false,
  parseAttributeValue: false,
});

/**
 * open.law.go.kr Open API를 직접 호출한다.
 *
 * @param {object} params
 * @param {string} [params.endpoint] 'lawSearch'(기본) | 'lawService' — 각각 DRF/lawSearch.do, DRF/lawService.do
 * @param {string} params.target Open API의 target 파라미터 (예: eflaw)
 * @returns {Promise<object>} XML을 JSON으로 변환한 응답 데이터
 */
async function callFetchLawApi(params) {
  const ocKey = process.env.LAW_OC;
  if (!ocKey) {
    throw new Error('LAW_OC 환경변수가 설정되어 있지 않습니다.');
  }

  const {
    endpoint = 'lawSearch',
    target,
    OC: _ignoredOc, // 호출부가 OC를 덮어쓰지 못하도록 무시
    type: _ignoredType, // 응답 포맷은 항상 XML로 고정하고 JSON으로 변환한다
    ...rest
  } = params;

  if (!target) {
    throw new Error('target 파라미터는 필수입니다. (예: eflaw)');
  }

  const baseUrl = LAW_BASE_URLS[endpoint];
  if (!baseUrl) {
    throw new Error(`endpoint 값이 올바르지 않습니다. 허용값: ${Object.keys(LAW_BASE_URLS).join(', ')}`);
  }

  const upstreamUrl = buildUpstreamUrl(baseUrl, { OC: ocKey, target, type: 'XML', ...rest });

  const response = await fetchWithTimeout(upstreamUrl, REQUEST_TIMEOUT_MS);
  const bodyText = await response.text();

  if (!response.ok) {
    throw new Error(`Open API 호출이 실패했습니다. (상위 서버 status: ${response.status})`);
  }

  return parseUpstreamBody(bodyText);
}

function buildUpstreamUrl(baseUrl, params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) query.append(key, String(item));
    } else {
      query.set(key, String(value));
    }
  }
  return `${baseUrl}?${query.toString()}`;
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Open API는 기본적으로 XML을 반환하지만, 향후 응답 포맷이 바뀌는 경우까지
// 대비해 JSON으로 오는 응답도 그대로 통과시킨다.
function parseUpstreamBody(bodyText) {
  const trimmed = bodyText.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // JSON 파싱 실패 시 XML로 간주하고 계속 진행
    }
  }
  return xmlParser.parse(trimmed);
}

module.exports = { callFetchLawApi, LAW_BASE_URLS };
