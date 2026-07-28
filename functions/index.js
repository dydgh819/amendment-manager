const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const { XMLParser } = require('fast-xml-parser');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const { runPipeline } = require('./lib/runPipeline');

admin.initializeApp();

const REGION = 'asia-northeast3';

// 국가법령정보 공동활용 Open API 인증키. 배포 시 Secret Manager에 저장:
//   firebase functions:secrets:set LAW_OC
// 프론트엔드에는 절대 전달하지 않고, 이 함수 내부에서만 사용한다.
const LAW_OC = defineSecret('LAW_OC');

// Gemini API 키(STEP 6 실무 영향 요약용). 배포 시 Secret Manager에 저장:
//   firebase functions:secrets:set GEMINI_API_KEY
// 아직 Gemini를 안 쓰더라도 이 스케줄 함수가 secrets로 선언하고 있으므로
// 배포 전에 값(임시 값이어도 됨)을 반드시 등록해야 한다.
const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY');

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
 * open.law.go.kr Open API 프록시.
 *
 * 요청 예시:
 *   GET /fetchLawApi?endpoint=lawSearch&target=eflaw&ID=001766
 *   GET /fetchLawApi?endpoint=lawService&target=eflaw&MST=287805&jo=003800&efYd=20260801
 *
 * - endpoint: 'lawSearch'(기본값) | 'lawService' — 상위 두 DRF 엔드포인트 중 선택
 * - target: Open API target 파라미터 (예: eflaw)
 * - 나머지 쿼리 파라미터는 그대로 상위 API에 전달된다 (ID, MST, jo, efYd 등)
 */
exports.fetchLawApi = onRequest(
  {
    secrets: [LAW_OC],
    region: 'asia-northeast3',
    cors: true,
    timeoutSeconds: 30,
  },
  async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'POST') {
        return sendError(res, 405, 'GET 또는 POST 요청만 허용됩니다.');
      }

      const params = req.method === 'GET' ? req.query : req.body || {};
      const {
        endpoint = 'lawSearch',
        target,
        OC: _ignoredOc, // 클라이언트가 OC 키를 덮어쓰지 못하도록 무시
        type: _ignoredType, // 응답 포맷은 서버가 항상 XML로 고정하고 JSON으로 변환해서 내려준다
        ...rest
      } = params;

      if (!target) {
        return sendError(res, 400, 'target 파라미터는 필수입니다. (예: eflaw)');
      }

      const baseUrl = LAW_BASE_URLS[endpoint];
      if (!baseUrl) {
        return sendError(
          res,
          400,
          `endpoint 값이 올바르지 않습니다. 허용값: ${Object.keys(LAW_BASE_URLS).join(', ')}`
        );
      }

      const upstreamUrl = buildUpstreamUrl(baseUrl, {
        OC: LAW_OC.value(),
        target,
        type: 'XML',
        ...rest,
      });

      const upstreamResponse = await fetchWithTimeout(upstreamUrl, REQUEST_TIMEOUT_MS);
      const bodyText = await upstreamResponse.text();

      if (!upstreamResponse.ok) {
        logger.error('law.go.kr 응답 오류', {
          status: upstreamResponse.status,
          endpoint,
          target,
          bodySnippet: bodyText.slice(0, 500),
        });
        return sendError(
          res,
          502,
          `Open API 호출이 실패했습니다. (상위 서버 status: ${upstreamResponse.status})`
        );
      }

      const data = parseUpstreamBody(bodyText);
      return res.status(200).json({ ok: true, data });
    } catch (err) {
      if (err.name === 'AbortError') {
        logger.error('law.go.kr 응답 지연으로 타임아웃', { message: err.message });
        return sendError(res, 504, 'Open API 응답이 지연되어 타임아웃되었습니다.');
      }
      logger.error('fetchLawApi 처리 중 알 수 없는 오류', err);
      return sendError(res, 500, err.message || '알 수 없는 오류가 발생했습니다.');
    }
  }
);

// STEP 2~6 전체 파이프라인(탐지 → 저장 → 변경조문 추출 → 본문조회 → 요약)을
// 매일 자동으로 실행하는 스케줄 함수.
//
// 실행 주기는 아래 schedule의 cron 표현식으로 조정 가능:
//   '0 3 * * *'    매일 새벽 3시(KST, 기본값)
//   '0 0,6,12,18 * * *'  6시간마다
//   '0 3 * * 1'    매주 월요일 새벽 3시
exports.runAmendmentPipeline = onSchedule(
  {
    schedule: '0 3 * * *',
    timeZone: 'Asia/Seoul',
    region: REGION,
    // LAW_OC는 fetchLawApi 함수 자신의 프로세스에서만 필요하다 — 이 스케줄
    // 함수는 fetchLawApi를 HTTP로 호출할 뿐이라 여기서는 선언하지 않는다.
    // GEMINI_API_KEY는 요약 단계가 이 함수 프로세스 안에서 직접 호출되므로 필요하다.
    secrets: [GEMINI_API_KEY],
    timeoutSeconds: 540,
    retryCount: 0, // 배치 실패는 batchLogs에 기록되므로 자동 재시도는 걸지 않는다
  },
  async () => {
    const db = admin.firestore();
    const baseUrl = `https://${REGION}-${process.env.GCLOUD_PROJECT}.cloudfunctions.net/fetchLawApi`;

    const log = await runPipeline({ baseUrl, db });
    logger.info('runAmendmentPipeline 완료', log);
  }
);

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

function sendError(res, status, message) {
  return res.status(status).json({
    ok: false,
    error: { status, message },
  });
}
