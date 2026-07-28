# 개정 예정 법령 검토 파이프라인

법령 감지(law.go.kr) → Firestore 저장 → 변경 조문 추출 → 시행 전/후 본문 조회 →
Gemini 실무 영향 요약까지 이어지는 파이프라인. **Cloud Function을 쓰지 않고 GitHub
Actions에서 직접 실행**하므로 Firebase는 Firestore(무료 Spark 요금제)만 있으면 된다.

## 왜 Cloud Function이 없나

Firebase Spark(무료) 플랜의 Cloud Functions는 트리거 종류(HTTP든 스케줄이든)와 무관하게
구글 소유 API 외의 외부 네트워크(law.go.kr 등)에 접근할 수 없다. 이 제약을 피하려고
law.go.kr·Gemini 호출과 Firestore 쓰기를 전부 **GitHub Actions**(무제한 아웃바운드,
매일 cron + 수동 실행 가능)로 옮겼다. Firebase는 Firestore(그리고 이후 STEP 8/9의
Hosting)만 담당하며 Spark로 충분하다.

## 아키텍처

```
GitHub Actions (cron 매일 03:00 KST 또는 수동 "Run workflow")
  └─ scripts/runPipelineOnce.js
       ├─ law.go.kr 직접 호출 (OC 키는 GitHub Secrets)
       ├─ Gemini API 직접 호출 (API 키는 GitHub Secrets)
       └─ Firestore 쓰기 (서비스 계정 키는 GitHub Secrets)

Firebase Firestore (Spark) ← pendingAmendments, batchLogs 컬렉션
Firebase Hosting (Spark, STEP 8/9에서 추가) → 대시보드가 Firestore를 읽어서 보여줌
```

대시보드의 "새로고침" 버튼은 **Firestore를 다시 읽기만** 한다 — 파이프라인을 즉시
재실행하지는 않는다. 지금 당장 다시 실행하고 싶으면 GitHub 저장소의 Actions 탭에서
이 워크플로를 수동으로 "Run workflow" 하면 된다.

## 준비

```bash
cd functions
npm install
```

Firebase 프로젝트가 아직 없다면(Firestore 전용, Blaze 불필요):
1. https://console.firebase.google.com 에서 프로젝트 생성
2. Firestore Database 활성화 (Native 모드)

## 키 3종 발급

| 키 | 발급처 | 용도 |
|---|---|---|
| `LAW_OC` | https://open.law.go.kr 회원가입 후 Open API 활용신청. 값은 가입 이메일의 아이디 부분(예: `hong123@gmail.com` → `hong123`) | law.go.kr 호출 인증 |
| `GEMINI_API_KEY` | https://aistudio.google.com → "Get API key" (무료) | 실무 영향 요약(STEP 6) |
| `FIREBASE_SERVICE_ACCOUNT_KEY` | GCP 콘솔 → IAM 및 관리자 → 서비스 계정 → Firebase 프로젝트의 기본 `firebase-adminsdk-...` 계정 선택 → 키 → 새 키 만들기(JSON) | GitHub Actions가 Firestore에 쓰기 위한 인증 |

## 로컬에서 테스트하기

```bash
cp .env.example .env
# .env 파일을 열어 LAW_OC, GEMINI_API_KEY 값 채우기
```

`.env`는 `.gitignore`에 포함되어 커밋되지 않는다. Firestore에 실제로 쓰지 않는 STEP 2만
먼저 확인하려면:

```bash
npm run detect
```

Firestore까지 포함해 전체 파이프라인을 로컬에서 돌리려면, Firestore 인증이 필요하다.
`FIREBASE_SERVICE_ACCOUNT_KEY`를 `.env`에 넣거나, 미리 `gcloud auth application-default
login`으로 로그인해 둔다:

```bash
node scripts/detectAndSave.js   # 단계별 상세 로그를 보고 싶을 때
npm run pipeline-once           # GitHub Actions와 완전히 동일한 진입점(scripts/runPipelineOnce.js)
```

## GitHub Actions로 배포하기 (STEP 7)

`.github/workflows/amendment-pipeline.yml`이 매일 03:00(KST)에 자동 실행되고, 저장소의
**Actions 탭 → 이 워크플로 → "Run workflow"**로 언제든 수동 실행도 가능하다(주기를
바꾸려면 워크플로 파일의 `cron` 값만 수정).

1. 저장소 **Settings → Secrets and variables → Actions → New repository secret**에서
   `LAW_OC`, `GEMINI_API_KEY`, `FIREBASE_SERVICE_ACCOUNT_KEY`(서비스 계정 JSON 전체를
   한 줄로) 3개를 각각 등록한다.
2. 워크플로가 실행되면 `scripts/runPipelineOnce.js`가 STEP 2~6을 순서대로 실행하고
   `batchLogs` 컬렉션에 결과를 남긴다. 단계 자체가 통째로 실패하면(예: Firestore 장애)
   워크플로가 실패(빨간 표시)로 끝나므로 Actions 탭에서 바로 알아챌 수 있다.

## 파이프라인 단계별 설명

### STEP 1 — law.go.kr 호출 클라이언트 (`lib/fetchLawApiClient.js`)

`callFetchLawApi(params)`가 `endpoint`(`lawSearch`|`lawService`) + `target` + 나머지
파라미터(`ID`, `MST`, `jo`, `efYd` 등)를 그대로 받아 `OC=process.env.LAW_OC`,
`type=XML`을 붙여 law.go.kr을 직접 호출하고, XML 응답을 JSON으로 변환해 돌려준다
(`parseTagValue:false`로 법령ID·공포번호 등 앞자리 0이 숫자 변환으로 사라지는 걸 막았다).

### STEP 2 — 시행 대기 개정 건 탐지 (`lib/detectPendingAmendments.js`)

PRD 부록의 15개 감시 대상 법령에 대해 `target=eflaw`(시행일 법령 목록)를 조회하고,
시행일자가 오늘 이후인(= 공포됐지만 아직 시행 전인) 건만 추린다. 법령 하나가 조회
실패해도 나머지 14개는 계속 조회된다.

```bash
npm run detect:selftest
```

**응답 필드명에 대한 주의**: 실제 필드명(`법령ID`, `공포번호`, `공포일자`, `시행일자` 등)은
`pick()` 후보 목록을 기준으로 가정한 것이다. 실제 실행 시 `logRaw`로 원본 구조가 콘솔에
함께 출력되므로 다르면 후보 목록을 보정한다.

### STEP 3 — Firestore 저장 + 중복 방지 (`lib/savePendingAmendments.js`)

STEP 2의 결과(같은 개정 건이 시행일자별로 여러 행일 수 있음)를 `법령ID_공포번호` 문서
ID로 다시 묶어(시행예정일은 배열로 병합) `pendingAmendments` 컬렉션에 저장한다. 이미
있는 문서는 스킵(중복 알림 방지). 저장 필드: `법령ID`, `법령명`, `MST`, `공포번호`,
`공포일`, `시행예정일`(배열), `감지일시`, `처리상태`(`pending`).

```bash
npm run save:selftest
```

### STEP 4 — 조문별 변경 이력 조회 (`lib/getChangedArticles.js`)

새로 저장된 개정 건마다 "조문별 개정이력"을 조회해서, 조문개정일자가 이번 공포일자와
일치하는 조문만 걸러 `changedArticles`로 저장한다.

**리스크(PRD 9장)**: 이 엔드포인트의 정확한 `target`(현재 `lsJoHstInf`로 추정)과 응답
필드명은 공식 문서로 100% 확정하지 못했다 — `logRaw`로 첫 응답을 확인해 보정 필요.
**추가로 확인된 리스크**: 이 계열 이력 API가 이미 시행된 변경만 색인하고, 아직 시행되지
않은 신설 조문(부칙상 미래 시행일)은 색인에 없을 수 있다는 것을 조사 중 발견했다. 실제
운영 중 신설 조문이 `changedArticles`에서 빠지는지 확인이 필요하다.

```bash
npm run articles:selftest
```

### STEP 5 — 변경 조문 시행 전/후 본문 조회 (`lib/getArticleDiffs.js`, `lib/getCurrentMst.js`)

변경 조문마다 현행본(법령ID의 **현재** MST, efYd 없이)과 개정본(그 개정 건 **고유**
MST + efYd)을 각각 조회해 `articleDiffs`로 저장한다.

**MST를 두 개 쓴다 (PRD 문구와 다른 부분)**: PRD 원문은 "동일한 MST에 efYd만 붙여서
조회"라고 되어 있지만, 실측 결과 다른 경우가 있었다 — 산업안전보건법 2026-02-19 공포
건은 현재 MST(287805)가 아니라 별도 MST(283449)로 시행예정본을 조회해야 했다.

**알려진 단순화**: 한 개정 건에 시행예정일이 여러 개면(부칙상 조문별로 다른 경우)
모든 변경 조문에 가장 빠른 날짜 하나만 적용한다.

```bash
npm run diffs:selftest
npm run diffs-update:selftest
```

### STEP 6 — 실무 영향 요약 (`lib/summarizeArticleImpact.js`, Gemini API 무료 모델)

`articleDiffs`를 조문별로 Gemini에 넘겨 3~5문장 실무 영향 요약(+ 준비 액션)을 받아
`summary` 필드(배열)에 저장하고 처리상태를 `summarized`로 바꾼다.

**PRD 원안(Claude API)에서 변경**: 비용 문제로 Google AI Studio의 **무료 티어** Gemini를
쓴다. 기본 모델 `gemini-2.0-flash`, 다른 무료 모델로 바꾸려면 `GEMINI_MODEL` 환경변수만
바꾸면 된다. 조문 하나의 요약이 실패해도 나머지는 계속 처리되고, 실패건은 `error`와
함께 배열에 남는다.

```bash
npm run summarize:selftest
npm run summarize-update:selftest
```

### STEP 7 — GitHub Actions로 매일/수동 실행 (`lib/runPipeline.js`, `.github/workflows/amendment-pipeline.yml`)

`runPipeline(db)`가 STEP 2~6을 순서대로 실행한다. 법령/개정건/조문 단위 실패는 이미
각 STEP의 lib 모듈 안에서 처리되어(한 건이 실패해도 나머지는 계속) 있고, `runPipeline`은
그 위에서 "단계 자체"가 통째로 실패하는 경우(예: Firestore 장애)까지 잡아, 무슨 일이
있어도 `batchLogs`에 시작/종료 시각과 단계별 성공·실패 건수를 남긴다.

```bash
npm run pipeline:selftest
```

## 전체 자체 테스트

```bash
npm run selftest
```
