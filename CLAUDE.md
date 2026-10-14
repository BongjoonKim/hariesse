# hariesse — CLAUDE.md

개인용 서버리스 콘텐츠 큐레이션 에이전트(hariesse). 매일 여행 / 개발·AI·클라우드 콘텐츠를 자동
수집·요약·큐레이션해 **Telegram 다이제스트 푸시 + Notion 아카이브**한다.

> 📌 **세션을 이어받는 중이라면 [HANDOFF.md](./HANDOFF.md)를 먼저 읽을 것.**
> 현재 상태, 검증 결과, 다음 실행할 명령어, 결정 이력이 모두 거기 있다.
> **요약: 2026-07-20 배포 + E2E 검증 완료. Feedback 증분(Telegram 버튼 + ApiStack)도 배포·검증 완료.**
> **2026-09-06 소스 확장 증분: YouTube + Reddit 수집 어댑터 — 배포 완료, 매일 수집 중 (2026-10-04 확인).**
> **2026-09-30 학습 트랙 증분: 매일 20:00 KST 기술 레슨 1건(Telegram + Notion 학습노트) — 2026-10-04 배포·E2E 검증 완료.**
> **2026-10-11 TOEFL 단어장 증분: Telegram/Notion에 적으면 뜻 채우고 매일 21:00 KST 간격 반복 복습 — 2026-10-11 배포 (HANDOFF 맨 위 블록).**
> **운영(소스 추가·상태 확인·설정 조정)은 관리자 웹 없이 Claude Code 세션에서 한다 (2026-10-04 결정, HANDOFF §2).**
> **다음 증분은 Phase 2 개인화(가중치 학습 슬롯 반영, isNovel 실제 신호) — HANDOFF §7 로드맵 참고.**

## ⚠️ 브랜치 / 배포 규칙 (2026-10-14 결정 — 반드시 지킬 것)
Mac과 Windows PC 두 곳에서 작업한다. Claude Code의 세션·메모리(`~/.claude`)·워크트리는 **PC마다 따로라서 공유되지 않는다.**
두 PC가 공유하는 건 **GitHub 리포뿐**이므로, 작업 결과·결정·배포 상태는 전부 리포(코드 + 이 파일 + HANDOFF.md)에 남긴다.

```
작업 브랜치 ──PR──▶ develop ──(모아서) PR──▶ Prod ──push──▶ GitHub Actions가 cdk deploy
```
- **로컬에서 `cdk deploy` 하지 않는다.** 배포는 Prod 머지로만 (`.github/workflows/deploy.yml`).
  로컬 배포를 하면 GitHub에 없는 코드가 AWS에 올라가고, 다음 Prod 배포가 그걸 지운다 (10/11 VocabFn 사례).
- 작업은 `develop`에서 브랜치를 따서 하고, 끝나면 **push + develop으로 PR**. 세션을 끝내기 전에 push 안 된 커밋이 없게 한다.
- 새 기능을 시작하기 전에 `git fetch` 후 `origin/develop` 기준으로 시작한다 (다른 PC 작업을 먼저 받는다).
- 결정·배포 기록은 HANDOFF.md에 커밋한다. 로컬 메모리에만 적으면 다른 PC에서는 모른다.
- 배포 Role: `hariesse-github-deploy` (`infra/github-deploy-role.yaml`, Prod 브랜치에서만 assume 가능). 이 Role만 예외적으로 로컬 `aws cloudformation deploy`.
- 예외: SSM 값 변경·seed·add-source·Lambda 수동 invoke 같은 **운영 작업**은 지금처럼 세션에서 AWS CLI로 한다 (코드 배포가 아니므로).

## 현재 상태: Phase 1 + Feedback + 소스 확장
`Collection → Curation → Delivery → Feedback` 루프가 끝까지 동작.
- 다이제스트 항목마다 인라인 버튼 `[👍 좋아요][⭐ 사이트 좋아요][💾 nadeliv 글감][⏭ 건너뛰기]`
  → Feedback Lambda가 Sources 가중치 ±, Profile 관심사 누적, Notion 상태 갱신 (액션당 1회 idempotent).
- 소스 타입 3종: **blog RSS / YouTube 채널 / Reddit 서브레딧** (`Source.type`, 기본 `blog`).
- **학습 트랙**: 다이제스트와 별개로 매일 20:00 KST에 레슨 1건. 범위는 cloud / backend / frontend / cicd 한정.
  Kubernetes → Jenkins → Node.js → Langflow → React 순으로 트랙을 돌고, 트랙 안에서는 1강부터 순서대로.
  버튼 `[✅ 이해했어요][🔁 쉽게 다시]` — 쉽게 다시 = 다음 회차에 진도를 멈추고 그 레슨을 쉬운 버전으로 재발송.
  전 과정(45레슨)을 다 돌면 같은 목차를 심화 모드로 다시 돈다.
- **TOEFL 단어장**: 봇에 영어 단어·표현·문장을 보내거나 Notion "TOEFL Vocab" DB에 `표현`만 적으면
  Bedrock이 빈 칸(뜻/번역·품사·예문·동의어·TOEFL 팁)을 채운다. 매일 21:00 KST에 복습 퀴즈(뜻은 스포일러)
  `[✅ 알아요][❌ 몰라요]` → Leitner 박스(1·3·7·14·30일). **원본 저장소는 Notion DB** (DynamoDB에 따로 두지 않음).
- **제외(다음 증분)**: Sources 가중치의 스코어링 반영, Profile 패턴학습,
  Discovery 파이프라인, layoutType, arXiv/HN 소스 확장.

## 아키텍처
- **DataStack**: DynamoDB `Sources`/`Articles`/`Profile` + S3(raw 본문).
- **PipelineStack**: Lambda 3개(collect/curate/deliver) + Step Functions(순차) + EventBridge(매일 07:00 KST = 22:00 UTC).
  + LearnFn(학습 레슨) + 별도 EventBridge(매일 20:00 KST = 11:00 UTC). SFN 밖에서 독립 실행.
  + VocabFn(TOEFL 단어장: capture/review) + EventBridge(매일 21:00 KST = 12:00 UTC).
- **ApiStack**: Feedback Lambda + Function URL(Telegram webhook, secret_token 헤더 인증).
  버튼(callback_query) + 메시지(message → VocabFn 비동기 호출). VocabFn은 PipelineStack에 있고 cross-stack으로 넘긴다.
- **LLM**: Amazon Bedrock(Claude), 서울 리전 ap-northeast-2. 모델 ID는 SSM 분리, 교차리전 추론 프로파일(`apac.*`).

## 데이터 흐름
```
EventBridge(매일) → SFN: Collect(소스타입별 fetch+dedup+본문 S3) → Curate(Bedrock 점수/요약/AI의견/태그)
                         → Deliver(활용70/탐험30 → Telegram + Notion upsert)
```

### 소스 타입별 수집 방식 (`src/lib/collectors.ts`)
| 타입 | feedUrl 저장 형태 | 본문 | 다이제스트 링크 |
|---|---|---|---|
| `blog` | RSS URL 그대로 | 원문 페이지 Readability 추출 | 원문 |
| `youtube` | 채널 ID `UC...` | 영상 설명(media:description). **페이지 추출 안 함** | 영상 |
| `reddit` | `r/<sub>` | 링크글=외부 원문 추출 / 자기글=selftext | 링크글은 원문(+`💬 토론` 줄에 스레드) |

## 코드 맵
- `src/lib/config.ts` — SSM/Secrets 로드(콜드스타트 캐시). `getConfig()`, `getSecret()`.
- `src/lib/constants.ts` — ENV 키, SSM 경로, Secrets 이름, 기본값. **값은 두지 않음.**
- `src/lib/dynamo.ts` — 테이블 CRUD + `hashUrl`(articleId/dedup), `hashDomain`(siteId).
- `src/lib/extract.ts` — HTML→본문(`extractReadable` 순수함수, 테스트 대상) + `fetchAndExtract`.
- `src/lib/collectors.ts` — 소스 타입별 수집 어댑터. URL 정규화·항목 파싱은 순수함수(테스트 대상),
  네트워크는 `fetchSourceItems` 하나에만.
- `src/lib/bedrock.ts` — `curateArticle()` 큐레이션 프롬프트 → JSON.
- `src/lib/telegram.ts` / `notion.ts` — 다이제스트 전송(+인라인 버튼) / URL 기준 upsert.
- `src/domain/scoring.ts` — `rankAndSplit()` 활용/탐험 분배(순수함수, 테스트 대상).
- `src/domain/feedback.ts` — callback_data 인코딩/디코딩 + 액션별 효과(순수함수, 테스트 대상).
- `src/domain/curriculum.ts` — 학습 트랙 목차(트랙·레슨·핵심 포인트·공식 문서 링크). **데이터만.**
- `src/domain/learning.ts` — 진도 계산/레슨 버튼/관련 글 선택(순수함수, 테스트 대상).
- `src/domain/vocab.ts` — 단어장 입력 파싱/정규화 키/Leitner 복습/callback(순수함수, 테스트 대상).
- `src/lib/notion-vocab.ts` — "TOEFL Vocab" DB 속성 매핑(`VOCAB_PROP`) + 조회/생성/갱신. 속성 이름 = 스키마.
- `src/handlers/{collect,curate,deliver,feedback,learn,vocab}/index.ts` — Lambda 핸들러.

## 코딩 규칙 / 가드레일
- **dedup·idempotency**: articleId = `hashUrl(url)`. collect는 `putArticleIfNew`(조건부 put), Notion은 URL 기준 upsert.
- **일일 상한**: collect 신규 글 수 ≤ `dailyCurateCap`, curate Bedrock 호출 ≤ `dailyBedrockCap` (SSM).
- **TTL**: Articles `ttl`(기본 30일)로 미독 자동 정리.
- **동시성**: Lambda `reservedConcurrentExecutions: 2`. DynamoDB on-demand.
- **탐험/활용**: 매 다이제스트 explore 비율 = `EXPLORATION_RATIO`(기본 0.3). 에코챔버 방지 — 이 분배를 함부로 0으로 만들지 말 것.
- **순수함수 우선**: 스코어링/추출/피드파싱 로직은 네트워크와 분리해 단위테스트 가능하게.
- **소스 추가는 파괴적이지 않게**: seed/add-source는 `putSourceIfNew`(조건부 put)만 쓴다.
  덮어쓰면 피드백으로 쌓인 `weight`/`likeCount`가 날아간다.
- **Reddit 레이트리밋**: 익명 요청은 금방 429가 나고 한동안 안 풀린다.
  `collectors.ts`의 `REDDIT_POLICY`(간격 20초, 백오프 30s·60s + `x-ratelimit-reset` 헤더 존중)를 줄이지 말 것.
- **학습 레슨 id는 바꾸지 말 것**: 진도·완료 기록이 레슨 id(`k8s-01` 등)로 저장되고 버튼 callback_data에도 들어간다.
  레슨 추가는 트랙 끝에. 참고 링크는 LLM이 만들지 않고 `curriculum.ts`의 공식 문서만 쓴다(지어낸 URL 방지).
- **학습 진도 저장 위치**: Profile 테이블의 `pk='LEARNING'` 아이템. 같은 KST 날짜엔 1번만 발송(`lastSentDate`).
  수동 테스트: `aws lambda invoke --function-name <LearnFunctionName> --payload '{"force":true}' ...`
- **callback_data prefix**: `v1|` = 다이제스트 피드백, `l1|` = 학습 레슨 버튼, `t1|` = TOEFL 단어장(k 알아요 / f 몰라요 / x 삭제 + Notion page id 32자).
- **단어장 메시지는 내 채팅만**: 봇엔 누구나 말을 걸 수 있다. Feedback은 SSM `telegram-chat-id`와 다른 채팅의 message를 버린다.
  webhook `allowed_updates`에 `message`가 있어야 메시지가 온다.
- **단어장 enrich는 빈 칸만 채운다**: 사용자가 Notion에 적은 뜻·예문을 Bedrock 결과로 덮지 말 것 (`fillFromEnrichment`).
- **VocabFn 비동기 재시도 0회**: capture가 재실행되면 같은 표현이 '또 헷갈림'으로 집계된다.
- **SSM GetParameters는 1회 10개까지**: `getConfig()`가 10개씩 나눠 조회한다. SSM 이름을 늘려도 그대로 둘 것.
- **시크릿은 코드/리포에 두지 않음**: Secrets Manager(`hariesse/*`) + SSM(`/hariesse/*`)에서만 읽음.

## 설정값 위치
- SSM `/hariesse/*`: bedrock-model-id, bedrock-region, exploration-ratio, notion-database-id,
  telegram-chat-id, daily-bedrock-cap, daily-curate-cap, digest-size, digest-min-size, digest-min-score,
  vocab-notion-database-id(비면 단어장 꺼짐), vocab-review-size(기본 10).
- 다이제스트 건수: 점수 ≥ `digest-min-score`(기본 70)인 글 수를 [`digest-min-size`(2), `digest-size`(4)]로 클램프.
- Secrets `hariesse/telegram-bot-token`, `hariesse/notion-token`.
- Notion DB ID (생성됨): `a22cbf53637840dc867d6cd8e7b2614e` (봉준 개발목록(구 My secretary) 페이지 하위, DB명 "hariesse Archive").
- TOEFL 단어장 Notion DB: `5582e65c809b45e1b420325db9fc9adb` (같은 페이지 하위, DB명 "TOEFL Vocab").

## 배포 / 검증
```
npm install
npm test                 # scoring + extract 단위테스트
npm run build            # tsc --noEmit 타입체크
npx cdk synth            # 합성 (PR마다 CI가 위 3개를 돌린다: .github/workflows/ci.yml)
# 배포 = develop → Prod PR 머지. 로컬 cdk deploy 금지 (위 "브랜치 / 배포 규칙")
# 배포 후: SSM/Secrets 값 입력 → seed → 상태머신 수동 실행
SOURCES_TABLE=<out> PROFILE_TABLE=<out> AWS_REGION=ap-northeast-2 npm run seed

# 소스 1건 추가 (YouTube @handle은 채널 ID로 자동 변환, 저장 전 피드 생존 확인)
SOURCES_TABLE=<out> AWS_REGION=ap-northeast-2 \
  npm run add-source -- --type youtube --url @ThePrimeagen --category dev-ai
SOURCES_TABLE=<out> AWS_REGION=ap-northeast-2 \
  npm run add-source -- --type reddit --url r/rust --category dev-ai
# --dry-run 이면 AWS 없이 검증만
```
완료 기준: 매일 다이제스트가 오고, Notion에 글이 쌓인다.
