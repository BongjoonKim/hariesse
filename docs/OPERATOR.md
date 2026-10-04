# hariesse 운영자 가이드 (stage=design)

> 이 문서는 **다른 PC의 Claude Code 세션**이 읽는 것을 전제로 쓰였다.
> 당신(Claude)은 AWS 계정 `611288736262`(서울 `ap-northeast-2`)의 IAM 사용자
> **`hariesse-design-operator`** 자격증명으로 작업한다. 이 사용자는 **디자인 배포(stage=design) 리소스만 운영**할 수 있다.
> 코드 배포(`cdk deploy`)는 할 수 없고, 다른 stage(계정 주인의 `Hariesse*` 스택, `/hariesse/*` 설정)는 보이지도 않는다.
> 코드를 고치고 싶으면 브랜치에 커밋해 PR을 올리고 계정 주인이 배포한다.

## 0. 이 시스템이 하는 일

매일 **07:00 KST**에 디자인 블로그/YouTube/Reddit에서 새 글을 모아 Bedrock(Claude)이 점수·요약·추천이유를 쓰고,
점수 높은 2~4건을 **Telegram**으로 보낸다. 메시지마다 버튼 `[👍 좋아요][⭐ 사이트 좋아요][💾 nadeliv 글감][⏭ 건너뛰기]`가 있고,
누르면 소스 가중치와 관심사가 학습된다. Notion 아카이브는 선택 사항이다(설정 안 하면 건너뜀).

## 1. 자격증명 / 환경

계정 주인에게서 받은 액세스 키를 로컬 프로파일로 저장한다. 키 값은 채팅에 쓰지 말고 터미널에서만 다룬다.

```bash
aws configure --profile hariesse-design
# AWS Access Key ID / Secret Access Key 입력, region: ap-northeast-2, output: json
export AWS_PROFILE=hariesse-design AWS_REGION=ap-northeast-2
aws sts get-caller-identity   # Arn 끝이 user/hariesse-design-operator 이면 OK
```

리포 준비 (Node 20+):

```bash
git clone https://github.com/BongjoonKim/hariesse.git && cd hariesse
npm install && npm run build && npm test
```

## 2. 이름 규칙 (전부 `design` 접두어)

| 종류 | 이름 |
|---|---|
| CloudFormation 스택 | `HariesseDesignData`, `HariesseDesignPipeline`, `HariesseDesignApi`, `HariesseDesignOperator` |
| SSM 파라미터 | `/hariesse-design/<key>` |
| Secrets Manager | `hariesse-design/<name>` |
| 테이블/함수 이름 | 스택 Outputs에서 조회 (아래) |

Outputs 조회(테이블 이름, 함수 이름, 상태머신 ARN, Feedback URL):

```bash
aws cloudformation describe-stacks --stack-name HariesseDesignData --query 'Stacks[0].Outputs' --output table
aws cloudformation describe-stacks --stack-name HariesseDesignPipeline --query 'Stacks[0].Outputs' --output table
aws cloudformation describe-stacks --stack-name HariesseDesignApi --query 'Stacks[0].Outputs' --output table
```

## 3. 최초 설정 (순서대로)

### 3-1. Telegram 봇

1. 사용자의 Telegram에서 `@BotFather` → `/newbot` → 봇 이름/아이디 입력 → **봇 토큰**을 받는다.
2. 토큰을 Secrets에 저장:
   ```bash
   aws secretsmanager create-secret --name hariesse-design/telegram-bot-token --secret-string '<봇 토큰>'
   ```
3. 사용자가 그 봇에게 아무 메시지나 보낸 뒤, 대화방 ID를 확인한다:
   ```bash
   curl -s "https://api.telegram.org/bot<봇 토큰>/getUpdates" | python3 -c 'import sys,json; [print(u["message"]["chat"]["id"], u["message"]["chat"].get("first_name")) for u in json.load(sys.stdin)["result"] if "message" in u]'
   ```
   **주의**: 봇 자신의 ID(토큰 앞부분 숫자)가 아니라 **사용자 대화방의 chat id**여야 한다. 잘못 넣으면 전송 시 403.
4. chat id 저장:
   ```bash
   aws ssm put-parameter --name /hariesse-design/telegram-chat-id --type String --value '<chat id>' --overwrite
   ```

### 3-2. 피드백 버튼(webhook) 연결

```bash
SECRET=$(openssl rand -hex 24)
aws secretsmanager create-secret --name hariesse-design/telegram-webhook-secret --secret-string "$SECRET"
URL=$(aws cloudformation describe-stacks --stack-name HariesseDesignApi --query "Stacks[0].Outputs[?OutputKey=='FeedbackUrl'].OutputValue" --output text)
curl -s -X POST "https://api.telegram.org/bot<봇 토큰>/setWebhook" \
  -H 'Content-Type: application/json' \
  -d "{\"url\":\"$URL\",\"secret_token\":\"$SECRET\",\"allowed_updates\":[\"callback_query\"]}"
curl -s "https://api.telegram.org/bot<봇 토큰>/getWebhookInfo"   # url이 Function URL이면 OK
```

### 3-3. Bedrock 모델과 기본 설정

같은 계정이라 모델 접근은 이미 열려 있다. 검증된 모델 ID를 그대로 쓴다.

```bash
aws ssm put-parameter --name /hariesse-design/bedrock-model-id --type String --overwrite \
  --value 'global.anthropic.claude-sonnet-4-5-20250929-v1:0'
aws ssm put-parameter --name /hariesse-design/bedrock-region --type String --overwrite --value 'ap-northeast-2'
# 큐레이션에 넣을 사용자 소개 — 어떤 디자인을 하는 사람인지 한두 문장. 평가 기준이 이걸로 바뀐다.
aws ssm put-parameter --name /hariesse-design/user-persona --type String --overwrite \
  --value '사용자는 UX/UI 디자이너다. Figma, 디자인 시스템, 타이포그래피, 브랜딩, 포트폴리오 사례에 관심이 많고 개발 세부사항보다 디자인 관점의 글을 선호한다.'
```

선택(기본값으로 시작해도 됨): `digest-size`(4) / `digest-min-size`(2) / `digest-min-score`(70) /
`exploration-ratio`(0.3, **0으로 만들지 말 것** — 새로운 소스를 섞는 비율) / `daily-bedrock-cap`(50) / `daily-curate-cap`(40).

### 3-4. Notion (선택)

안 쓰면 이 절은 건너뛴다. 쓰려면 사용자 Notion 워크스페이스에서 통합(integration) 토큰을 만들고,
`제목(title) · URL(url) · 카테고리(select) · 소스(select) · 추천점수(number) · 상태(select) · 요약(rich_text) · 추천이유(rich_text) · 태그(multi_select) · nadeliv 글감(checkbox)`
속성을 가진 데이터베이스를 만들어 통합을 연결한 뒤:

```bash
aws secretsmanager create-secret --name hariesse-design/notion-token --secret-string '<notion 토큰>'
aws ssm put-parameter --name /hariesse-design/notion-database-id --type String --overwrite --value '<database id>'
```

### 3-5. 소스 시드

```bash
SOURCES_TABLE=$(aws cloudformation describe-stacks --stack-name HariesseDesignData --query "Stacks[0].Outputs[?OutputKey=='SourcesTableName'].OutputValue" --output text)
PROFILE_TABLE=$(aws cloudformation describe-stacks --stack-name HariesseDesignData --query "Stacks[0].Outputs[?OutputKey=='ProfileTableName'].OutputValue" --output text)
SOURCES_TABLE=$SOURCES_TABLE PROFILE_TABLE=$PROFILE_TABLE npm run seed:design
```

`seed:design`은 UX/UI·그래픽·브랜드 소스 22건(블로그 10, YouTube 8, Reddit 4)과 디자인 Profile을 넣는다.
**공간 디자이너**라면 대신 `npm run seed:space` — 공간·건축·가구·공간 브랜딩 소스 21건(블로그 11, YouTube 8, Reddit 2)과 공간 Profile.
둘 중 하나만 고를 것: Profile은 처음 한 번만 들어가서, 나중에 다른 세트를 돌려도 관심사가 바뀌지 않는다.
재실행해도 기존 소스의 가중치는 덮지 않는다.

> Windows PowerShell 5.1에서 한글 값을 `aws ssm put-parameter --value '...'`로 넣으면 깨져서 저장된다.
> UTF-8 JSON 파일을 만들고 `$env:AWS_CLI_FILE_ENCODING='UTF-8'; aws ssm put-parameter --cli-input-json file://persona.json`으로 넣을 것.

### 3-6. 첫 실행으로 검증

```bash
SM=$(aws cloudformation describe-stacks --stack-name HariesseDesignPipeline --query "Stacks[0].Outputs[?OutputKey=='StateMachineArn'].OutputValue" --output text)
aws stepfunctions start-execution --state-machine-arn "$SM"
# 10~15분 뒤
aws stepfunctions list-executions --state-machine-arn "$SM" --max-results 1
```

성공이면 Telegram에 다이제스트가 온다. 첫 실행은 수집량이 많아 시간이 걸린다.

## 4. 평소 운영

- **소스 추가** (저장 전에 피드 생존 확인, `--dry-run`이면 AWS 없이 검증만):
  ```bash
  SOURCES_TABLE=$SOURCES_TABLE npm run add-source -- --type youtube --url @somechannel --category design
  SOURCES_TABLE=$SOURCES_TABLE npm run add-source -- --type reddit --url r/typography --category design
  SOURCES_TABLE=$SOURCES_TABLE npm run add-source -- --type blog --url https://example.com/feed --name "예시" --category design
  ```
- **설정 변경 후 반영**: Lambda가 SSM 값을 콜드스타트에 캐시한다. 값을 바꾼 뒤엔 함수 설정을 건드려 콜드스타트를 강제한다.
  ```bash
  for FN in CollectFunctionName CurateFunctionName DeliverFunctionName; do
    NAME=$(aws cloudformation describe-stacks --stack-name HariesseDesignPipeline --query "Stacks[0].Outputs[?OutputKey=='$FN'].OutputValue" --output text)
    aws lambda update-function-configuration --function-name "$NAME" --description "config-reload $(date +%s)" >/dev/null
  done
  ```
- **로그**: `aws logs tail /aws/lambda/<함수 이름> --since 1h`
- **수동 실행**: 3-6과 같다.

## 5. 하지 말 것 / 안 되는 것

- `cdk deploy`, `cdk destroy`: 권한 없음. 코드 변경은 PR로.
- `/hariesse/*`, `hariesse/*`, `Hariesse*`(접두어 없는 이름): 계정 주인의 것. 접근 불가이며 시도하지 말 것.
- 테이블을 지우거나 비우지 말 것. 피드백으로 쌓인 가중치가 사라진다.
- `exploration-ratio`를 0으로 두지 말 것. 소스가 에코챔버가 된다.
- Reddit은 익명 요청이 금방 429가 난다. 수집 간격은 코드에 있고 줄일 수 없다(권한도 없다).
