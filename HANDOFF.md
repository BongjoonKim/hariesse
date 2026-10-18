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

> ✅ **2026-09-06 소스 확장 증분 — 배포 완료 (2026-10-04 확인).**
> `Source.type`으로 **blog / youtube / reddit** 수집을 분기한다 (`src/lib/collectors.ts`).
> - YouTube: 채널 RSS(`feeds/videos.xml?channel_id=UC...`), 본문 = 영상 설명. 페이지 추출은 안 한다(Readability로 안 나옴).
> - Reddit: 서브레딧 RSS(`r/<sub>/top/.rss?t=day`). 링크글은 **외부 원문**을 저장·추출하고
>   댓글 스레드를 `discussionUrl`로 남겨 Telegram에 `💬 토론` 줄로 보여준다. 자기글은 selftext.
> - Telegram 항목 제목에 소스 아이콘(📝/📺/👽), 큐레이션 프롬프트에 소스 특성 힌트 추가.
> - `scripts/add-source.ts` (`npm run add-source`) — 소스 1건 추가 CLI. YouTube `@handle` → 채널 ID 자동 변환,
>   저장 전 피드 생존 확인, `--dry-run` 지원.
> - seed/add-source 모두 `putSourceIfNew` — **재실행해도 기존 소스의 weight를 덮지 않는다.**
> - 실측 검증(로컬): Fireship 15건 / r/programming·r/LocalLLaMA·r/aws·r/solotravel 정상 파싱 / 토스 20건.
> - 배포일은 기록 없음 — 늦어도 9/29부터 Reddit 수집 기록이 있고 `CollectFn` 최종 갱신은 9/30. YouTube 4채널·Reddit 6개 매일 수집 중 (§3-1).

> ✅ **2026-09-30 학습 트랙 증분 — 2026-10-04 배포·E2E 검증 완료.**
> 목적: AI를 잘 쓰기 위한 기본기(cloud / backend / frontend / cicd)를 매일 조금씩. 다이제스트와 별개 메시지.
> - `LearnFn` + EventBridge **매일 20:00 KST (11:00 UTC)**. Bedrock이 레슨 1건을 JSON으로 쓰고
>   (개념 / 왜 중요한가 / 핵심 / 예제 코드 / AI에게 시킬 때 / 10분 실습 / 퀴즈(스포일러)), Telegram 전송 + Notion "학습노트" 페이지 생성.
> - 커리큘럼 `src/domain/curriculum.ts`: Kubernetes·Jenkins·Node.js·Langflow·React 5트랙 × 9레슨 = 45레슨.
>   트랙 라운드로빈 → 각 트랙은 순서대로. 다 돌면 심화 모드로 재순환. 공식 문서 링크 전부 2026-09-30 200 확인.
> - 버튼: `✅ 이해했어요`(완료 기록, 진도 표시에 반영) / `🔁 쉽게 다시`(다음 회차에 그 레슨을 쉬운 버전으로). Feedback Lambda가 `l1|` prefix로 처리.
> - 레슨에 "📎 hariesse가 모아둔 관련 글" 최대 2건 — 수집된 글 중 트랙 키워드 매칭, 점수 50+.
> - seed에 학습 연계 소스 10건 추가 (Kubernetes/CNCF/Jenkins/Node.js/Langflow/React/web.dev 블로그 + r/kubernetes·r/node·r/reactjs),
>   기존 Profile에는 없는 관심사 키만 추가(Kubernetes, Jenkins, CI/CD, Node.js, Langflow, 프론트엔드).
> - 로컬 실측: Bedrock(sonnet-4-5)으로 jk-01 생성 25초, 2.3k자 1메시지. 단위테스트 93개 통과, `cdk synth` 성공.
> - 2026-10-04 배포: `dface73`(다이제스트 2~4건) 위에 rebase 후 Prod ff-merge → `cdk deploy --all` → seed(신규 소스 10건 + 관심사 6개).
>   `LearnFn`(`HariessePipeline-LearnFn82657FAF-EATxOFghnm26`)을 `{"force":true}`로 실행 → k8s-01 Telegram 1메시지 + 관련 글 2건 + Notion 학습노트 생성 확인.
>   진도: `turn=1, next.k8s=1, lastSentDate=2026-10-04` → 당일 20:00 정기 실행은 건너뛰고 다음 날 jk-01부터.

> 🔎 **2026-10-04 운영 점검 (AWS 실측).** 상세는 §3-1.
> - 스택 3개(`HariesseData`/`HariessePipeline`/`HariesseApi`) 정상, 스케줄 2개(07:00·20:00 KST) ENABLED.
> - 소스 23개 중 22개 active (우아한형제들 muted). 매일 2개 실패하던 것 처리함 — 우아한형제들 403은 비활성화, Reddit 429는 재시도 정책 수정.
> - 학습 연계 소스 10건은 10/4 seed 직후라 아직 한 번도 수집 안 됨 → 10/5 07:00 첫 수집.

> 🔤 **2026-10-18 단어장 철자 자동 교정 증분 — develop PR, Prod 미반영** (브랜치 `claude/english-translation-spelling-65d7fe`).
> 문제: "everiything"처럼 오타가 있는 문장을 보내면 모델은 오타를 알아채고 메모에 `철자 확인: everything`이라고 쓰는데, 표현(Notion 제목)은 오타 그대로 저장됐다.
> 원인은 모델이 아니라 코드 — 저장 프롬프트가 교정을 note에만 쓰게 했고 응답 스키마에 고친 표현을 돌려줄 칸이 없었다(핸들러는 항상 `input.text`를 저장). 모델 교체로는 안 고쳐진다.
> - 단어 응답(`VocabEnrichment`)에 `correctedText` 추가. 프롬프트: 오타가 있으면 **철자만** 고친 표현 전체를 넣고(단어 선택·문법·대소문자·문장부호는 그대로), 없으면 빈 문자열. note에 철자 얘기는 쓰지 않는다.
> - `detectSpellingCorrection`(순수함수): correctedText의 dedup 키가 원래와 다를 때만 교정으로 본다(대소문자·문장부호만 다르면 사용자가 쓴 그대로). 고친 표현·키·종류 + 메모 줄을 돌려준다.
>   메모 줄: 단어 수가 같으면 `✏️ 철자 교정: everiything → everything`, 다르면(`alot` → `a lot`) `✏️ 철자 교정 · 원래 입력: <원문>`. `withSpellingNote`가 메모 맨 앞에 붙이고, 모델이 예전 형식대로 쓴 `철자 확인:` 줄은 뺀다.
> - Telegram 저장: 고친 철자의 키가 **이미 있는 표현이면 새 행 대신 그 카드의 헷갈린 횟수 +1**(한 번 더 조회). 사용자가 `::`로 쓴 뜻은 그대로. 교정이 없으면 동작 변화 없음.
> - Notion 빈 칸 채우기(`enrichPending`)도 똑같이 — 제목을 고친 철자로 바꾸고 메모에 원래 입력을 남긴다.
> - 검증: `tsc`, 단위테스트 151개(신규 5), `cdk synth` 성공. **남은 확인(E2E, 배포 후)**: 오타 문장 1건 → 카드 제목이 고쳐지고 메모 첫 줄에 교정 기록, 같은 문장을 바르게 다시 보내면 `이미 있는 표현`으로 집계되는지.

> ✏️ **2026-10-17 단어장 뜻 수정 증분 — 2026-10-17 배포 완료** (PR #9 → develop, PR #10 → Prod 6495cf4, Deploy 워크플로 성공. `VocabFn`·`FeedbackFn` 09:30 KST 갱신 확인).
> 문제: 카드 번역이 어색해서 "고용이 아니라 근무가 시작된다는 뜻이야"라고 보냈더니 그 한국어 문장이 **새 표현으로 저장**됐다.
> - 수정 요청 판별(`isCorrectionRequest`, 순수함수): 한글이 영문자보다 많은 메시지는 새 표현이 아니라 수정 요청. `표현 :: 뜻`·`#태그`는 세지 않는다.
> - 대상 표현: ① 카드(저장·복습 메시지)에 **답장**했으면 그 카드 — Feedback Lambda가 `reply_to_message.reply_markup`의 `t1|` callback에서 page id를 꺼내 `replyToPageId`로 넘긴다.
>   ② 답장이 없으면 **24시간 안에 마지막으로 저장·수정한 표현**(Profile `pk='VOCAB'`의 `lastCapturePageId`/`lastCaptureAt`). 둘 다 없으면 답장으로 보내 달라고 안내.
> - 반영: 현재 카드 + 요청을 Bedrock(`reviseVocab`)에 주고 카드를 다시 쓴다. enrich와 달리 채워진 칸도 덮지만 응답이 비운 칸은 원래 값 유지.
>   표현 자체를 고치면(철자 등) `text`·`키`·`종류`도 같이 바꾸되, 그 키가 이미 다른 행이면 표현은 두고 뜻만 고친다. 복습 상태(박스·다음 복습)는 안 건드림.
> - 답장 카드 `✏️ 고쳤어요` + `🗑 삭제` 버튼. `/help`류 사용법에 수정 방법 추가.
> - `putVocabReviewState` → `updateVocabReviewState`(SET 머지): 복습 발송일과 마지막 저장 표현이 서로를 지우지 않게.
> - 검증: `tsc`, 단위테스트 146개(신규 10), `cdk synth` 성공. **남은 확인(E2E, 폰에서)**: 카드 답장으로 수정 1건 + 답장 없이 한국어 수정 1건 → `✏️ 고쳤어요` 카드 + Notion 행 갱신, 한국어 요청이 새 행으로 안 생기는지.
> - 잘못 저장된 한국어 행("고용이라기 보다는…")은 그 카드의 `🗑 삭제`로 지우면 된다 (코드가 지우지 않음).

> 🆕 **2026-10-11 TOEFL 단어장 증분 — 2026-10-11 배포 완료** (브랜치 `claude/toefl-vocab-tracking-971d54` → `develop` d12e86b, Prod 미반영).
> 목적: TOEFL 공부 중 만난 단어·표현·문장을 Telegram이나 Notion에 적어 두면 뜻을 채워 주고, 간격 반복으로 복습시킨다.
> - **원본 저장소 = Notion DB "TOEFL Vocab"** (`5582e65c809b45e1b420325db9fc9adb`, 부모 페이지 `38de549e…` = hariesse Archive와 같은 위치. 그 페이지 이름이 "My secretary" → "봉준 개발목록"으로 바뀜).
>   DynamoDB에 따로 저장하지 않는다. 양쪽에서 수정되니 동기화 충돌을 피하려고 Notion 하나로 둠. 뷰: 기본 / 📅 복습 순서 / ❗ 자주 헷갈림.
> - 입력 ① Telegram: 봇에 그냥 보내면 됨. 한 줄 = 1건, `표현 :: 내 뜻 #태그`는 선택. ≤4단어이고 문장부호로 끝나지 않으면 '단어', 아니면 '문장'(번역 + 핵심 표현).
>   Feedback Lambda가 **내 채팅(SSM telegram-chat-id)만** 받아서 `VocabFn`을 **비동기 호출**하고 바로 200을 준다(Bedrock 대기로 webhook 재전송이 생기지 않게).
>   같은 표현(키 = 소문자·공백 정규화)을 또 보내면 새 행 대신 `헷갈린 횟수 +1`이고, 외운 표현이면 박스 1로 되살린다.
> - 입력 ② Notion: `표현`만 적으면 됨. 매일 복습 실행 때 `상태`가 비었거나 '새로 추가'인 행의 **빈 칸만** Bedrock으로 채운다(사용자가 적은 뜻·예문은 안 덮음, 1회 최대 20건).
> - 복습: `VocabFn` + EventBridge **매일 21:00 KST (12:00 UTC)**. 차례가 된 표현(밀린 순 → 헷갈린 순) 최대 `vocab-review-size`(기본 10)개.
>   뜻은 스포일러로 가리고 버튼 `[✅ 알아요][❌ 몰라요]`. Leitner 박스 0→5, 간격 1·1·3·7·14·30일, 박스 5에서 ✅ = '외움'.
>   같은 KST 날짜엔 1번만 반영(`마지막 복습`). 누르면 버튼이 사라진다. `/review` = 지금 바로 복습(정기 발송 기록은 안 건드림), 그 밖의 `/명령` = 사용법.
> - callback prefix `t1|k|f|x` + Notion page id(하이픈 제거 32자). 저장 카드의 `🗑 삭제` = Notion 휴지통 이동.
> - `VocabFn` 비동기 재시도 0회 (재시도되면 같은 표현이 '또 헷갈림'으로 집계됨). 정기 발송일은 Profile `pk='VOCAB'`.
> - SSM 이름이 12개가 되어 `getConfig()`를 10개씩 나눠 조회하도록 고쳤다. `fix/ssm-getparameters-limit`(2e0acab)와 같은 수정이라 합칠 때 충돌나면 한쪽만 남기면 된다.
> - 검증: `tsc`, 단위테스트 136개(신규 31), `cdk synth` 성공.
> - **배포 절차 (2026-10-11 실행함 — 재배포 시 참고)**
>   1. `aws ssm put-parameter --name /hariesse/vocab-notion-database-id --type String --value 5582e65c809b45e1b420325db9fc9adb --region ap-northeast-2`
>   2. `AWS_REGION=ap-northeast-2 npx cdk deploy --all` — 로컬 AWS 설정에 리전이 없어서 안 주면 **us-east-1로 합성된다**.
>      Windows에서 번들링이 `npm.ps1` 실행 정책에 막히면 이 프로세스에만 `PSExecutionPolicyPreference=Bypass`를 준다.
>   3. **setWebhook을 다시 등록**: `allowed_updates=["callback_query","message"]` (지금은 callback_query만 받아서 메시지가 안 온다). URL·secret_token은 기존 그대로.
>   4. Notion hariesse 연동이 새 DB에 접근되는지 확인. 부모 페이지에서 권한이 상속되는데, 안 되면 DB의 ⋯ → 연결에서 추가.
>   5. E2E: 봇에 단어 1개 + 문장 1개 → 카드 답장 + Notion 행 확인 → `/review` → 버튼 → `다음 복습` 갱신 확인.
> - 2026-10-11 실행 기록: 이 Windows PC는 기본 AWS 프로필이 없다 → `AWS_PROFILE=nadeliv`(nadeliv_adm). Git Bash에선 SSM 경로가 Windows 경로로 바뀌니 `MSYS_NO_PATHCONV=1`.
>   `cdk diff` = VocabFn·스케줄·권한 추가 + 기존 함수 코드 해시만 (삭제/교체 없음). Design 스택(`HariesseDesign*`)은 이 브랜치 `bin/app.ts`에 없어서 안 건드림.
>   setWebhook allowed_updates = `["message","callback_query"]`로 변경 확인. VocabFn = `HariessePipeline-VocabFnBDF53B75-B0nLW1kr3Orc`.
>   VocabFn capture 직접 호출(단어 corroborate + 문장 1개) → Notion 2행 + 카드 답장 OK (11초). Notion에 `mitigate`만 넣고 `{"type":"review","force":true}` → 빈 칸 채움 OK.
>   퀴즈 1건 발송 OK. **남은 확인: 실제 폰에서 메시지 보내기(webhook message 경로) + 퀴즈 버튼 누르기(t1 callback).**

> 🚧 **2026-10-14 브랜치·배포 흐름 전환 — 진행 중.** 규칙은 CLAUDE.md "브랜치 / 배포 규칙", 결정 이유는 §2.
> - 추가: `.github/workflows/ci.yml`(PR 검증), `.github/workflows/deploy.yml`(Prod push → `cdk deploy --all` + `deploy:design`),
>   `infra/github-deploy-role.yaml`(OIDC Role `hariesse-github-deploy`, Prod 브랜치 전용, CDK 부트스트랩 Role assume만 허용).
> - `develop` 생성됨 (2026-10-14, Windows) = TOEFL 단어장(d12e86b, 44ef8fa). **배포된 것과 일치 확인** (Mac, 10/14):
>   develop `cdk synth` vs 배포된 CloudFormation 템플릿 — `HariessePipeline` 27개·`HariesseApi` 7개 리소스 동일, 속성 차이는 CDKMetadata뿐
>   (Lambda 코드 해시는 빌드 머신마다 달라 비교 제외). 테스트 136개·tsc·synth 통과.
> - **아직 develop에 없는 것**: `claude/telegram-design-sharing-setup-46f864` (stage 분리 `HariesseDesign*`, 10/10 배포).
>   develop과 코드 충돌 6곳(bin/app.ts, api-stack, pipeline-stack, constants, 문서 2) — 별도 PR로 합친다.
>   **자동배포의 blocker는 아님**: Prod에 stage 코드가 없으면 `deploy:design`이 `--if-present`로 건너뛰고,
>   `cdk deploy --all`은 앱에 없는 스택을 지우지 않으므로 `HariesseDesign*`은 그대로 남는다.
>   SSM GetParameters 분할 fix(2e0acab)는 develop에 같은 수정이 이미 있다 → 충돌 시 develop 쪽 유지.
> - ✅ Role 스택 `HariesseGithubDeploy` 배포 완료 (2026-10-14, Mac). trust = `repo:BongjoonKim/hariesse:ref:refs/heads/Prod`만,
>   IAM 시뮬레이션: cdk 부트스트랩 Role assume = allowed, 그 밖의 Role(nadeliv-frontend-deploy 등) = deny.
> - 남은 순서: ① 이 브랜치(`chore/branch-flow-ci`) → develop PR → ② (Role 완료) → ③ develop → Prod 머지로 첫 자동배포 → VocabFn·다이제스트·학습 레슨 동작 확인
>   → ④ 디자인 브랜치를 develop 기준으로 충돌 해결해 PR.
> - ✅ 2026-10-14 첫 자동배포 성공 (PR #5 develop→Prod, PR #6 이 브랜치 — #6은 실수로 Prod에 바로 머지됨, develop은 이후 ff로 맞춤).
>   Deploy 약 3분, `Hariesse*` 3스택 UPDATE_COMPLETE, VocabFn 유지, 스케줄 3개 ENABLED. `HariesseDesign*`은 미변경.
> - ④ 2026-10-16 디자인 브랜치 → `feat/merge-design-stage`(develop 기준) 충돌 해결. `-c vocab=false` 추가(단어장은 내 배포 전용).
>   검증: 테스트 137·tsc·synth(양 stage) 통과. 배포된 7스택과 비교 — 리소스 추가/삭제 0, `cdk diff`(change set) = Lambda 코드 해시 +
>   Outputs 추가(Collect/Curate/Deliver/FeedbackFunctionName, SecretsPrefix)뿐, 교체 없음. `HariesseDesignPipeline`(16개)에 VocabFn 안 생김.
> - 권장: GitHub에서 Prod 브랜치 보호(PR 필수) — 실수로 Prod에 직접 push해 배포되는 것 방지.
> - CI의 리전: `bin/app.ts`가 `CDK_DEFAULT_REGION ?? 'ap-northeast-2'`이고 deploy 잡은 `aws-region: ap-northeast-2`를 준다
>   → 위 단어장 메모의 "리전 없으면 us-east-1로 합성" 문제는 CI에서 생기지 않는다.

> 🆕 **2026-10-04 stage 분리 + 디자인 배포 + 운영 전용 IAM — 2026-10-10 로컬 배포됨, 2026-10-16 develop에 합침 (`feat/merge-design-stage`).**
> 목적: 여자친구에게 **디자인 다이제스트**를 Telegram으로. AWS 관리와 배포는 내가, 설정·소스 운영은 여자친구 PC의 Claude Code가(운영 전용 IAM 사용자).
> - `bin/app.ts` 컨텍스트 `stage`: 없으면 기존 이름 그대로(내 배포, 테이블 재생성 없음), `design`이면 `HariesseDesign*` / `/hariesse-design/*` / `hariesse-design/*`.
>   `constants.ts`의 `configPrefix()`/`stackPrefix()`가 유일한 이름 규칙. Lambda 환경변수 `HARIESSE_STAGE`.
> - `-c learning=false`: LearnFn + 20:00 스케줄 생략(디자인 배포는 개발 커리큘럼이 맞지 않아 끔). `-c operator=true`: `OperatorStack`.
> - `OperatorStack`(`lib/stacks/operator-stack.ts`): IAM 사용자 `hariesse-design-operator` + 관리형 정책. 범위 = 그 stage의 SSM/Secrets 접두어, 함수 5개(호출·설정변경·로그), 상태머신, 테이블 3개 R/W, 스택 Outputs 조회, Bedrock 목록 조회. **배포 권한 없음**(`-c operatorDeploy=true`로 켤 수 있으나 bootstrap 실행 역할이 관리자라 사실상 계정 전체 배포권 → 기본 끔).
>   액세스 키는 CDK로 만들지 않는다(시크릿이 CFN에 남음). 배포 후 `aws iam create-access-key --user-name hariesse-design-operator`로 직접 발급해 전달.
> - 카테고리 `design` 추가(telegram/notion 라벨 '디자인', add-source 허용). 큐레이션 프롬프트에 SSM `user-persona` 추가(없으면 생략, 내 배포는 영향 없음).
> - `scripts/seed.ts` `SEED_SET=design`: 디자인 소스 22건(블로그 10 / YouTube 8 / Reddit 4, 2026-10-04 피드 생존 확인) + 디자인 Profile. `npm run seed:design`.
> - 운영자용 문서 `docs/OPERATOR.md` — 여자친구 PC의 Claude가 이것만 보고 봇 생성 → Secrets/SSM 입력 → webhook → seed → 수동 실행까지 하도록 썼다. Notion은 선택.
> - 검증: `tsc`, 단위테스트 97개 통과, `cdk synth` 양쪽 성공. `cdk diff`(내 스택) = Lambda 코드 해시 + Outputs 추가만, IAM/환경변수 변화 없음.
> - 2026-10-16 합칠 때 추가: `-c vocab=false` (단어장은 내 배포 전용 — 디자인 stage엔 VocabFn·21:00 스케줄 없음). `deploy:design` 스크립트에 포함.
> - **배포 명령**: ~~로컬 `npm run deploy:design`~~ → 이제 Prod 머지 시 CI가 실행. 이후 → 운영자 액세스 키 발급 → 여자친구 PC로 전달 → `docs/OPERATOR.md` §3.
>   내 스택도 코드가 바뀌었으니(persona 지원, Outputs) 다음 `npx cdk deploy --all`에서 같이 올라간다. 급하지 않음.
> - ⚠️ **bdb793c를 Prod에 머지할 때 `2e0acab`(SSM GetParameters 10개씩 나눠 조회, PR #2)도 반드시 같이 넣을 것.** 빠지면 `user-persona`로 SSM 이름이 11개가 되어 모든 Lambda의 `getConfig()`가 ValidationException으로 죽는다(design은 10/4~10/10 7회 연속 실패).

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
| 브랜치·배포 | **작업 브랜치 → develop PR → Prod 머지 시 GitHub Actions 자동배포** (2026-10-14). 로컬 `cdk deploy` 금지 | Mac·Windows 두 PC에서 작업하는데 Claude Code 세션·메모리는 PC 간 공유가 안 된다. Windows에서 로컬 배포한 VocabFn(10/11)이 GitHub에 없어 Mac에서 코드를 찾을 수 없었다. 배포 = GitHub Prod로 고정해 "배포된 것 = 리포에 있는 것"을 보장 |
| 관리자 웹 | **보류** (2026-10-04) — 운영은 Claude Code 세션에서 AWS CLI로 | 1인용이라 웹은 인증·유지보수 부담 대비 효용이 낮음. Phase 2에서 가중치 등 시각화할 데이터가 생기면 읽기 전용 대시보드 재검토 |

---

## 3. 최초 배포 전 상태 (2026-07-20 기록 — 이후 배포 완료, 맨 위 상태 블록 참고)

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

## 3-1. 운영 점검 (2026-10-04)

| 항목 | 상태 |
|---|---|
| CollectFn | 최종 갱신 2026-09-30. 9/30~10/3 매일 `collect 완료: 11~14건 신규 (73~91 스캔, 13 소스, 실패 2)` |
| 지속 실패 소스 | 우아한형제들 `techblog.woowahan.com/feed/` → **403** (매일) → muted. r/MachineLearning → **429** (9/30 이후 매일, 마지막 성공 9/29) → 재시도 정책 수정 |
| 미수집 소스 10건 | kubernetes.io, nodejs.org, react.dev, web.dev, cncf.io, jenkins.io, langflow.org, r/kubernetes, r/node, r/reactjs — 10/4 seed, 10/5 첫 수집 예정 |
| LearnFn | 10/4 force 실행 성공 (k8s-01). 트랙 라운드로빈이라 10/5 20:00은 **jk-01** |
| 소스 가중치 | 피드백 반영 중 — 토스 1.45, YouTube 일부 1.1~1.15, r/LocalLLaMA·r/programming 0.5 |

> **실패 소스 처리 (2026-10-04)**
> - 우아한형제들: 로컬(봇 UA 포함)에선 200, Lambda에선 매일 403 → Cloudflare가 AWS IP를 막는 것으로 판단.
>   우회(프록시 등)는 하지 않고 `status=muted`로 비활성화 (`mutedReason`/`mutedAt` 기록, weight 보존). 다시 켜려면 `status=active`.
> - Reddit 429: r/MachineLearning 고유 문제가 아니었다 (9/26~29엔 r/aws가 같은 식으로 실패). 익명 RSS는 요청 1번에
>   `x-ratelimit-remaining: 0`, `x-ratelimit-reset: ~50초`라 30초 백오프 1회로는 부족 → 백오프 `[30s, 60s]` + 서버 대기 헤더 존중(상한 90초).
>   2026-10-07 배포 (`CollectFn`만 변경). 배포 전 10/4~10/6은 Reddit 9개 중 매일 2개(r/aws, r/MachineLearning) 429.
>   로컬 실측: 9개 전부 성공, 단 첫 요청 외엔 거의 매번 429 → ~60초 대기 후 성공이라 **Reddit 구간만 ~8분**.
>   collect 전체 ~10분 예상 (타임아웃 14분). 서브레딧을 더 늘리면 타임아웃 여유부터 확인할 것.
> 상태 확인은 `aws logs filter-log-events --log-group-name /aws/lambda/<CollectFn> --filter-pattern '"collect 완료"'`.

---

## 4. 최초 배포 절차 (2026-07-20 실행 완료 — 재구축 시 참고)

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
| CDK 스택 | `HariesseData`, `HariessePipeline`, `HariesseApi` |
| Notion 부모 페이지 | "봉준 개발목록"(구 "My secretary") `38de549ed10280e6af9be92c7a6bfb3f` |
| Notion DB | "hariesse Archive" `a22cbf53637840dc867d6cd8e7b2614e` / "TOEFL Vocab" `5582e65c809b45e1b420325db9fc9adb` (SSM `/hariesse/vocab-notion-database-id`) |
| Telegram 봇 | `@haries_work_bot`, chat_id `8657904581` |
| Secrets Manager | `hariesse/telegram-bot-token`, `hariesse/notion-token` |
| SSM (설정됨) | `/hariesse/telegram-chat-id`, `/hariesse/notion-database-id` |
| SSM (미설정, 코드 기본값 사용) | `bedrock-model-id`, `bedrock-region`, `exploration-ratio`, `daily-bedrock-cap`, `daily-curate-cap`, `digest-size`(최대 4), `digest-min-size`(최소 2), `digest-min-score`(70) |
| 스케줄 | 다이제스트 매일 **07:00 KST** (= 22:00 UTC) / 학습 레슨 매일 **20:00 KST** (= 11:00 UTC) / TOEFL 복습 매일 **21:00 KST** (= 12:00 UTC) |

시드 소스 23개 (`scripts/seed.ts`) — 기존 13개 + 학습 연계 10개(2026-10-04 추가):
- blog(3): AWS Architecture Blog(cloud), 우아한형제들(dev-ai), 토스(dev-ai)
- youtube(4): Fireship, Two Minute Papers, 노마드 코더(dev-ai), Amazon Web Services(cloud)
- reddit(6): r/programming, r/LocalLLaMA, r/MachineLearning(dev-ai), r/aws, r/devops(cloud), r/solotravel(travel)
- 학습 연계(10): Kubernetes·CNCF·Jenkins(cloud), Node.js·Langflow·React·web.dev(dev-ai) 블로그 + r/kubernetes(cloud)·r/node·r/reactjs(dev-ai)

신규 소스는 weight 0.8로 시작(기존 블로그 1.0보다 낮게) — 피드백으로 올라가게 둔다.

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

### 학습 트랙 후속 아이디어
- 완료/쉽게다시 신호로 트랙별 난이도 자동 조정, 주간 복습 퀴즈
- 트랙 추가(Docker, GitHub Actions, AWS 네트워킹 등) — `curriculum.ts` 끝에 붙이면 됨

### Phase 3 — 발견·고도화
- 신규 사이트 자동 발견(Discovery) + candidate 시범 노출
- `layoutType` 분석, AI 의견 프롬프트 고도화
- arXiv/HackerNews 소스 확장 (YouTube/Reddit은 2026-09-06 완료)
- YouTube 자막 수집 — 설명글만으로는 요약 품질에 한계가 있다

---

## 8. 함정 메모

- **"코드가 없는데 AWS엔 있다"** → 다른 PC에서 로컬 `cdk deploy`만 하고 push를 안 한 것. Claude Code 메모리·세션은 PC 간 공유되지 않는다.
  배포는 Prod 머지(GitHub Actions)로만 할 것. 확인: `aws lambda list-functions`의 LastModified vs `git log origin/Prod`.

- **Notion 403/object_not_found** → 토큰 문제가 아니라 페이지에 integration을 **Connections로 연결 안 한 것**이 1위 원인. (이번엔 연결 완료됨)
- **jsdom 번들링** → esbuild로 직접 번들하면 깨진다. `NodejsFunction`의 `nodeModules`로 설치하는 방식 유지할 것. `package-lock.json`이 있어야 동작.
- **Bedrock 모델 ID** → 서울은 교차리전 추론 프로파일(`apac.*` / `global.*`) 사용. 비용 절감하려면
  `global.anthropic.claude-haiku-4-5-20251001-v1:0`, 품질 우선이면 `global.anthropic.claude-sonnet-4-5-20250929-v1:0`로 SSM 덮어쓰기.
- **macOS 셸** → `head -n -1` 같은 GNU 전용 옵션 안 먹는다.
- **Reddit 레이트리밋** → 익명 요청은 금방 429가 나고 한 번 걸리면 수십 초 안 풀린다.
  `collectors.ts`의 `REDDIT_POLICY`(호출 간격 20초 + 백오프 30s·60s, `x-ratelimit-reset` 헤더 존중)를 줄이지 말 것.
  그래도 일부 서브레딧이 실패할 수 있는데, collect는 실패 소스를 건너뛰고 계속 간다
  (`failedSources` 카운트로 로그에 남음). `.json` 엔드포인트는 UA를 붙여도 403이라 안 쓴다.
- **YouTube 채널 ID** → `@handle`은 바뀔 수 있어 채널 ID(`UC...`)로 저장한다.
  핸들→ID 변환은 네트워크가 필요해서 런타임(Lambda)이 아니라 `scripts/add-source.ts`에서만 한다.
- **소스 재시드** → `putSourceIfNew`라 기존 소스는 그대로 둔다. 소스 설정을 **바꾸고 싶으면**
  덮어쓰기가 아니라 콘솔/CLI로 해당 항목만 수정할 것 (weight 초기화 사고 방지).
