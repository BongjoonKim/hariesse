import type { VocabEnrichment, VocabEntry, VocabKind, VocabRevision, VocabStatus } from '../lib/types';

/**
 * TOEFL 단어장 도메인 로직 (순수함수, 테스트 대상).
 * - 입력: Telegram 메시지 한 줄 = 표현 1건. `표현 :: 내가 아는 뜻 #태그` 형식은 선택.
 * - 복습: Leitner 박스. ✅ 알아요 → 박스 +1 (간격 1·3·7·14·30일), ❌ 몰라요 → 박스 1 (내일 다시).
 *   박스 5에서 또 ✅면 '외움'으로 졸업 → 복습 목록에서 빠진다.
 * - 원본 저장소는 Notion DB. 여기는 Notion 형식을 모른다 (매핑은 lib/notion.ts).
 */

export const MAX_BOX = 5;
/** 박스 b에 들어간 뒤 다음 복습까지의 일수. 박스 0 = 새로 추가 → 다음 날 첫 복습. */
export const BOX_INTERVAL_DAYS = [1, 1, 3, 7, 14, 30] as const;
/** 한 메시지에서 받는 최대 표현 수 — Bedrock 호출 폭주 방지 */
export const MAX_INPUTS_PER_MESSAGE = 10;
/** 이 단어 수 이하이고 문장부호로 끝나지 않으면 단어·표현으로 본다 ("take into account" 등) */
const WORD_MAX_TOKENS = 4;

// ---------------------------------------------------------------- 날짜 (KST YYYY-MM-DD)

export function kstDate(at: Date = new Date()): string {
  // en-CA 로케일은 YYYY-MM-DD 형식
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "2026-10-18" → "10/18" */
export function shortDate(date: string): string {
  const [, m, d] = date.split('-');
  return `${Number(m)}/${Number(d)}`;
}

// ---------------------------------------------------------------- 입력 파싱

export interface VocabInput {
  text: string;
  /** `::` 뒤에 직접 쓴 뜻 — 있으면 Bedrock 뜻보다 우선 */
  meaning?: string;
  tags: string[];
  kind: VocabKind;
}

const TAG_RE = /(^|\s)#([\p{L}\p{N}_-]+)/gu;

/** dedup 키: 소문자 + 공백 하나로 + 앞뒤 따옴표·문장부호 제거. "Ubiquitous." == "ubiquitous" */
export function normalizeVocabKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'(\[]+|["')\].,!?;:]+$/g, '')
    .trim();
}

const WH_WORDS = new Set(['who', 'whom', 'whose', 'what', 'which', 'when', 'where', 'why', 'how']);
const AUX_VERBS = new Set([
  'is', 'are', 'am', 'was', 'were', 'do', 'does', 'did', 'can', 'could', 'will', 'would', 'shall', 'should',
  'may', 'might', 'must', 'have', 'has', 'had',
]);
const SUBJECTS = new Set([
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'this', 'that', 'these', 'those', 'there', 'the', 'a', 'an',
  'my', 'your', 'his', 'her', 'its', 'our', 'their', 'anyone', 'anybody', 'someone', 'somebody', 'everyone',
]);

/**
 * 문장부호 없이 보낸 의문문이면 끝에 `?`를 붙인다 ("who is going to lead the fundraiser" → "...fundraiser?").
 * 의문문 판정은 보수적으로: 의문사로 시작하고 3단어 안에 조동사가 오거나(who's/what's 포함),
 * 조동사로 시작하고 바로 주어가 오면("do you", "is it", "Did John"). 구동사·숙어("do away with", "would rather")는 건드리지 않는다.
 * 이미 . ? ! 로 끝나면 그대로. 순수함수.
 */
export function punctuateQuestion(text: string): string {
  const t = text.trim();
  if (!t || /[.?!]["')\]]?$/.test(t)) return t;
  const tokens = t.split(/\s+/);
  if (tokens.length < 2) return t;
  const lower = tokens.map((w) => w.toLowerCase().replace(/[‘’]/g, "'").replace(/^["'(\[]+|["')\],;:]+$/g, ''));
  const [first, second] = lower;
  const firstBase = first.replace(/'s$/, '');

  let question = false;
  if (WH_WORDS.has(firstBase)) {
    question =
      first !== firstBase || // who's / what's / how's
      (first === 'how' && second === 'come') ||
      lower.slice(1, 4).some((w) => AUX_VERBS.has(w));
  } else if (AUX_VERBS.has(first)) {
    question = SUBJECTS.has(second) || /^[A-Z]/.test(tokens[1]);
  }
  return question ? `${t}?` : t;
}

export function detectKind(text: string): VocabKind {
  const t = text.trim();
  if (/[.?!]["')\]]?$/.test(t)) return 'sentence';
  return t.split(/\s+/).length <= WORD_MAX_TOKENS ? 'word' : 'sentence';
}

/** 메시지 한 줄 → 표현 1건. 빈 줄은 무시, 최대 MAX_INPUTS_PER_MESSAGE건. 물음표 없는 의문문은 `?`를 붙인다. */
export function parseVocabMessage(message: string): VocabInput[] {
  const inputs: VocabInput[] = [];
  for (const rawLine of message.split(/\r?\n/)) {
    const tags: string[] = [];
    const line = rawLine
      .replace(TAG_RE, (_m, lead: string, tag: string) => {
        tags.push(tag.toLowerCase());
        return lead;
      })
      .trim();
    if (!line) continue;

    const sep = line.indexOf('::');
    const text = punctuateQuestion((sep === -1 ? line : line.slice(0, sep)).trim());
    const meaning = sep === -1 ? undefined : line.slice(sep + 2).trim() || undefined;
    if (!text) continue;

    inputs.push({ text, meaning, tags: [...new Set(tags)], kind: detectKind(text) });
    if (inputs.length >= MAX_INPUTS_PER_MESSAGE) break;
  }
  return inputs;
}

export type EnrichedFields = Pick<VocabEntry, 'meaning' | 'pos' | 'pronunciation' | 'example' | 'synonyms' | 'note'>;

// ---------------------------------------------------------------- 수정 요청 판별

/**
 * 영어 입력이 아니라 "뜻을 고쳐 달라"는 한국어 요청인지. 한글이 영문자보다 많으면 요청으로 본다.
 * `표현 :: 뜻` 형식은 뜻이 한국어라도 단어 입력이다 (`::` 뒤는 세지 않는다).
 * 영어 학습 자료만 저장하는 단어장이라 한국어 문장을 새 표현으로 저장할 일은 없다.
 */
export function isCorrectionRequest(message: string): boolean {
  const body = message
    .split(/\r?\n/)
    .map((line) => (line.includes('::') ? line.slice(0, line.indexOf('::')) : line).replace(TAG_RE, '$1'))
    .join('\n');
  const hangul = (body.match(/[\uac00-\ud7a3]/g) ?? []).length;
  const latin = (body.match(/[A-Za-z]/g) ?? []).length;
  return hangul > 0 && hangul > latin;
}

/** Telegram 메시지의 inline 키보드(답장 대상 카드)에서 단어장 page id를 찾는다. 없으면 undefined. */
export function pageIdFromReplyMarkup(markup: { inline_keyboard?: { callback_data?: string }[][] } | undefined): string | undefined {
  for (const row of markup?.inline_keyboard ?? []) {
    for (const button of row) {
      const decoded = decodeVocabCallback(button.callback_data);
      if (decoded) return decoded.pageId;
    }
  }
  return undefined;
}

/** 답장 없이 온 한국어 수정 요청은 이 시간 안에 저장한 표현에만 적용한다 (며칠 전 표현을 엉뚱하게 고치지 않게). */
export const CORRECTION_WINDOW_MS = 24 * 60 * 60 * 1000;

export function isWithinCorrectionWindow(lastCaptureAt: string | undefined, now: Date = new Date()): boolean {
  if (!lastCaptureAt) return false;
  const at = Date.parse(lastCaptureAt);
  return Number.isFinite(at) && now.getTime() - at <= CORRECTION_WINDOW_MS;
}

export type RevisedFields = EnrichedFields & Partial<Pick<VocabEntry, 'text' | 'key' | 'kind'>>;

/**
 * 수정 결과로 바꿀 필드. 사용자가 고쳐 달라고 한 것이라 채워진 칸도 바꾸되, 응답이 비운 칸은 원래 값을 둔다
 * (LLM이 빠뜨린 칸 때문에 발음·예문이 지워지지 않게). text가 바뀌면 key·kind도 같이 간다 (철자 교정 등). 순수함수.
 */
export function applyRevision(entry: Pick<VocabEntry, 'text' | 'key' | 'kind'> & EnrichedFields, revision: VocabRevision): RevisedFields {
  const revised = fillFromEnrichment({}, revision);
  const fields: RevisedFields = {
    meaning: revised.meaning ?? entry.meaning,
    pos: revised.pos ?? entry.pos,
    pronunciation: revised.pronunciation ?? entry.pronunciation,
    example: revised.example ?? entry.example,
    synonyms: revised.synonyms ?? entry.synonyms,
    note: revised.note ?? entry.note,
  };
  const text = revision.text?.trim();
  if (text && text !== entry.text.trim()) {
    const key = normalizeVocabKey(text);
    if (key) Object.assign(fields, { text, key, kind: detectKind(text) });
  }
  return fields;
}

/**
 * Bedrock 결과로 빈 칸만 채운다. 사용자가 직접 쓴 뜻·예문 등은 절대 덮어쓰지 않는다
 * (Telegram `::` 뜻, Notion에 손으로 적은 칸). 순수함수.
 */
export function fillFromEnrichment(current: EnrichedFields, e: VocabEnrichment): EnrichedFields {
  const example = e.example ? (e.exampleKo ? `${e.example}\n→ ${e.exampleKo}` : e.example) : undefined;
  const pick = (mine: string | undefined, theirs: string | undefined) => mine?.trim() || theirs;
  return {
    meaning: pick(current.meaning, e.meaning),
    pos: pick(current.pos, e.pos),
    pronunciation: pick(current.pronunciation, e.pronunciation),
    example: pick(current.example, example),
    synonyms: pick(current.synonyms, e.synonyms.length ? e.synonyms.join(', ') : undefined),
    note: pick(current.note, e.note),
  };
}

// ---------------------------------------------------------------- Leitner 복습

export type ReviewResult = 'know' | 'forgot';

/** 복습으로 바뀌는 필드만 */
export type ReviewFields = Pick<VocabEntry, 'box' | 'nextReview' | 'lastReviewed' | 'status' | 'missCount'>;

/**
 * 복습 필드만 골라낸다. VocabEntry 전체를 넘겨도 결과에 뜻·예문 등이 섞이지 않아야
 * Notion PATCH가 사용자가 손댄 칸(서식 포함)을 다시 쓰지 않는다.
 */
export function reviewFieldsOf(e: ReviewFields): ReviewFields {
  return { box: e.box, nextReview: e.nextReview, lastReviewed: e.lastReviewed, status: e.status, missCount: e.missCount };
}

/** 처음 들어온 표현의 복습 상태: 박스 0, 다음 날 첫 복습. */
export function initialReview(createdDate: string): ReviewFields {
  return {
    box: 0,
    nextReview: addDays(createdDate, BOX_INTERVAL_DAYS[0]),
    status: 'learning',
    missCount: 0,
  };
}

/**
 * 복습 버튼 효과. 같은 KST 날짜에 이미 반영했으면 changed=false (버튼 중복 클릭 / 이전 퀴즈 재클릭).
 */
export function applyReview(
  entry: ReviewFields,
  result: ReviewResult,
  today: string
): { fields: ReviewFields; changed: boolean; ack: string } {
  if (entry.lastReviewed === today) {
    return { fields: reviewFieldsOf(entry), changed: false, ack: '오늘은 이미 반영했어요' };
  }

  if (result === 'forgot') {
    return {
      fields: {
        box: 1,
        nextReview: addDays(today, BOX_INTERVAL_DAYS[1]),
        lastReviewed: today,
        status: 'learning',
        missCount: entry.missCount + 1,
      },
      changed: true,
      ack: '❌ 괜찮아요, 내일 다시 나와요',
    };
  }

  const box = Math.min(Math.max(entry.box, 0) + 1, MAX_BOX + 1);
  if (box > MAX_BOX) {
    return {
      fields: { ...reviewFieldsOf(entry), box: MAX_BOX, nextReview: undefined, lastReviewed: today, status: 'mastered' },
      changed: true,
      ack: '🎉 외웠어요! 복습 목록에서 뺄게요',
    };
  }
  const days = BOX_INTERVAL_DAYS[box];
  const nextReview = addDays(today, days);
  return {
    fields: { ...reviewFieldsOf(entry), box, nextReview, lastReviewed: today, status: 'learning' },
    changed: true,
    ack: `✅ 다음 복습 ${shortDate(nextReview)} (${days}일 뒤)`,
  };
}

/**
 * 이미 있는 표현을 또 보냈다 = 또 헷갈렸다는 신호. 헷갈린 횟수 +1,
 * 외운 걸로 처리됐던 표현이면 박스 1로 되살려 내일 다시 복습.
 */
export function applyRepeatCapture(entry: ReviewFields, today: string): ReviewFields {
  const missCount = entry.missCount + 1;
  if (entry.status === 'mastered') {
    return { ...reviewFieldsOf(entry), box: 1, nextReview: addDays(today, BOX_INTERVAL_DAYS[1]), status: 'learning', missCount };
  }
  return { ...reviewFieldsOf(entry), missCount };
}

/** 오늘 복습할 표현: 다음 복습일이 오늘 이전이고 외우지 않은 것. 오래 밀린 순 → 많이 헷갈린 순. */
export function pickDueEntries(entries: VocabEntry[], today: string, limit: number): VocabEntry[] {
  return entries
    .filter((e) => e.status !== 'mastered' && e.nextReview !== undefined && e.nextReview <= today)
    .sort((a, b) => (a.nextReview! < b.nextReview! ? -1 : a.nextReview! > b.nextReview! ? 1 : b.missCount - a.missCount))
    .slice(0, Math.max(0, limit));
}

/** 뜻을 채워야 하는 행: 상태가 비었거나(Notion에 직접 입력) '새로 추가'. 제목이 빈 행은 건너뛴다. */
export function needsEnrichment(entry: Pick<VocabEntry, 'text' | 'status'>): boolean {
  return entry.text.trim() !== '' && (entry.status === undefined || entry.status === 'new');
}

// ---------------------------------------------------------------- 버튼 (callback_data)

export type VocabAction = 'know' | 'forgot' | 'delete';

const VOCAB_PREFIX = 't1';
const ACTION_CODE: Record<VocabAction, string> = { know: 'k', forgot: 'f', delete: 'x' };
const CODE_ACTION: Record<string, VocabAction> = { k: 'know', f: 'forgot', x: 'delete' };

/** Notion page id는 하이픈을 빼서 32자로 — "t1|k|<32>" = 37바이트, 64바이트 제한 안쪽. */
export function compactPageId(pageId: string): string {
  return pageId.replace(/-/g, '');
}

export function encodeVocabCallback(action: VocabAction, pageId: string): string {
  return `${VOCAB_PREFIX}|${ACTION_CODE[action]}|${compactPageId(pageId)}`;
}

export function decodeVocabCallback(
  data: string | undefined
): { action: VocabAction; pageId: string } | undefined {
  if (!data) return undefined;
  const parts = data.split('|');
  if (parts.length !== 3) return undefined;
  const [prefix, code, pageId] = parts;
  if (prefix !== VOCAB_PREFIX || !/^[0-9a-f]{32}$/i.test(pageId)) return undefined;
  const action = CODE_ACTION[code];
  return action ? { action, pageId } : undefined;
}

// ---------------------------------------------------------------- 라벨

export const STATUS_LABEL: Record<VocabStatus, string> = {
  new: '새로 추가',
  learning: '학습 중',
  mastered: '외움',
};
export const KIND_LABEL: Record<VocabKind, string> = { word: '단어', sentence: '문장' };
