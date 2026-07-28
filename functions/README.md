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

전체 파이프라인(STEP 2 탐지 → STEP 3 저장 → STEP 4 변경 조문 추출)을 이어서 실행:

```bash
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
node scripts/detectAndSave.js "http://127.0.0.1:5001/<project-id>/asia-northeast3/fetchLawApi"
```
