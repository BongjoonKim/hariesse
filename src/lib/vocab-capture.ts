import { enrichVocab } from './bedrock';
import { findVocabByKey, createVocabPage, updateVocabPage, type VocabFields } from './notion-vocab';
import {
  normalizeVocabKey,
  fillFromEnrichment,
  detectSpellingCorrection,
  stripSpellingNote,
  initialReview,
  applyRepeatCapture,
  type VocabInput,
} from '../domain/vocab';
import type { VocabEnrichment, VocabEntry, VocabKind, VocabOrigin } from './types';

/**
 * 표현 1건 저장 — Telegram(VocabFn)과 웹(WebFn)이 같이 쓴다.
 * 이미 있으면 헷갈린 횟수 +1, 없으면 Bedrock으로 빈 칸을 채워 Notion에 새 행.
 * 오타는 고친 철자로 저장한다(원문은 남기지 않는다). 알림(Telegram 카드 등)은 호출한 쪽 몫.
 */

export interface CaptureDeps {
  modelId: string;
  region: string;
  notionToken: string;
  databaseId: string;
}

export interface CaptureOutcome {
  entry: VocabEntry;
  /** 이미 있던 표현 (헷갈린 횟수만 올림) */
  repeated: boolean;
  /** "✏️ 철자 교정: a → b" — 새로 저장하면서 철자를 고쳤을 때만 */
  spelling?: string;
}

/** Bedrock 단어 응답. 실패해도 저장은 계속하도록 undefined. */
export async function tryEnrich(
  deps: Pick<CaptureDeps, 'modelId' | 'region'>,
  text: string,
  kind: VocabKind,
  userMeaning: string | undefined
): Promise<VocabEnrichment | undefined> {
  try {
    return await enrichVocab(deps.modelId, deps.region, text, kind, userMeaning);
  } catch (err) {
    console.warn(`vocab enrich 실패 "${text}": ${(err as Error).message}`);
    return undefined;
  }
}

export async function captureExpression(
  deps: CaptureDeps,
  input: VocabInput,
  today: string,
  origin: VocabOrigin
): Promise<CaptureOutcome> {
  // 이미 있는 표현이면 헷갈린 횟수 +1 (철자를 고친 결과가 이미 있는 표현일 때도 같다)
  const repeat = async (existing: VocabEntry): Promise<CaptureOutcome> => {
    const fields = {
      ...applyRepeatCapture(existing, today),
      tags: [...new Set([...existing.tags, ...input.tags])],
    };
    await updateVocabPage(deps.notionToken, existing.pageId, fields);
    return { entry: { ...existing, ...fields }, repeated: true };
  };

  const existing = await findVocabByKey(deps.notionToken, deps.databaseId, normalizeVocabKey(input.text));
  if (existing) return repeat(existing);

  const e = await tryEnrich(deps, input.text, input.kind, input.meaning);
  // 오타가 있으면 고친 철자로 저장한다. 사용자가 `::`로 직접 쓴 뜻은 그대로 둔다.
  const correction = e ? detectSpellingCorrection(input.text, e) : undefined;
  if (correction) {
    const dup = await findVocabByKey(deps.notionToken, deps.databaseId, correction.key);
    if (dup) {
      console.log(`vocab capture: "${input.text}" → "${correction.text}" 은 이미 있는 표현`);
      return repeat(dup);
    }
  }
  const enriched = e ? fillFromEnrichment({ meaning: input.meaning }, e) : undefined;
  if (enriched) enriched.note = stripSpellingNote(enriched.note);
  const fields: VocabFields = {
    text: correction?.text ?? input.text,
    key: correction?.key ?? normalizeVocabKey(input.text),
    kind: correction?.kind ?? input.kind,
    tags: input.tags,
    origin,
    ...(enriched ?? { meaning: input.meaning }),
    ...initialReview(today),
    // 뜻 채우기에 실패하면 '새로 추가'로 두고 다음 복습 실행 때 다시 채운다
    status: enriched ? 'learning' : 'new',
  };
  if (correction) console.log(`vocab capture: 철자 교정 "${input.text}" → "${correction.text}"`);
  const pageId = await createVocabPage(deps.notionToken, deps.databaseId, fields);
  const entry: VocabEntry = { pageId, tags: [], box: 0, missCount: 0, text: fields.text!, createdDate: today, ...fields };
  return { entry, repeated: false, spelling: correction?.label };
}
