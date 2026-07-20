import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import type { Curation } from './types';

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
}

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
  return `사용자 관심사(가중치): ${interests || '없음'}
카테고리: ${input.category}
제목: ${input.title}
URL: ${input.url}

본문(일부):
"""
${body}
"""

위 글을 평가해 JSON으로만 답하라.`;
}

function extractJson(text: string): Curation {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error(`Bedrock 응답에 JSON 없음: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(text.slice(start, end + 1));
  return {
    score: Math.max(0, Math.min(100, Math.round(Number(parsed.score) || 0))),
    summary: String(parsed.summary ?? '').trim(),
    aiOpinion: String(parsed.aiOpinion ?? '').trim(),
    tags: Array.isArray(parsed.tags) ? parsed.tags.map(String).slice(0, 8) : [],
  };
}

export async function curateArticle(
  modelId: string,
  region: string,
  input: CurateInput
): Promise<Curation> {
  const body = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserPrompt(input) }],
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
  const text: string = payload?.content?.[0]?.text ?? '';
  return extractJson(text);
}
