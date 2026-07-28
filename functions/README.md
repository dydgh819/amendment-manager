# fetchLawApi — Open API 프록시 Cloud Function

open.law.go.kr(국가법령정보 공동활용 Open API)을 서버 측에서 대신 호출하는 HTTP 함수.
OC 인증키를 프론트엔드에 노출하지 않고, CORS 문제를 우회하기 위한 프록시 역할을 한다.

## 준비

```bash
cd functions
npm install
```

Firebase 프로젝트가 아직 연결되지 않았다면 저장소 루트에서:

```bash
firebase login
firebase use --add   # 실제 Firebase 프로젝트 ID 선택/입력
```

## OC 키 설정

**운영 배포용 (Secret Manager, 권장)**

```bash
firebase functions:secrets:set LAW_OC
```

**로컬 에뮬레이터 테스트용**

```bash
cp .env.example .secret.local
# .secret.local 파일을 열어 LAW_OC=실제발급키 로 값 채우기
```

`.env`, `.secret.local` 은 `.gitignore`에 포함되어 커밋되지 않는다.

## 로컬 실행

```bash
npm run serve
# 또는: firebase emulators:start --only functions
```

## 호출 예시

```bash
# 시행일 법령 목록 조회 (target=eflaw)
curl "http://localhost:5001/<project-id>/asia-northeast3/fetchLawApi?endpoint=lawSearch&target=eflaw&ID=001766"

# 법령 본문 조회 (jo 파라미터, 시행예정일 지정)
curl "http://localhost:5001/<project-id>/asia-northeast3/fetchLawApi?endpoint=lawService&target=eflaw&MST=287805&jo=003800&efYd=20260801"
```

응답 형식:

```json
{ "ok": true, "data": { /* XML을 JSON으로 변환한 결과 */ } }
```

오류 시:

```json
{ "ok": false, "error": { "status": 400, "message": "target 파라미터는 필수입니다. (예: eflaw)" } }
```

## 배포

```bash
firebase deploy --only functions
```

## 파라미터

| 이름 | 필수 | 설명 |
|---|---|---|
| `endpoint` | 아니오 (기본 `lawSearch`) | `lawSearch` 또는 `lawService` 중 선택 — 각각 `DRF/lawSearch.do`, `DRF/lawService.do`로 전달 |
| `target` | 예 | Open API의 target 파라미터 (예: `eflaw`) |
| 기타 | 대상별로 다름 | `ID`, `MST`, `jo`, `efYd` 등 Open API가 요구하는 파라미터를 그대로 전달하면 된다 |

`OC`, `type` 파라미터는 클라이언트가 보내도 무시되며, 서버가 항상 발급키와 `type=XML`로 고정해 상위 API를 호출한 뒤 JSON으로 변환해 응답한다.

## STEP 2 — 시행 대기 개정 건 탐지 스크립트

`fetchLawApi`를 이용해 PRD 부록의 15개 감시 대상 법령에 대해 `target=eflaw`(시행일 법령 목록)를
조회하고, 시행일자가 오늘 이후인(= 공포됐지만 아직 시행 전인) 건만 추려서 콘솔에 출력한다.
이 단계에서는 Firestore 저장은 하지 않는다 (STEP 3에서 추가).

```bash
# 에뮬레이터 또는 배포된 함수 URL을 넘겨서 실행
node scripts/detectPendingAmendments.js "http://127.0.0.1:5001/<project-id>/asia-northeast3/fetchLawApi"

# 또는 환경변수로
FETCH_LAW_API_URL="https://<region>-<project-id>.cloudfunctions.net/fetchLawApi" npm run detect
```

실제 네트워크/OC 키 없이 파싱·필터링 로직만 검증하려면 목업 응답을 쓰는 자체 테스트를 실행한다.
PRD 부록의 "현재(2026-07-26 기준) 감지된 시행예정 개정 5건"이 그대로 검출되는지 검증한다
(산업안전보건법 21374건은 부칙상 시행일자가 2개라 행으로는 6개가 나온다):

```bash
npm run detect:selftest
```

**응답 필드명에 대한 주의**: `eflaw` 응답의 실제 필드명(`법령ID`, `공포번호`, `공포일자`, `시행일자` 등)은
`functions/lib/detectPendingAmendments.js`의 `pick()` 후보 목록에 있는 이름을 기준으로 가정한 것이다.
실제 배포 환경에서 처음 실행할 때는 `logRaw` 옵션(스크립트 실행 시 기본 활성화)으로 원본 응답 구조가
콘솔에 함께 출력되므로, 필드명이 다르면 `functions/lib/detectPendingAmendments.js`의 후보 목록을
바로 확인해 보정할 수 있다.

## STEP 3 — Firestore 저장 + 중복 방지

STEP 2의 탐지 결과(행 단위, 시행일자가 여러 개면 같은 공포번호가 여러 행으로 나뉨)를
`pendingAmendments` 컬렉션에 저장한다. 저장 전에 `법령ID_공포번호`를 문서 ID로 삼아
다시 묶어서, 같은 개정 건은 문서 하나가 되도록 하고(시행예정일은 배열로 병합),
이미 존재하는 문서는 건드리지 않고 스킵한다(중복 알림 방지).

저장 필드: `법령ID`, `법령명`, `공포번호`, `공포일`, `시행예정일`(배열), `감지일시`(서버 타임스탬프),
`처리상태`(신규 저장 시 `pending`).

```bash
# 에뮬레이터: 별도 터미널에서 Firestore 에뮬레이터를 띄운 뒤
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
node scripts/detectAndSave.js "http://127.0.0.1:5001/<project-id>/asia-northeast3/fetchLawApi"

# 실 프로젝트: 서비스 계정 키로 인증
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
FETCH_LAW_API_URL="https://<region>-<project-id>.cloudfunctions.net/fetchLawApi" npm run detect-and-save
```

Firestore 없이 그룹핑·중복 방지 로직만 검증하려면(메모리 기반 가짜 Firestore 사용):

```bash
npm run save:selftest
```

이 자체 테스트는 6행짜리 목업 결과를 넣었을 때 정확히 5개 문서로 묶이는지, 재실행 시 기존
5건이 스킵되는지, 새 개정 건이 섞였을 때 그 1건만 추가로 저장되는지를 확인한다.

## STEP 4 — 조문별 변경 이력 조회 (변경 조문 번호 추출)

STEP 3에서 새로 저장된 개정 건(법령ID + 공포일자)마다 "조문별 개정이력"을 조회해서,
이번 개정으로 실제 바뀐 조문 번호만 추출해 `changedArticles` 필드로 문서에 업데이트한다.
`node scripts/detectAndSave.js`를 실행하면 STEP 2~4가 이어서 자동으로 수행된다.

**리스크 (PRD 9장 그대로 유효)**: 이 엔드포인트의 정확한 `target` 파라미터명과 응답
필드명은 국가법령정보 Open API 공식 문서에서 100% 확정하지 못했다. `functions/lib/getChangedArticles.js`의
`ARTICLE_HISTORY_TARGET`(현재 `lsJoHstInf`로 추정)과 `pick()` 후보 목록이 실제 응답과 다르면
보정이 필요하다 — 실제 실행 시 `logRaw`로 첫 응답의 원본 구조가 콘솔에 함께 출력된다.

다만 필터링 로직(조문개정일자가 이번 개정의 공포일자와 일치하는 조문만 추출) 자체는, 이 세션에
연결된 `korean-law-mcp`로 실제 산업안전보건법 2026-07-07 공포 건을 조회해 확인한 실제 변경
조문(제31조의2 신설, 제33조·제117조·제175조 일부개정)을 목업으로 재현해 검증했다:

```bash
npm run articles:selftest
```

**추가로 확인된 리스크**: 조사 중 `korean-law-mcp`의 조문별 개정이력 조회에서, 아직 시행되지 않은
신설 조문(제31조의2, 시행예정일 2027-01-08)을 조문번호로 직접 조회하면 "조문 개정 이력이 없습니다"가
나오는 경우를 확인했다. 즉 이 계열의 이력 API가 **이미 시행된 변경만 색인**하고, 아직 시행 전인
신설 조문은 색인에 없을 수 있다. 실제 OC 키로 STEP 4를 처음 돌릴 때, 신설(본조신설) 조문이
`changedArticles`에서 빠지는지 반드시 확인하고, 빠진다면 보완 전략(예: 현행 MST와 개정 MST의
본문을 직접 비교해서 신설 조문을 찾는 방식)이 필요할 수 있다.

전체 파이프라인(STEP 2 탐지 → STEP 3 저장 → STEP 4 변경 조문 추출)을 이어서 실행:

```bash
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
node scripts/detectAndSave.js "http://127.0.0.1:5001/<project-id>/asia-northeast3/fetchLawApi"
```

## STEP 5 — 변경 조문 시행 전/후 본문 조회

STEP 4에서 추출된 `changedArticles`의 조문마다 시행 전(현행) 본문과 시행 후(개정예정) 본문을
각각 조회해서 `articleDiffs` 필드로 저장한다. `node scripts/detectAndSave.js`가 STEP 2~5를 모두
이어서 실행한다.

**MST를 두 개 쓴다 (PRD 문구와 다른 부분)**: PRD 원문은 "동일한 MST에 efYd만 붙여서 조회"라고
되어 있지만, 조사해 보니 실제로는 그렇지 않은 경우가 있었다 — 산업안전보건법 2026-02-19 공포
건(공포번호 21374)은 현재 시행 중인 MST(287805)가 아니라 별도 MST(283449)로 시행예정본을
조회해야 했다(`korean-law-mcp`로 실측). 그래서:
- **현행본**: `functions/lib/getCurrentMst.js`로 법령ID의 현재 MST를 따로 조회 (`target=law`, jo 없음)
- **개정본**: STEP 2/3에서 이미 저장해 둔 그 개정 건 고유의 MST(`법령일련번호`, eflaw 응답에서 추출) + efYd

이 때문에 STEP 2(`detectPendingAmendments.js`)와 STEP 3(`savePendingAmendments.js`)도 함께
수정해서 MST를 추출·저장하도록 보완했다.

**알려진 단순화**: 같은 개정 건(공포번호)에 시행예정일이 여러 개면(부칙상 조문별로 시행일이 다른
경우) 가장 빠른 날짜 하나만 모든 변경 조문에 적용한다. 조문마다 정확한 개별 시행일을 매핑하려면
STEP 4의 조문별 개정이력에서 조문시행일까지 함께 가져와야 하는데, 이번 단계 범위를 벗어나
단순화했다 — 실제 사용 시 이 부분이 정확도에 영향을 줄 수 있음을 유의해야 한다.

조문 본문 API의 응답 필드명(`조문제목`, `조문내용` 등)도 STEP 4와 마찬가지로 확정되지 않아
`pick()` 후보 목록으로 방어했다. 자체 테스트는 실제 본문 텍스트 대신 "올바른 MST·efYd 조합으로
호출되는지"(라우팅)와 Firestore 연동(MST 캐싱, efYd 선택, changedArticles가 빈 건 스킵)을 검증한다:

```bash
npm run diffs:selftest
npm run diffs-update:selftest
```

## STEP 6 — 실무 영향 요약 생성 (Gemini API, 무료 모델)

STEP 5의 `articleDiffs`를 조문별로 LLM에 넘겨 실무 영향을 3~5문장으로 요약하고, 담당자가 시행
전 준비할 액션이 있으면 명시하도록 한다. 결과는 문서의 `summary` 필드(조문별 배열)에 저장하고
처리상태를 `pending` → `summarized`로 바꾼다.

**PRD 원안(Claude API)에서 변경**: 비용 문제로 Claude API 대신 **Google AI Studio의 Gemini API
무료 티어**를 사용한다. 기본 모델은 `gemini-2.0-flash`(무료 티어 대상)이며, 다른 무료 모델로
바꾸려면 코드 수정 없이 `GEMINI_MODEL` 환경변수만 지정하면 된다.

**API 키 준비 (무료)**:
1. https://aistudio.google.com 에서 Google 계정으로 로그인해 API 키를 무료로 발급받는다.
2. 로컬 실행 시: `export GEMINI_API_KEY=발급받은키`
3. Cloud Function으로 배포할 때는(STEP 7) OC 키와 동일하게 Secret Manager로 관리한다:
   `firebase functions:secrets:set GEMINI_API_KEY`

프론트에는 이 키를 절대 넘기지 않는다 — STEP 1의 OC 키와 같은 원칙이다.

```bash
export GEMINI_API_KEY=발급받은키
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
node scripts/detectAndSave.js "http://127.0.0.1:5001/<project-id>/asia-northeast3/fetchLawApi"
```

`GEMINI_API_KEY`가 없으면 `detectAndSave.js`는 STEP 6을 건너뛰고 나머지(STEP 2~5) 결과만
출력한다 — Open API OC 키만 있고 Gemini 키가 아직 없어도 파이프라인 앞단을 계속 확인할 수 있다.

**무료 티어 주의사항**: 무료 티어는 분당 호출 수 제한이 있다. 개정 건이 많거나 조문 수가 많으면
호출이 순차적으로(한 번에 하나씩) 이뤄지도록 이미 구현해 뒀지만, 재시도/백오프 로직은 아직 없다
(PRD상 STEP 10에서 다룰 예정). 조문 하나의 요약이 실패해도 나머지 조문은 계속 처리되고, 실패한
조문은 `summary` 배열에 `error`와 함께 남는다(문서 전체가 막히지 않음).

응답 파싱(`candidates[0].content.parts[0].text`)이 실제 Gemini 응답과 다를 가능성은 낮지만,
차단(`promptFeedback.blockReason`)이나 빈 응답도 에러로 처리한다. 실제 텍스트 검증 없이도 확인
가능한 프롬프트 구성·응답 파싱·Firestore 연동(부분 실패 허용, 빈 articleDiffs 스킵)을 검증한다:

```bash
npm run summarize:selftest
npm run summarize-update:selftest
```
