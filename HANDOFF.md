# hariesse — 인수인계 (2026-07-20)

새 세션에서 이 프로젝트를 이어받기 위한 문서. **다음 할 일은 "배포"** 한 가지다.

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

> 배포는 비용이 발생한다. 개인 사용 수준이면 월 몇 달러 안쪽 (DynamoDB on-demand + Lambda 소액 + Bedrock 호출당). 최대 변수는 Bedrock이고 일일 캡 50회가 걸려 있다.

---

## 5. 주요 식별자 / 경로

| 항목 | 값 |
|---|---|
| 작업 디렉토리 | `/Users/zayeonic/Projects/haries-work/hariesse` |
| AWS 계정 / 리전 | `611288736262` / `ap-northeast-2` (IAM user `nadeliv_adm`) |
| CDK 스택 | `HariesseData`, `HariessePipeline` |
| Notion 부모 페이지 | "My secretary" `38de549ed10280e6af9be92c7a6bfb3f` |
| Notion DB | "hariesse Archive" `a22cbf53637840dc867d6cd8e7b2614e` |
| Telegram 봇 | `@haries_work_bot`, chat_id `8657904581` |
| Secrets Manager | `hariesse/telegram-bot-token`, `hariesse/notion-token` |
| SSM (설정됨) | `/hariesse/telegram-chat-id`, `/hariesse/notion-database-id` |
| SSM (미설정, 코드 기본값 사용) | `bedrock-model-id`, `bedrock-region`, `exploration-ratio`, `daily-bedrock-cap`, `daily-curate-cap`, `digest-size` |
| 스케줄 | 매일 **07:00 KST** (= 22:00 UTC) |

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
