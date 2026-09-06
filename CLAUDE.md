# hariesse — CLAUDE.md

개인용 서버리스 비서 에이전트(hariesse). 두 갈래로 돈다.
1. **콘텐츠**: 매일 여행 / 개발·AI·클라우드 글을 자동 수집·요약·큐레이션해 **Telegram 다이제스트 + Notion 아카이브**.
2. **할일·일정**: 주간 반복 루틴을 등록해 두면 **하루 3회(09/12/20 KST) Telegram 브리핑**으로 챙겨준다.

> 📌 **세션을 이어받는 중이라면 [HANDOFF.md](./HANDOFF.md)를 먼저 읽을 것.**
> 현재 상태, 검증 결과, 다음 실행할 명령어, 결정 이력이 모두 거기 있다.
> **요약: 2026-07-20 배포 + E2E 검증 완료. Feedback 증분(Telegram 버튼 + ApiStack)도 배포·검증 완료.**
> **비서(할일/브리핑) Phase A는 코드 완료·미배포 — 설계 전체는 [docs/ASSISTANT.md](./docs/ASSISTANT.md).**

## 현재 상태
**콘텐츠**: `Collection → Curation → Delivery → Feedback` 루프가 끝까지 동작 (배포·검증 완료).
**비서**: 루틴 → 하루 3회 브리핑 → 버튼 체크 루프 구현 완료 (미배포). 웹 UI·Google Calendar는 다음 Phase.
- 다이제스트 항목마다 인라인 버튼 `[👍 좋아요][⭐ 사이트 좋아요][💾 nadeliv 글감][⏭ 건너뛰기]`
  → Feedback Lambda가 Sources 가중치 ±, Profile 관심사 누적, Notion 상태 갱신 (액션당 1회 idempotent).
- **제외(다음 증분)**: Sources 가중치의 스코어링 반영, Profile 패턴학습,
  Discovery 파이프라인, layoutType, YouTube/arXiv/HN/Reddit 소스 확장.
- **비서 제외(다음 증분)**: 웹 관리 UI(S3+CloudFront), Google Calendar 연동, 자연어 등록.

## 아키텍처
- **DataStack**: DynamoDB `Sources`/`Articles`/`Profile`/`Tasks` + S3(raw 본문).
- **PipelineStack**: Lambda 3개(collect/curate/deliver) + Step Functions(순차) + EventBridge(매일 07:00 KST = 22:00 UTC).
- **AssistantStack**: Brief Lambda + EventBridge 3개(09/12/20 KST). 콘텐츠 파이프라인과 스케줄·실패 반경 분리.
- **ApiStack**: Feedback Lambda + Function URL(Telegram webhook, secret_token 헤더 인증).
  다이제스트 피드백(`v1|…`)과 브리핑 할일 체크(`t1|…`)를 한 webhook에서 처리.
- **LLM**: Amazon Bedrock(Claude), 서울 리전 ap-northeast-2. 모델 ID는 SSM 분리, 교차리전 추론 프로파일(`apac.*`).

## 데이터 흐름
```
콘텐츠  EventBridge(매일 07시) → SFN: Collect(RSS fetch+dedup+본문 S3)
                                  → Curate(Bedrock 점수/요약/AI의견/태그)
                                  → Deliver(활용70/탐험30 → Telegram + Notion upsert)

비서    EventBridge(09/12/20시) → Brief: ensureDayPlan(루틴→그날 할일, 조건부 put)
                                  → 슬롯별 노출 계산 → Telegram + [✅][⏭] 버튼
        버튼 클릭 → Feedback(webhook) → 상태 변경 → 같은 메시지 다시 그림
```

`Tasks` 테이블은 pk/sk 단일 테이블: `ROUTINE`(루틴 정의, 영구) / `DAY#YYYY-MM-DD`(그날 할일, TTL 365일).
하루치 조회가 pk 하나로 끝나 GSI가 필요 없다.

## 코드 맵
- `src/lib/config.ts` — SSM/Secrets 로드(콜드스타트 캐시). `getConfig()`, `getSecret()`.
- `src/lib/constants.ts` — ENV 키, SSM 경로, Secrets 이름, 기본값. **값은 두지 않음.**
- `src/lib/dynamo.ts` — 테이블 CRUD + `hashUrl`(articleId/dedup), `hashDomain`(siteId).
- `src/lib/extract.ts` — HTML→본문(`extractReadable` 순수함수, 테스트 대상) + `fetchAndExtract`.
- `src/lib/bedrock.ts` — `curateArticle()` 큐레이션 프롬프트 → JSON.
- `src/lib/telegram.ts` / `notion.ts` — 다이제스트 전송(+인라인 버튼) / URL 기준 upsert.
- `src/lib/tasks.ts` — Tasks 테이블 CRUD + `ensureDayPlan()`(루틴 전개, idempotent).
- `src/domain/scoring.ts` — `rankAndSplit()` 활용/탐험 분배(순수함수, 테스트 대상).
- `src/domain/feedback.ts` — 다이제스트 callback_data + 액션별 효과(순수함수, 테스트 대상).
- `src/domain/routine.ts` — KST 날짜 계산, 루틴→하루 전개, 슬롯별 노출, 상태 토글,
  할일 callback_data(순수함수, 테스트 대상).
- `src/handlers/{collect,curate,deliver,feedback,brief}/index.ts` — Lambda 핸들러.
- `docs/ASSISTANT.md` — 비서 기능 설계·로드맵 (웹 UI·Google Calendar 포함).

## 코딩 규칙 / 가드레일
- **dedup·idempotency**: articleId = `hashUrl(url)`. collect는 `putArticleIfNew`(조건부 put), Notion은 URL 기준 upsert.
- **일일 상한**: collect 신규 글 수 ≤ `dailyCurateCap`, curate Bedrock 호출 ≤ `dailyBedrockCap` (SSM).
- **TTL**: Articles `ttl`(기본 30일)로 미독 자동 정리.
- **동시성**: Lambda `reservedConcurrentExecutions: 2`. DynamoDB on-demand.
- **탐험/활용**: 매 다이제스트 explore 비율 = `EXPLORATION_RATIO`(기본 0.3). 에코챔버 방지 — 이 분배를 함부로 0으로 만들지 말 것.
- **알림 피로**: 할일이 없는 날은 점심/저녁 브리핑을 보내지 않는다(`shouldSendBrief`). 아침만 항상 보낸다.
- **할일 체크는 토글**: 다이제스트 피드백의 1회성 마커와 정책이 다르다. 오탭을 같은 버튼으로 되돌릴 수 있어야 한다.
- **KST 환산**: 한국은 서머타임이 없어 UTC 고정 -9시간이면 정확하다. EventBridge cron은 UTC로 적는다.
- **소스 오브 트루스**: 반복 루틴은 hariesse, 약속·회의는 Google Calendar. 이 경계를 흐리지 말 것 (docs/ASSISTANT.md §0).
- **순수함수 우선**: 스코어링/추출 로직은 네트워크와 분리해 단위테스트 가능하게.
- **시크릿은 코드/리포에 두지 않음**: Secrets Manager(`hariesse/*`) + SSM(`/hariesse/*`)에서만 읽음.

## 설정값 위치
- SSM `/hariesse/*`: bedrock-model-id, bedrock-region, exploration-ratio, notion-database-id,
  telegram-chat-id, daily-bedrock-cap, daily-curate-cap, digest-size.
- Secrets `hariesse/telegram-bot-token`, `hariesse/notion-token`.
- Notion DB ID (생성됨): `a22cbf53637840dc867d6cd8e7b2614e` (My secretary 페이지 하위, DB명 "hariesse Archive").

## 배포 / 검증
```
npm install
npm test                 # scoring + extract + routine + brief 단위테스트
npm run build            # tsc --noEmit 타입체크
npx cdk synth            # 합성
npx cdk bootstrap        # 최초 1회
npx cdk deploy --all
# 배포 후: SSM/Secrets 값 입력 → seed → 상태머신 수동 실행
SOURCES_TABLE=<out> PROFILE_TABLE=<out> AWS_REGION=ap-northeast-2 npm run seed

# 비서: 주간 루틴 적재 (scripts/seed-routines.ts의 ROUTINES를 고쳐 재실행 = upsert)
TASKS_TABLE=<HariesseData 출력값> AWS_REGION=ap-northeast-2 npm run seed:routines

# 브리핑 수동 1회 (slot: morning | midday | evening)
aws lambda invoke --function-name <HariesseAssistant 출력 BriefFunctionName> \
  --cli-binary-format raw-in-base64-out --payload '{"slot":"morning"}' \
  --region ap-northeast-2 /dev/stdout
```
완료 기준: 매일 다이제스트가 오고 Notion에 글이 쌓인다. 09/12/20시에 할일 브리핑이 오고 버튼으로 체크된다.
