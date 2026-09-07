# hariesse — 인수인계 (2026-07-20)

새 세션에서 이 프로젝트를 이어받기 위한 문서.

> ✅ **2026-07-20 배포 완료 + E2E 성공.** §4의 배포 절차는 전부 실행됐다.
> 실제 파이프라인 1회 실행으로 Telegram 다이제스트 전송 + Notion 8건 아카이브 확인.
> 배포 중 수정한 것 (아래 §8 함정 메모에도 반영):
> - SSM `/hariesse/telegram-chat-id`: 봇 자신의 ID(8657904581)로 잘못 들어가 있어 403 발생 → 실제 대화방 ID `8500033546`으로 교체.
> - SSM `/hariesse/bedrock-model-id`: 기본값 `apac.claude-sonnet-4`가 Legacy 접근 거부 → `global.anthropic.claude-sonnet-4-5-20250929-v1:0`으로 설정.
> - 주의: `config.ts`가 SSM을 콜드스타트에 캐시하므로, SSM 값 변경 후에는 Lambda 설정을 건드려 콜드스타트를 강제해야 반영된다.
>
> **다음 할 일은 §7 로드맵의 "다음 증분"(Feedback Lambda + Telegram 버튼)이다.**

> ✅ **2026-07-20 Feedback 증분도 배포·E2E 검증 완료.**
> - `HariesseApi` 스택: Feedback Lambda + Function URL. Telegram webhook 등록됨
>   (secret_token = Secrets `hariesse/telegram-webhook-secret`, allowed_updates=callback_query).
> - 다이제스트 항목마다 버튼 4개. 액션 효과는 `src/domain/feedback.ts` 참조
>   (like: 별표+liked+weight+0.1+Profile 태그 누적 / site: weight+0.25 / save: nadeliv 체크 / skip: 스킵+weight-0.1, weight 클램프 [0.1, 3.0]).
> - idempotency: Article에 `${action}FeedbackAt` 마커 + 조건부 update. E2E로 검증됨
>   (401 인증, like 반영, 중복 무시, Notion 상태=별표 전파 확인).
> - **다음 할 일은 Phase 2 개인화** — Sources 가중치를 스코어링에 실제 반영, `isNovel` 하드코딩 교체.

> 🆕 **비서 Phase A(브리핑) + Phase B(웹 UI) 구현 완료 — 아직 미배포.**
> 주간 반복 루틴을 등록해 두면 **09:00 / 12:00 / 20:00 KST** Telegram 브리핑으로 온다.
> 항목마다 `[✅ 체크][⏭ 건너뛰기]` 버튼 → 기존 Feedback webhook이 상태를 바꾸고 메시지를 즉시 다시 그린다.
> - 새 스택 `HariesseAssistant`(Brief Lambda + EventBridge 3개), 새 테이블 `Tasks`(pk/sk).
> - 설계·로드맵 전체(웹 UI, Google Calendar, 자연어 등록)는 **[docs/ASSISTANT.md](./docs/ASSISTANT.md)**.
> - **웹 UI**: CloudFront 배포 하나에 SPA(S3+OAC)와 API(Lambda Function URL+OAC)를 함께.
>   Google 로그인(허용 이메일 1개), 오늘 화면 체크, 주간 루틴 편집.
>   새 스택 `HariesseWeb`, 프론트는 `web/`(Vite+React).
> - 배포 절차는 아래 §4.1(브리핑) / §4.2(웹).

---

## 1. 프로젝트가 뭔가

개인용 서버리스 **콘텐츠 큐레이션 에이전트 `hariesse`**.
매일 인터넷에서 (1) 여행 블로그 글, (2) 개발·AI·클라우드 지식 글을 자동 수집·요약·큐레이션해서
**Telegram으로 다이제스트 푸시** + **Notion DB에 영구 아카이브**한다.

핵심 가치:
- 여행 콘텐츠 → 블로그(nadeliv.com) **글감 수집**
- 개발/AI 콘텐츠 → "개발자와 대화하며 새 지식 얻던 경험"의 AI 대체
- **좋아요 피드백으로 점점 개인화되는 학습 루프**가 이 시스템의 정체성

---

## 2. 확정된 결정 (그리고 이유)

| 결정 | 내용 | 이유 |
|---|---|---|
| 이름 | **hariesse** (원래 "My Secretary") | 사용자 요청. 코드·SSM·Secrets·Notion DB명 전부 반영 완료 |
| 알림 채널 | **Telegram** (Slack 아님) | Slack도 검토했으나, 1인용 MVP엔 봇·버튼·webhook 설정이 압도적으로 간단. Slack의 이점은 "하루 종일 거기 있다"뿐인데 결정적이지 않다고 판단 |
| IaC | **AWS CDK (TypeScript)** | 스펙 기본값 |
| 리전 | **ap-northeast-2 (서울)** | 전 리소스 동일 리전 |
| Bedrock 모델 | 기본 `apac.anthropic.claude-sonnet-4-20250514-v1:0` | 서울 ACTIVE 확인됨. SSM으로 교체 가능 |
| 빌드 방식 | **워킹 스켈레톤 먼저** | 스펙의 "단계적 빌드" 원칙. 한 줄기를 끝까지 동작시킨 뒤 확장 |

---

## 3. 현재 상태 — ✅ 코드 완성 + 검증 끝, ❌ 미배포

### 완료된 것

**코드** (`/Users/zayeonic/Projects/haries-work/hariesse`)
- `Collection → Curation → Delivery` 파이프라인 전체 구현
- `tsc --noEmit` 통과 / 단위테스트 **15개 전부 통과** / 양쪽 스택 `cdk synth` 성공
- Lambda 번들링 검증 완료 (jsdom을 `nodeModules`로 설치해 esbuild 이슈 회피 — **가장 위험했던 부분**)

**Notion**
- DB **"hariesse Archive"** 생성 완료, 스펙의 10개 속성 전부 반영

**시크릿·설정 — 실제 API 호출로 검증 완료**
| 검증 항목 | 결과 |
|---|---|
| Telegram 봇 | ✅ `@haries_work_bot` |
| chat_id `8657904581` | ✅ 유효 (private) |
| Notion 읽기 | ✅ HTTP 200 |
| Notion **쓰기** | ✅ create + archive 성공 |
| 속성 스키마 매핑 | ✅ `notion.ts`의 10개 속성 전부 통과 |
| Bedrock 서울 모델 | ✅ ACTIVE |

> 검증 중 만든 테스트 row는 archive 처리해서 DB는 깨끗함.

**작업 중 발견·수정한 버그**
- `src/domain/scoring.ts`: 탐험(explore) 슬롯이 `isNovel` 우선순위를 무시하고 점수로 재정렬되던 버그.
  `pickDiverse()`가 **caller의 우선순위 순서를 보존**하도록 수정. 테스트로 회귀 방지됨.

### 안 된 것
- ❌ `cdk bootstrap` / `cdk deploy` — **한 번도 실행 안 함. AWS에 리소스 없음**
- ❌ 시드 데이터 적재
- ❌ 파이프라인 실제 1회 실행

---

## 4. 다음 세션에서 할 일 (그대로 실행)

```bash
cd /Users/zayeonic/Projects/haries-work/hariesse

# 1. 부트스트랩 (계정/리전 최초 1회)
npx cdk bootstrap aws://611288736262/ap-northeast-2

# 2. 배포 — DynamoDB 3개, S3, Lambda 3개, Step Functions, EventBridge
npx cdk deploy --all

# 3. 출력된 테이블 이름으로 시드 적재 (소스 3개 + 초기 Profile)
SOURCES_TABLE=<HariesseData 출력값> \
PROFILE_TABLE=<HariesseData 출력값> \
AWS_REGION=ap-northeast-2 npm run seed

# 4. 상태머신 수동 1회 실행
aws stepfunctions start-execution \
  --state-machine-arn <HariessePipeline 출력 StateMachineArn> \
  --region ap-northeast-2
```

**완료 기준**: Telegram에 다이제스트 도착 + Notion DB에 row 생성.
실패 시 CloudWatch Logs에서 `CollectFn` / `CurateFn` / `DeliverFn` 로그 확인.

### 4.1 비서(할일 브리핑) 배포 — Phase A

```bash
npm test && npm run build && npx cdk deploy --all   # HariesseAssistant + Tasks 테이블 추가됨

# 주간 루틴 적재 (scripts/seed-routines.ts의 ROUTINES를 고쳐 재실행하면 upsert)
TASKS_TABLE=<HariesseData 출력 TasksTableName> AWS_REGION=ap-northeast-2 npm run seed:routines

# 브리핑 수동 1회 — slot: morning | midday | evening
aws lambda invoke --function-name <HariesseAssistant 출력 BriefFunctionName> \
  --cli-binary-format raw-in-base64-out --payload '{"slot":"morning"}' \
  --region ap-northeast-2 /dev/stdout
```

**완료 기준**: 브리핑 메시지 도착 → `[✅]` 버튼 클릭 → 토스트가 뜨고 **메시지가 그 자리에서 갱신**.
다시 누르면 되돌아온다. 새 시크릿/SSM은 필요 없다 (기존 텔레그램 토큰·chat-id·webhook secret 재사용).

> ⚠️ Function URL webhook은 이미 등록돼 있어 재등록이 필요 없다 — 할일 버튼도 같은 webhook으로 들어온다.
> 다만 FeedbackFn이 새 코드/환경변수(TASKS_TABLE)를 받으려면 이번 배포가 반드시 포함돼야 한다.

### 4.2 웹 UI 배포 — Phase B

**전제: Google Cloud OAuth 클라이언트 1개** (최초 1회).

1. Google Cloud Console → 새 프로젝트 → **OAuth 동의 화면**
   - User type `외부`, 게시하지 않아도 됨. **테스트 사용자에 본인 Gmail 추가**.
2. **사용자 인증 정보 → OAuth 클라이언트 ID → 웹 애플리케이션** 생성.
   승인된 리디렉션 URI는 아래 (4)에서 받는 값으로 나중에 채운다.
3. 시크릿·파라미터 넣기
   ```bash
   R=ap-northeast-2
   aws secretsmanager create-secret --name hariesse/google-oauth --region $R \
     --secret-string '{"clientId":"…apps.googleusercontent.com","clientSecret":"…"}'
   aws secretsmanager create-secret --name hariesse/session-secret --region $R \
     --secret-string "$(openssl rand -base64 48)"
   aws ssm put-parameter --name /hariesse/allowed-email --type String --region $R \
     --value 'bongjoonkim96@gmail.com'      # 비어 있으면 아무도 로그인 못 한다 (fail-closed)
   ```
4. 배포 — 웹 빌드까지 한 번에
   ```bash
   npm run deploy      # = npm run build:web && cdk deploy --all
   ```
   출력에서 **`HariesseWeb.WebUrl`** 과 **`HariesseWeb.RedirectUri`** 를 받는다.
5. 두 곳에 꽂는다
   - `RedirectUri` → Google Console의 **승인된 리디렉션 URI**에 그대로 등록
   - `WebUrl` → SSM에 저장
     ```bash
     aws ssm put-parameter --name /hariesse/web-origin --type String --overwrite \
       --region ap-northeast-2 --value 'https://dxxxxxxxx.cloudfront.net'
     ```
6. **`WebApiFn` 콜드스타트 강제** — `config.ts`가 SSM을 콜드스타트에 캐시하므로,
   `web-origin`을 넣은 뒤 Lambda 설정을 건드리거나 재배포해야 반영된다.

**완료 기준**: `WebUrl` 접속 → "Google로 로그인" → 본인 계정으로 들어와
주간 루틴을 등록하면, 그날 할일이 **오늘 탭**과 **텔레그램 브리핑** 양쪽에 같이 뜬다.

> 프론트만 고칠 때는 `npm run dev:web` (Vite dev 서버). `/api`는 `HARIESSE_API` 환경변수로
> 프록시할 수 있지만, 인증이 CloudFront 도메인 쿠키에 묶여 있어 실질적으로는 배포해서 확인하는 게 빠르다.

> ⚠️ **리전 주의.** `bin/app.ts`가 `process.env.CDK_DEFAULT_REGION ?? 'ap-northeast-2'`라
> 셸의 AWS 설정이 다른 리전을 가리키면 **거기에 스택이 통째로 생긴다**
> (이 저장소를 자격증명 없이 synth하면 실제로 us-east-1로 잡힌다).
> 배포 전 `aws configure get region` 확인하거나 `AWS_REGION=ap-northeast-2 npm run deploy`로 못박을 것.

> 배포는 비용이 발생한다. 개인 사용 수준이면 월 몇 달러 안쪽 (DynamoDB on-demand + Lambda 소액 + Bedrock 호출당). 최대 변수는 Bedrock이고 일일 캡 50회가 걸려 있다.

---

## 5. 주요 식별자 / 경로

| 항목 | 값 |
|---|---|
| 작업 디렉토리 | `/Users/zayeonic/Projects/haries-work/hariesse` |
| AWS 계정 / 리전 | `611288736262` / `ap-northeast-2` (IAM user `nadeliv_adm`) |
| CDK 스택 | `HariesseData`, `HariessePipeline`, `HariesseApi`, `HariesseAssistant`, `HariesseWeb` |
| Notion 부모 페이지 | "My secretary" `38de549ed10280e6af9be92c7a6bfb3f` |
| Notion DB | "hariesse Archive" `a22cbf53637840dc867d6cd8e7b2614e` |
| Telegram 봇 | `@haries_work_bot`, chat_id `8657904581` |
| Secrets Manager | `hariesse/telegram-bot-token`, `hariesse/notion-token`, `hariesse/telegram-webhook-secret`, `hariesse/google-oauth`, `hariesse/session-secret` |
| SSM (설정됨) | `/hariesse/telegram-chat-id`, `/hariesse/notion-database-id` |
| SSM (미설정, 코드 기본값 사용) | `bedrock-model-id`, `bedrock-region`, `exploration-ratio`, `daily-bedrock-cap`, `daily-curate-cap`, `digest-size` |
| 스케줄 (콘텐츠) | 매일 **07:00 KST** (= 22:00 UTC) |
| 스케줄 (브리핑) | 매일 **09:00 / 12:00 / 20:00 KST** (= 00 / 03 / 11 UTC) |

시드 소스 3개: AWS Architecture Blog(cloud), 우아한형제들(dev-ai), 토스(dev-ai).

> ⚠️ 이 디렉토리는 **git 저장소가 아니다.** 배포 전에 `git init` 하는 걸 권장.

---

## 6. 유지해야 할 설계 원칙

1. **탐험 vs 활용** — 매 다이제스트를 활용 ~70% / 탐험 ~30%로 나눈다 (`EXPLORATION_RATIO`, 기본 0.3).
   좋아요 가중치만 키우면 에코챔버가 된다. **이 분배를 함부로 0으로 만들지 말 것.**
2. **콜드 스타트 부트스트랩** — 초기 관심사 시드: `PQC, 서버리스, LLM, React, 국내여행, 해외여행`.
3. **AI 의견 가미** — 단순 패턴매칭이 아니라 "취향엔 안 맞지만 알 가치가 있는지"까지 판단해 `aiOpinion`에 담는다.
4. **단계적 빌드** — 각 Phase가 독립적으로 가치를 갖게. 중간에 멈춰도 동작해야 한다.
5. **Lambda 15분 제약** — 긴 루프를 단일 Lambda에 넣지 않는다. Step Functions로 쪼갠다.

### 가드레일 (이미 구현됨)
- dedup/idempotency: `articleId = hashUrl(url)`, 조건부 put, Notion은 URL 기준 upsert
- 일일 상한: 신규 글 ≤ `dailyCurateCap`, Bedrock 호출 ≤ `dailyBedrockCap`
- Articles TTL 30일, Lambda `reservedConcurrentExecutions: 2`, DynamoDB on-demand
- 시크릿은 코드/리포에 없음 — Secrets Manager + SSM에서만 읽음

---

## 7. 이후 로드맵

### 다음 증분 (Phase 1 나머지)
- **API 스택 + Telegram webhook + Feedback Lambda**
- 다이제스트에 **인라인 버튼** 부착: `[👍 좋아요] [⭐ 사이트 좋아요] [💾 nadeliv 글감] [⏭ 건너뛰기]`
- 버튼 → Sources 가중치 ±, Profile 시그널, Notion 상태 갱신 (idempotent 처리 필수)

> 현재 스켈레톤은 **버튼 없이 텍스트+링크만** 보낸다. 핸들러가 없는 버튼은 클릭 시 멈춘 것처럼 보여서 일부러 뺐다.

### Phase 2 — 개인화
- Sources 가중치 학습 루프, Profile 패턴 학습, 탐험/활용 슬롯 실제 반영
- `deliver/index.ts`의 `isNovel: false` 하드코딩을 실제 신호(candidate 소스/미노출 도메인)로 교체

### 비서 트랙 (docs/ASSISTANT.md)
- **Phase A ✅** 루틴 → 하루 3회 브리핑 → 버튼 체크 (구현 완료, 미배포)
- **Phase B ✅** 웹 관리 UI — S3+CloudFront 한 배포에 `/api/*`까지, Google OAuth 직접 (구현 완료, 미배포)
- **Phase C** Google Calendar — 읽기는 Google→hariesse, 쓰기는 루틴만 전용 캘린더로
- **Phase D** 자연어 등록("매주 화 8시 헬스"), 저녁 회고 코멘트, 주간 리포트

### Phase 3 — 발견·고도화
- 신규 사이트 자동 발견(Discovery) + candidate 시범 노출
- `layoutType` 분석, AI 의견 프롬프트 고도화
- YouTube/arXiv/HackerNews/Reddit 소스 확장

---

## 8. 함정 메모

- **Notion 403/object_not_found** → 토큰 문제가 아니라 페이지에 integration을 **Connections로 연결 안 한 것**이 1위 원인. (이번엔 연결 완료됨)
- **jsdom 번들링** → esbuild로 직접 번들하면 깨진다. `NodejsFunction`의 `nodeModules`로 설치하는 방식 유지할 것. `package-lock.json`이 있어야 동작.
- **Bedrock 모델 ID** → 서울은 교차리전 추론 프로파일(`apac.*` / `global.*`) 사용. 비용 절감하려면
  `global.anthropic.claude-haiku-4-5-20251001-v1:0`, 품질 우선이면 `global.anthropic.claude-sonnet-4-5-20250929-v1:0`로 SSM 덮어쓰기.
- **macOS 셸** → `head -n -1` 같은 GNU 전용 옵션 안 먹는다.
- **EventBridge cron은 UTC** → KST 09/12/20시는 UTC 00/03/11시. 한국은 서머타임이 없어 고정 -9시간 환산이면 정확하다.
  `SLOT_HOUR_KST`(`src/domain/routine.ts`)가 단일 출처라 시간을 바꾸면 스택이 따라간다.
- **CloudFront `errorResponses`는 배포 전체에 걸린다** → SPA 폴백으로 쓰면 API의 404까지
  index.html(200)로 바뀐다. 기본 behavior에만 붙는 뷰어 CloudFront Function으로 처리했다.
- **`/hariesse/web-origin`은 배포 후에만 알 수 있다** (CloudFront 도메인). 닭-달걀이라
  §4.2처럼 배포 → SSM 기입 → 콜드스타트 순서를 지켜야 로그인이 된다.
- **`Tasks` 테이블은 RemovalPolicy.RETAIN** → 직접 등록한 루틴은 스택을 지워도 남는다.
  스택을 지웠다 다시 만들면 같은 이름의 테이블이 남아 있어 배포가 실패할 수 있다.
