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
PRD 부록의 "현재(2026-07-26 기준) 감지된 시행예정 개정 5건"이 그대로 검출되는지 검증한다:

```bash
npm run detect:selftest
```

**응답 필드명에 대한 주의**: `eflaw` 응답의 실제 필드명(`법령ID`, `공포번호`, `공포일자`, `시행일자` 등)은
`functions/lib/detectPendingAmendments.js`의 `pick()` 후보 목록에 있는 이름을 기준으로 가정한 것이다.
실제 배포 환경에서 처음 실행할 때는 `logRaw` 옵션(스크립트 실행 시 기본 활성화)으로 원본 응답 구조가
콘솔에 함께 출력되므로, 필드명이 다르면 `functions/lib/detectPendingAmendments.js`의 후보 목록을
바로 확인해 보정할 수 있다.
