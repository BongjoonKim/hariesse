# hariesse — CLAUDE.md

개인용 서버리스 콘텐츠 큐레이션 에이전트(hariesse). 매일 여행 / 개발·AI·클라우드 콘텐츠를 자동
수집·요약·큐레이션해 **Telegram 다이제스트 푸시 + Notion 아카이브**한다.

> 📌 **세션을 이어받는 중이라면 [HANDOFF.md](./HANDOFF.md)를 먼저 읽을 것.**
> 현재 상태, 검증 결과, 다음 실행할 명령어, 결정 이력이 모두 거기 있다.
> **요약: 2026-07-20 배포 + E2E 검증 완료. Feedback 증분(Telegram 버튼 + ApiStack)도 배포·검증 완료.**
> **2026-09-06 소스 확장 증분: YouTube + Reddit 수집 어댑터 — 배포 완료, 매일 수집 중 (2026-10-04 확인).**
> **2026-09-30 학습 트랙 증분: 매일 20:00 KST 기술 레슨 1건(Telegram + Notion 학습노트) — 2026-10-04 배포·E2E 검증 완료.**
> **운영(소스 추가·상태 확인·설정 조정)은 관리자 웹 없이 Claude Code 세션에서 한다 (2026-10-04 결정, HANDOFF §2).**
> **다음 증분은 Phase 2 개인화(가중치 학습 슬롯 반영, isNovel 실제 신호) — HANDOFF §7 로드맵 참고.**

## 현재 상태: Phase 1 + Feedback + 소스 확장
`Collection → Curation → Delivery → Feedback` 루프가 끝까지 동작.
- 다이제스트 항목마다 인라인 버튼 `[👍 좋아요][⭐ 사이트 좋아요][💾 nadeliv 글감][⏭ 건너뛰기]`
  → Feedback Lambda가 Sources 가중치 ±, Profile 관심사 누적, Notion 상태 갱신 (액션당 1회 idempotent).
- 소스 타입 3종: **blog RSS / YouTube 채널 / Reddit 서브레딧** (`Source.type`, 기본 `blog`).
- **학습 트랙**: 다이제스트와 별개로 매일 20:00 KST에 레슨 1건. 범위는 cloud / backend / frontend / cicd 한정.
  Kubernetes → Jenkins → Node.js → Langflow → React 순으로 트랙을 돌고, 트랙 안에서는 1강부터 순서대로.
  버튼 `[✅ 이해했어요][🔁 쉽게 다시]` — 쉽게 다시 = 다음 회차에 진도를 멈추고 그 레슨을 쉬운 버전으로 재발송.
  전 과정(45레슨)을 다 돌면 같은 목차를 심화 모드로 다시 돈다.
- **제외(다음 증분)**: Sources 가중치의 스코어링 반영, Profile 패턴학습,
  Discovery 파이프라인, layoutType, arXiv/HN 소스 확장.

## 아키텍처
- **DataStack**: DynamoDB `Sources`/`Articles`/`Profile` + S3(raw 본문).
- **PipelineStack**: Lambda 3개(collect/curate/deliver) + Step Functions(순차) + EventBridge(매일 07:00 KST = 22:00 UTC).
  + LearnFn(학습 레슨) + 별도 EventBridge(매일 20:00 KST = 11:00 UTC). SFN 밖에서 독립 실행.
- **ApiStack**: Feedback Lambda + Function URL(Telegram webhook, secret_token 헤더 인증).
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
- `src/handlers/{collect,curate,deliver,feedback,learn}/index.ts` — Lambda 핸들러.

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
  `collectors.ts`의 호출 간격(4초) + 백오프 재시도를 줄이지 말 것.
- **학습 레슨 id는 바꾸지 말 것**: 진도·완료 기록이 레슨 id(`k8s-01` 등)로 저장되고 버튼 callback_data에도 들어간다.
  레슨 추가는 트랙 끝에. 참고 링크는 LLM이 만들지 않고 `curriculum.ts`의 공식 문서만 쓴다(지어낸 URL 방지).
- **학습 진도 저장 위치**: Profile 테이블의 `pk='LEARNING'` 아이템. 같은 KST 날짜엔 1번만 발송(`lastSentDate`).
  수동 테스트: `aws lambda invoke --function-name <LearnFunctionName> --payload '{"force":true}' ...`
- **callback_data prefix**: `v1|` = 다이제스트 피드백, `l1|` = 학습 레슨 버튼.
- **시크릿은 코드/리포에 두지 않음**: Secrets Manager(`hariesse/*`) + SSM(`/hariesse/*`)에서만 읽음.

## 설정값 위치
- SSM `/hariesse/*`: bedrock-model-id, bedrock-region, exploration-ratio, notion-database-id,
  telegram-chat-id, daily-bedrock-cap, daily-curate-cap, digest-size, digest-min-size, digest-min-score.
- 다이제스트 건수: 점수 ≥ `digest-min-score`(기본 70)인 글 수를 [`digest-min-size`(2), `digest-size`(4)]로 클램프.
- Secrets `hariesse/telegram-bot-token`, `hariesse/notion-token`.
- Notion DB ID (생성됨): `a22cbf53637840dc867d6cd8e7b2614e` (My secretary 페이지 하위, DB명 "hariesse Archive").

## 배포 / 검증
```
npm install
npm test                 # scoring + extract 단위테스트
npm run build            # tsc --noEmit 타입체크
npx cdk synth            # 합성
npx cdk bootstrap        # 최초 1회
npx cdk deploy --all
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
