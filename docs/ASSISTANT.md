# hariesse 비서 기능 — 설계와 로드맵

> 콘텐츠 큐레이션(기존)에 **할일·일정**을 얹어 "진짜 비서"로 만드는 계획.
> Phase A는 구현·머지 완료. B/C/D는 이 문서가 설계 기준이다.

## 0. 핵심 판단 — 무엇을 어디에 두는가

요청에 두 가지가 섞여 있는데, 성격이 달라서 **소스 오브 트루스를 나누는 게 맞다.**

| | 예 | 소스 오브 트루스 | 이유 |
|---|---|---|---|
| **반복 루틴** | "월요일엔 토플 Reading·Listening" | **hariesse** | 요일 규칙 + 완료 체크 + 스트릭이 필요하다. 캘린더는 이걸 잘 못 한다 |
| **일정(약속·회의)** | "금 14:00 미팅" | **Google Calendar** | 캘린더 앱은 이미 충분히 좋다. 다시 만들 이유가 없다 |

그래서 hariesse는 **루틴을 소유하고, 캘린더는 읽어와 합친다.** 반대로 루틴 중 원하는 것만
전용 캘린더로 내보낸다(선택). 이 경계를 흐리면 "어디에 등록했더라" 문제가 바로 생긴다.

---

## 1. Phase A — 하루 3회 브리핑 ✅ 구현 완료

웹 없이도 즉시 동작하는 최소 루프. `09:00 / 12:00 / 20:00 KST`에 Telegram으로 온다.

```
EventBridge(3개 규칙, slot만 다름) → BriefFn
   → ensureDayPlan(오늘): 루틴을 그날 할일로 전개 (조건부 put = idempotent)
   → 슬롯별 노출 대상 계산 → Telegram 1건 + 항목별 [✅][⏭] 버튼
버튼 클릭 → 기존 Feedback Lambda(webhook) → 상태 변경 → 같은 메시지 즉시 다시 그림
```

**데이터 모델** — `Tasks` 테이블 하나 (pk/sk):

```
pk="ROUTINE"           sk=<routineId>   루틴 정의 (영구 보존)
pk="DAY#2026-09-07"    sk=<routineId>   그날 할일 (TTL 365일)
                       sk="x<8hex>"     단건(adhoc) 할일
```

하루치 조회가 pk 하나로 끝난다. GSI 불필요.

**슬롯별 성격**
- 09:00 아침 — 오늘 할일 **전부** (상태 무관). 하루의 기준점이라 할일이 없어도 보낸다.
- 12:00 점심 — **아직 안 한 것만**. 진행률 표시.
- 20:00 저녁 — 남은 것 + 오늘 진행률 + **내일 미리보기**.
- 할일이 아예 없는 날은 점심/저녁을 **보내지 않는다** (알림 피로 방지).

**설계 메모**
- `callback_data`는 `t1|toggle|20260907|m|a1b2c3d4` (29B) — 다이제스트 피드백 `v1|…`과 prefix로 갈린다.
  슬롯을 실어야 버튼을 누른 뒤 **같은 메시지를 그대로 다시 그릴 수** 있다.
- 다시 그릴 목록은 원본 메시지의 키보드에 실린 sk 순서를 그대로 쓴다 → 눌러도 목록이 재배치되지 않는다.
- 체크는 토글이다. 잘못 누르면 같은 버튼으로 되돌아온다 (다이제스트 피드백의 1회성 마커와 다른 정책 — 할일은 상태 대입이라 여러 번 눌러도 안전).
- 한국은 서머타임이 없어 KST→UTC는 `-9시간` 고정 환산이면 정확하다. EventBridge cron은 UTC.

**알려진 제약 (Phase B에서 해소)**
- 루틴을 고쳐도 **이미 전개된 그날 할일에는 반영되지 않는다** (`putTaskIfNew`가 기존 아이템을 보존 —
  체크해 둔 상태를 덮어쓰지 않기 위한 의도된 동작). 저녁 브리핑이 내일치를 미리 전개하므로
  "오늘 저녁에 고친 루틴이 내일 아침에 안 보인다"가 될 수 있다. 웹 UI에서 루틴을 저장할 때
  아직 `todo`인 미래 아이템만 다시 전개하면 해결된다.
- 루틴 등록이 `scripts/seed-routines.ts` 편집 → 재실행뿐이다. 이게 Phase B가 필요한 이유.

---

## 2. Phase B — 웹 관리 UI (CloudFront)

### 구성

```
CloudFront (배포 1개)
 ├── 기본 behavior  → S3(비공개) + OAC : SPA 정적 파일
 └── /api/*        → API Gateway HTTP API → TasksApiFn (Lambda)
```

**같은 배포에 API를 붙이는 이유**: 동일 오리진이 되어 CORS가 사라지고, 세션 쿠키를
`HttpOnly; Secure; SameSite=Lax`로 안전하게 쓸 수 있다. 도메인 하나만 관리하면 된다.

### 인증 — Cognito 말고 Google OAuth 직접

1인용이고, **어차피 Google Calendar refresh token이 필요하다.** 로그인 한 번으로
신원 확인과 캘린더 권한을 같이 받는 게 부품이 가장 적다. (Slack 대신 Telegram을 고른 것과 같은 판단.)

- Authorization Code + PKCE를 API Lambda가 직접 처리
- 허용 이메일은 SSM `/hariesse/allowed-email` — 그 외 계정은 거부
- 세션: HS256 JWT(수명 12h)를 HttpOnly 쿠키에. 서명키는 Secrets `hariesse/session-secret`
- Google refresh token은 Secrets `hariesse/google-oauth`에 저장 (1인용이라 단일 시크릿으로 충분)

> Cognito는 사용자 풀·그룹·MFA가 필요해질 때 옮기면 된다. 지금은 순수 비용(설정 + 토큰 중계).

### API (전부 `/api` 아래, 세션 쿠키 필수)

| 메서드 | 경로 | 하는 일 |
|---|---|---|
| GET | `/routines` | 루틴 목록 |
| POST | `/routines` | 루틴 생성 (`newId()`로 8hex) |
| PUT/DELETE | `/routines/{id}` | 수정 / 삭제 |
| GET | `/days/{date}` | `ensureDayPlan` 후 그날 할일 |
| POST | `/days/{date}/tasks` | 단건(adhoc) 추가 |
| PATCH | `/days/{date}/tasks/{sk}` | 상태 변경 |
| GET | `/auth/login`, `/auth/callback` · POST `/auth/logout` | Google OAuth |

핵심 로직(`src/lib/tasks.ts`, `src/domain/routine.ts`)은 **이미 Telegram 경로와 공용**이다.
API Lambda는 얇은 HTTP 껍데기만 새로 쓰면 된다.

### 화면 (Vite + React + TS, `web/`)

1. **오늘** — 체크리스트, 진행률. Telegram 버튼과 같은 상태를 본다.
2. **주간 루틴** — 요일 × 루틴 그리드. 여기서 "월요일 = 토플 Reading, Listening"을 등록.
3. **캘린더** — 월 뷰 (Phase C에서 Google 일정 병합)

배포: `npm run build:web` → `BucketDeployment` + CloudFront invalidation. 새 스택 `HariesseWeb`.
커스텀 도메인은 나중에 Route53 + ACM(**us-east-1** 인증서) 추가.

---

## 3. Phase C — Google Calendar 연동

**읽기는 Google → hariesse, 쓰기는 루틴만 hariesse → Google.**

- Scope: `openid email profile https://www.googleapis.com/auth/calendar.events`
- **읽기**: `events.list(timeMin, timeMax, singleEvents=true, orderBy=startTime)`
  → 브리핑 맨 위 `📅 오늘 일정` 섹션 + 웹 캘린더 뷰
- **쓰기(선택)**: 루틴에 `syncToCalendar` 플래그. **"hariesse" 전용 캘린더를 따로 만들어 거기에만 쓴다**
  → 메인 캘린더가 루틴으로 도배되지 않고, 통째로 껐다 켤 수 있다
- **멱등성**: `extendedProperties.private.hariesseKey = "<date>#<sk>"`로 조회 후 upsert
  (Notion의 URL 기준 upsert와 같은 패턴). 완료하면 제목 앞에 `✅`를 붙여 갱신
- **토큰**: refresh token은 Secrets, access token은 Lambda 메모리 캐시(만료 60초 전 갱신)
- **장애 격리**: 캘린더 호출이 실패해도 할일 섹션만으로 브리핑을 보낸다.
  Google이 죽었다고 브리핑이 안 오면 안 된다

---

## 4. Phase D — 여기까지 오면 "비서"

- **자연어 등록**: Telegram에 "매주 화 8시 헬스" → Bedrock으로 파싱 → 루틴 생성
  (webhook `allowed_updates`에 `message` 추가 필요)
- **저녁 회고 한 줄**: Bedrock이 완료율·패턴을 보고 코멘트 (기존 `aiOpinion` 프롬프트와 같은 결)
- **스트릭 / 주간 리포트**: 일요일 저녁에 이번 주 달성률
- **다이제스트 통합**: 아침 브리핑에 "오늘의 읽을거리 1건" 얹기
  (지금은 07:00 다이제스트와 09:00 브리핑이 분리되어 있다 — 캡·실패 반경이 다르므로 의도된 분리)

---

## 5. 비용

CloudFront 프리티어(월 1TB), S3·Lambda·DynamoDB on-demand는 개인 사용량에서 월 몇 달러 미만,
Google Calendar API 무료. 여전히 최대 변수는 Bedrock이고 일일 캡이 걸려 있다.
브리핑 자체는 Bedrock을 쓰지 않는다 (템플릿 렌더링 — 결정적이고 공짜).
