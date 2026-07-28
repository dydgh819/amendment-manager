'use strict';

// STEP 1에서 만든 fetchLawApi Cloud Function을 호출하는 얇은 클라이언트.
// baseUrl은 로컬 에뮬레이터 주소 또는 배포된 함수 URL을 가리킨다.
async function callFetchLawApi(baseUrl, params) {
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }

  const response = await fetch(url.toString());
  const body = await response.json().catch(() => null);

  if (!response.ok || !body || body.ok === false) {
    const message = body?.error?.message || `HTTP ${response.status}`;
    throw new Error(`fetchLawApi 호출 실패: ${message}`);
  }

  return body.data;
}

module.exports = { callFetchLawApi };
