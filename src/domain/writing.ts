import { normalizeVocabKey, compactPageId } from './vocab';
import type { WritingEnrichment, WritingEntry, WritingStatus } from '../lib/types';

/**
 * TOEFL Writing 문장 연습 도메인 로직 (순수함수, 테스트 대상).
 * - 사용자가 교재의 "한국어 → 영어로 쓰기" 연습을 하며 쓴 영어 문장을 Notion "TOEFL Writing" DB에 적는다.
 * - Bedrock이 ① 문제로 쓸 한국어 뜻 ② 문법·철자를 고친 문장을 만든다. 고친 문장은 `문장` 칸에 **덮어쓴다** —
 *   문장의 오류는 타이핑 실수라서 쓴 것과 고친 것을 따로 두지 않는다(사용자 결정 2026-11-13). 무엇을 고쳤는지는 `메모`에만 남는다.
 * - 매일 낮에 N문장씩 출제: 한국어만 보여 주고 영어 정답은 스포일러. 버튼·채점은 없다 — 혼자 써 보는 연습이라 그렇다.
 * - 출제 순서는 덜 나온 문장부터(출제 횟수 → 마지막 출제 → 추가 순). 전부 한 바퀴 돌면 처음부터 다시.
 * - 원본 저장소는 Notion DB. 여기는 Notion 형식을 모른다 (매핑은 lib/notion-writing.ts).
 */

export { compactPageId };

/** dedup 키 — 단어장과 같은 규칙 (소문자·공백·앞뒤 문장부호 정규화) */
export const normalizeWritingKey = normalizeVocabKey;

export const WRITING_STATUS_LABEL: Record<WritingStatus, string> = {
  new: '새로 추가',
  active: '출제 중',
  excluded: '제외',
};

/**
 * 채워야 하는 행: 문장이 있고, 제외가 아니며, 상태가 비었거나(Notion에 직접 입력) '새로 추가'거나 한국어가 빈 것.
 * 채운 뒤에는 핸들러가 상태를 '출제 중'으로 바꿔야 한다 — 안 그러면 매 실행마다 같은 행을 또 채운다.
 */
export function needsWritingEnrichment(entry: Pick<WritingEntry, 'text' | 'status' | 'korean'>): boolean {
  if (entry.text.trim() === '' || entry.status === 'excluded') return false;
  return entry.status === undefined || entry.status === 'new' || !entry.korean?.trim();
}

/**
 * 고친 문장이 사용자 문장과 실제로 다른지 — 다르면 그 문장을 돌려준다(이걸로 `문장`을 덮어쓴다).
 * 대소문자·문장부호만 다른 것도 고친 것으로 친다: 어차피 한 칸에 저장하니 제대로 된 문장으로 두는 게 낫다. 순수함수.
 */
export function detectWritingCorrection(text: string, corrected: string | undefined): string | undefined {
  const c = corrected?.trim();
  if (!c || c === text.trim()) return undefined;
  return c;
}

export type WritingEnrichedFields = Pick<WritingEntry, 'korean' | 'note'>;

/**
 * Bedrock 결과로 빈 칸만 채운다. 사용자가 Notion에 직접 쓴 한국어·메모는 절대 덮어쓰지 않는다. 순수함수.
 */
export function fillWritingFromEnrichment(current: WritingEnrichedFields, e: Pick<WritingEnrichment, 'korean' | 'note'>): WritingEnrichedFields {
  const pick = (mine: string | undefined, theirs: string | undefined) => mine?.trim() || theirs;
  return {
    korean: pick(current.korean, e.korean),
    note: pick(current.note, e.note),
  };
}

export type WritingEnrichmentUpdate = WritingEnrichedFields & Pick<WritingEntry, 'key' | 'status' | 'quizCount'> & { text?: string };

/**
 * 채운 결과로 Notion에 쓸 필드. 고친 문장이 있으면 `문장`과 `키`를 그걸로 바꾼다(없으면 `문장`은 건드리지 않는다).
 * 상태는 '출제 중'으로 — '새로 추가'로 두면 다음 실행 때 또 채우기 대상이 된다. 순수함수.
 */
export function applyWritingEnrichment(
  entry: Pick<WritingEntry, 'text' | 'key' | 'korean' | 'note' | 'quizCount'>,
  e: WritingEnrichment
): WritingEnrichmentUpdate {
  const corrected = detectWritingCorrection(entry.text, e.corrected);
  const finalText = corrected ?? entry.text;
  return {
    ...fillWritingFromEnrichment(entry, e),
    ...(corrected ? { text: corrected } : {}),
    key: corrected ? normalizeWritingKey(finalText) : entry.key ?? normalizeWritingKey(finalText),
    status: 'active',
    quizCount: entry.quizCount,
  };
}

/**
 * 오늘 낼 문장: 한국어가 있고 제외가 아닌 것 중 출제 횟수가 적은 순 → 마지막 출제가 오래된 순(한 번도 안 나온 것 먼저)
 * → 추가 순(추가일 → 출처 안 번호). 입력 배열은 Notion이 추가일 순으로 준 것이라 안정 정렬에 기댄다. 순수함수.
 */
export function pickQuizEntries(entries: WritingEntry[], limit: number): WritingEntry[] {
  return entries
    .filter((e) => e.status !== 'excluded' && Boolean(e.korean?.trim()) && e.text.trim() !== '')
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      if (a.e.quizCount !== b.e.quizCount) return a.e.quizCount - b.e.quizCount;
      const la = a.e.lastQuizzed ?? '';
      const lb = b.e.lastQuizzed ?? '';
      if (la !== lb) return la < lb ? -1 : 1;
      return a.i - b.i;
    })
    .slice(0, Math.max(0, limit))
    .map(({ e }) => e);
}

export type QuizSentFields = Pick<WritingEntry, 'quizCount' | 'lastQuizzed' | 'status'>;

/** 출제했을 때 바뀌는 필드만 (Notion PATCH가 사용자가 손댄 칸을 다시 쓰지 않게). */
export function applyQuizSent(entry: Pick<WritingEntry, 'quizCount'>, today: string): QuizSentFields {
  return { quizCount: entry.quizCount + 1, lastQuizzed: today, status: 'active' };
}
