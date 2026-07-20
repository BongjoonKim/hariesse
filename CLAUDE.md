# hariesse — CLAUDE.md

개인용 서버리스 콘텐츠 큐레이션 에이전트(hariesse). 매일 여행 / 개발·AI·클라우드 콘텐츠를 자동
수집·요약·큐레이션해 **Telegram 다이제스트 푸시 + Notion 아카이브**한다.

> 📌 **세션을 이어받는 중이라면 [HANDOFF.md](./HANDOFF.md)를 먼저 읽을 것.**
> 현재 상태, 검증 결과, 다음 실행할 명령어, 결정 이력이 모두 거기 있다.
> **요약: 코드·검증 완료 / 아직 미배포. 다음 할 일은 `cdk bootstrap` → `cdk deploy --all`.**

## 현재 상태: Phase 1 워킹 스켈레톤
`Collection → Curation → Delivery` 한 줄기가 끝까지 동작.
- **제외(다음 증분)**: Telegram 버튼/Feedback Lambda·API 스택, Sources 가중치 학습, Profile 패턴학습,
  Discovery 파이프라인, layoutType, YouTube/arXiv/HN/Reddit 소스 확장.

## 아키텍처
- **DataStack**: DynamoDB `Sources`/`Articles`/`Profile` + S3(raw 본문).
- **PipelineStack**: Lambda 3개(collect/curate/deliver) + Step Functions(순차) + EventBridge(매일 07:00 KST = 22:00 UTC).
- **LLM**: Amazon Bedrock(Claude), 서울 리전 ap-northeast-2. 모델 ID는 SSM 분리, 교차리전 추론 프로파일(`apac.*`).

## 데이터 흐름
```
EventBridge(매일) → SFN: Collect(RSS fetch+dedup+본문 S3) → Curate(Bedrock 점수/요약/AI의견/태그)
                         → Deliver(활용70/탐험30 → Telegram + Notion upsert)
```

## 코드 맵
- `src/lib/config.ts` — SSM/Secrets 로드(콜드스타트 캐시). `getConfig()`, `getSecret()`.
- `src/lib/constants.ts` — ENV 키, SSM 경로, Secrets 이름, 기본값. **값은 두지 않음.**
- `src/lib/dynamo.ts` — 테이블 CRUD + `hashUrl`(articleId/dedup), `hashDomain`(siteId).
- `src/lib/extract.ts` — HTML→본문(`extractReadable` 순수함수, 테스트 대상) + `fetchAndExtract`.
- `src/lib/bedrock.ts` — `curateArticle()` 큐레이션 프롬프트 → JSON.
- `src/lib/telegram.ts` / `notion.ts` — 다이제스트 전송 / URL 기준 upsert.
- `src/domain/scoring.ts` — `rankAndSplit()` 활용/탐험 분배(순수함수, 테스트 대상).
- `src/handlers/{collect,curate,deliver}/index.ts` — Lambda 핸들러.

## 코딩 규칙 / 가드레일
- **dedup·idempotency**: articleId = `hashUrl(url)`. collect는 `putArticleIfNew`(조건부 put), Notion은 URL 기준 upsert.
- **일일 상한**: collect 신규 글 수 ≤ `dailyCurateCap`, curate Bedrock 호출 ≤ `dailyBedrockCap` (SSM).
- **TTL**: Articles `ttl`(기본 30일)로 미독 자동 정리.
- **동시성**: Lambda `reservedConcurrentExecutions: 2`. DynamoDB on-demand.
- **탐험/활용**: 매 다이제스트 explore 비율 = `EXPLORATION_RATIO`(기본 0.3). 에코챔버 방지 — 이 분배를 함부로 0으로 만들지 말 것.
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
npm test                 # scoring + extract 단위테스트
npm run build            # tsc --noEmit 타입체크
npx cdk synth            # 합성
npx cdk bootstrap        # 최초 1회
npx cdk deploy --all
# 배포 후: SSM/Secrets 값 입력 → seed → 상태머신 수동 실행
SOURCES_TABLE=<out> PROFILE_TABLE=<out> AWS_REGION=ap-northeast-2 npm run seed
```
완료 기준: 매일 다이제스트가 오고, Notion에 글이 쌓인다.
