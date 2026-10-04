import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import type { Curation, LessonContent, SourceType } from './types';
import { AREA_LABEL } from '../domain/curriculum';
import type { LessonPlan } from '../domain/learning';

let client: BedrockRuntimeClient | undefined;
function getClient(region: string): BedrockRuntimeClient {
  if (!client) client = new BedrockRuntimeClient({ region });
  return client;
}

export interface CurateInput {
  title: string;
  url: string;
  category: string;
  bodyText: string;
  interests: Record<string, number>;
  sourceType?: SourceType;
  /** 사용자 소개(SSM user-persona). 있으면 평가 기준의 맥락으로 넣는다. */
  persona?: string;
}

/** 소스 종류별 평가 맥락 — 본문의 성격이 달라서 그냥 두면 점수가 왜곡된다. */
const SOURCE_HINT: Partial<Record<SourceType, string>> = {
  youtube:
    'YouTube 영상이다. 본문은 영상 설명글이라 짧을 수 있으니, 분량이 아니라 주제 자체의 가치로 평가하라. 요약은 "이 영상이 다루는 내용"으로 써라.',
  reddit:
    'Reddit에서 상위 노출된 글이다. 커뮤니티가 주목했다는 신호를 감안하되, 낚시성 제목이면 점수를 낮춰라.',
};

const SYSTEM_PROMPT = `너는 사용자의 개인 콘텐츠 비서다. 글을 읽고 사용자 취향과의 적합도를 평가한다.
단순 패턴매칭이 아니라, "취향엔 안 맞지만 알 가치가 있는지"까지 판단해 추천이유(aiOpinion)에 담아라.
반드시 아래 JSON 스키마만 출력하고, 그 외 텍스트는 절대 출력하지 마라.
{"score": <0~100 정수>, "summary": "<한국어 3줄 요약>", "aiOpinion": "<추천이유 1~2문장, AI 의견 포함>", "tags": ["<키워드>", ...]}`;

function buildUserPrompt(input: CurateInput): string {
  const interests = Object.entries(input.interests)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}(${v})`)
    .join(', ');
  const body = input.bodyText.slice(0, 6000);
  const hint = input.sourceType ? SOURCE_HINT[input.sourceType] : undefined;
  const persona = input.persona?.trim();
  return `${persona ? `사용자 소개: ${persona}\n` : ''}사용자 관심사(가중치): ${interests || '없음'}
카테고리: ${input.category}${hint ? `\n소스 특성: ${hint}` : ''}
제목: ${input.title}
URL: ${input.url}

본문(일부):
"""
${body}
"""

위 글을 평가해 JSON으로만 답하라.`;
}

/** 응답 텍스트에서 첫 '{'~마지막 '}'를 JSON으로 파싱. */
function parseJsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error(`Bedrock 응답에 JSON 없음: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start, end + 1));
}

function extractJson(text: string): Curation {
  const parsed = parseJsonObject(text);
  return {
    score: Math.max(0, Math.min(100, Math.round(Number(parsed.score) || 0))),
    summary: String(parsed.summary ?? '').trim(),
    aiOpinion: String(parsed.aiOpinion ?? '').trim(),
    tags: Array.isArray(parsed.tags) ? parsed.tags.map(String).slice(0, 8) : [],
  };
}

async function invokeClaude(
  modelId: string,
  region: string,
  system: string,
  user: string,
  maxTokens: number
): Promise<string> {
  const body = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  };

  const res = await getClient(region).send(
    new InvokeModelCommand({
      modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(body),
    })
  );

  const payload = JSON.parse(new TextDecoder().decode(res.body));
  return payload?.content?.[0]?.text ?? '';
}

export async function curateArticle(
  modelId: string,
  region: string,
  input: CurateInput
): Promise<Curation> {
  const text = await invokeClaude(modelId, region, SYSTEM_PROMPT, buildUserPrompt(input), 1024);
  return extractJson(text);
}

// ---------------------------------------------------------------- 학습 레슨

const LESSON_SYSTEM_PROMPT = `너는 hariesse, 사용자의 개인 기술 튜터다.
사용자는 TypeScript + AWS CDK + Lambda로 개인 서버리스 프로젝트를 운영하는 개발자이고,
AI 코딩 도구를 더 잘 부리기 위해 클라우드·백엔드·프론트엔드·CI/CD 기본기를 매일 조금씩 쌓고 있다.
목표는 "AI가 짠 코드를 이해하고, 틀린 걸 알아보고, 더 정확하게 지시할 수 있는 수준"이다.

작성 원칙:
- 한국어로, 출퇴근길 휴대폰으로 5분 안에 읽을 분량. 용어는 처음 나올 때 영어 원어를 괄호로.
- 추상적 설명보다 "왜 필요한가 → 어떻게 동작하나 → 실제로 어떻게 쓰나" 순서.
- 예제 코드는 그대로 복사해 돌려볼 수 있는 최소 예제(25줄 이하). 없는 옵션·API를 지어내지 마라. 확실하지 않으면 예제를 단순하게.
- URL은 절대 쓰지 마라 (참고 링크는 시스템이 따로 붙인다).
- 반드시 아래 JSON 스키마만 출력하고, 그 외 텍스트는 절대 출력하지 마라.
{"summary": "<한 줄 요약>",
 "concept": "<핵심 개념 설명, 3~6문장>",
 "whyItMatters": "<실무·AI 활용 관점에서 왜 중요한지, 2~3문장>",
 "keyPoints": ["<꼭 기억할 포인트>", ...3~5개],
 "example": {"lang": "<yaml|bash|groovy|javascript|typescript|python|json|dockerfile|tsx>", "code": "<코드>", "note": "<예제 설명 1~2문장>"},
 "aiTip": "<AI 코딩 도구에게 이 주제로 일을 시킬 때 쓸 프롬프트 예시 1개 + AI 결과물에서 꼭 검증할 점>",
 "practice": "<10분 안에 해볼 수 있는 실습 과제>",
 "quiz": {"question": "<이해 확인 질문 1개>", "answer": "<정답과 짧은 해설>"}}`;

const MODE_HINT: Record<LessonPlan['mode'], string> = {
  normal: '처음 배우는 사람 기준으로 설명하라.',
  easier:
    '사용자가 지난번 설명을 어려워했다. 비유를 먼저 들고, 전문용어를 줄이고, 한 번에 한 개념씩 더 쉽게 다시 설명하라. 예제는 더 짧게.',
  deep:
    '사용자는 이 레슨을 한 번 배웠다. 기본 설명은 짧게 복습만 하고, 실무에서 자주 겪는 함정·트레이드오프·운영 관점의 심화 내용을 다뤄라.',
};

export function buildLessonPrompt(plan: LessonPlan): string {
  const { track, lesson } = plan;
  const prev = plan.previousTitles.length
    ? plan.previousTitles.map((t, i) => `${i + 1}. ${t}`).join('\n')
    : '(이 트랙의 첫 레슨)';
  return `트랙: ${track.name} (${AREA_LABEL[track.area]})
레슨 ${plan.index + 1}/${track.lessons.length}: ${lesson.title}
반드시 다룰 포인트:
${lesson.points.map((p) => `- ${p}`).join('\n')}

이 트랙에서 이미 배운 레슨 (중복 설명하지 말고 이어서):
${prev}

난이도: ${MODE_HINT[plan.mode]}

JSON으로만 답하라.`;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** Bedrock 응답 → LessonContent. 필수 필드가 비면 throw (빈 레슨을 보내느니 실패가 낫다). 순수함수. */
export function parseLessonContent(text: string): LessonContent {
  const p = parseJsonObject(text);
  const example = p.example as Record<string, unknown> | undefined;
  const quiz = p.quiz as Record<string, unknown> | undefined;
  const content: LessonContent = {
    summary: str(p.summary),
    concept: str(p.concept),
    whyItMatters: str(p.whyItMatters),
    keyPoints: Array.isArray(p.keyPoints) ? p.keyPoints.map(str).filter(Boolean).slice(0, 6) : [],
    aiTip: str(p.aiTip),
    practice: str(p.practice),
  };
  if (example && str(example.code)) {
    content.example = {
      lang: str(example.lang) || 'text',
      code: String(example.code).replace(/\s+$/, ''),
      note: str(example.note) || undefined,
    };
  }
  if (quiz && str(quiz.question) && str(quiz.answer)) {
    content.quiz = { question: str(quiz.question), answer: str(quiz.answer) };
  }
  if (!content.concept || content.keyPoints.length === 0) {
    throw new Error(`레슨 응답에 필수 필드 없음: ${text.slice(0, 200)}`);
  }
  return content;
}

export async function writeLesson(
  modelId: string,
  region: string,
  plan: LessonPlan
): Promise<LessonContent> {
  const text = await invokeClaude(modelId, region, LESSON_SYSTEM_PROMPT, buildLessonPrompt(plan), 3000);
  return parseLessonContent(text);
}
