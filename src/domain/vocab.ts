import type { VocabEnrichment, VocabEntry, VocabKind, VocabStatus } from '../lib/types';

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
  /** 영어 뒤에 붙여 쓴 한국어 메모 ("~에서 case studies가 사례 연구래") — 표현이 아니라 메모 칸으로 */
  memo?: string;
  tags: string[];
  kind: VocabKind;
}

const TAG_RE = /(^|\s)#([\p{L}\p{N}_-]+)/gu;
const HANGUL_RE = /\p{Script=Hangul}/u;
/** 영어 바로 뒤에 붙은 조사 ("proactive가 …", "morning에서 …"). 뒤에 공백이 있을 때만 떼어낸다. */
const LEADING_PARTICLE_RE = /^(?:에서는|에서|이라는|라는|이란|란|이랑|랑|은|는|이|가|을|를|의|에|도)(?=\s)/u;

/**
 * "영어 문장 + 한국어 메모"를 한 줄에 쓴 경우 나눈다. 순수함수.
 * "Thank you all for being so proactive가 모두 … 고마워요 라는 뜻"
 *   → text "Thank you all for being so proactive", memo "모두 … 고마워요 라는 뜻"
 * 한국어가 맨 앞에 있거나(한국어로 시작하는 입력) 앞부분에 영어가 없으면 그대로 둔다.
 */
export function splitKoreanMemo(text: string): { text: string; memo?: string } {
  const at = text.search(HANGUL_RE);
  if (at <= 0) return { text };
  const english = text.slice(0, at).trim();
  if (!/[A-Za-z]/.test(english)) return { text };
  const memo = text.slice(at).replace(LEADING_PARTICLE_RE, '').trim();
  return { text: english, memo: memo || undefined };
}

export const MEMO_LABEL = '🙋 내 느낀점: ';

/**
 * 사용자가 영어 뒤에 적은 한국어 메모를 '내 느낀점'으로 메모 칸 맨 끝에 붙인다 (정답 보기에 같이 보인다).
 * Bedrock 팁은 그대로 위에 둔다. 이미 붙어 있으면 다시 붙이지 않는다. 순수함수.
 */
export function withUserMemo(note: string | undefined, memo: string | undefined): string | undefined {
  if (!memo) return note;
  const line = `${MEMO_LABEL}${memo}`;
  if (note?.includes(line)) return note;
  return note ? `${note}\n${line}` : line;
}

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

export function detectKind(text: string): VocabKind {
  const t = text.trim();
  if (/[.?!]["')\]]?$/.test(t)) return 'sentence';
  return t.split(/\s+/).length <= WORD_MAX_TOKENS ? 'word' : 'sentence';
}

/** 메시지 한 줄 → 표현 1건. 빈 줄은 무시, 최대 MAX_INPUTS_PER_MESSAGE건. */
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
    const { text, memo } = splitKoreanMemo((sep === -1 ? line : line.slice(0, sep)).trim());
    const meaning = sep === -1 ? undefined : line.slice(sep + 2).trim() || undefined;
    if (!text) continue;

    inputs.push({ text, meaning, memo, tags: [...new Set(tags)], kind: detectKind(text) });
    if (inputs.length >= MAX_INPUTS_PER_MESSAGE) break;
  }
  return inputs;
}

export type EnrichedFields = Pick<VocabEntry, 'meaning' | 'pos' | 'pronunciation' | 'example' | 'synonyms' | 'note'>;

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

// ---------------------------------------------------------------- 오타 수정

/** 오타로 인정하는 단어 하나의 최대 편집 거리 — 짧은 단어일수록 엄격하게 ("go" → "goes"는 오타가 아니라 문법 수정) */
function typoBudget(word: string): number {
  return word.length <= 4 ? 1 : word.length <= 8 ? 2 : 3;
}

/** 편집 거리. 삽입·삭제·치환·인접 두 글자 뒤바꿈이 각각 1 ("locla" → "local" = 1). */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

export interface TypoFix {
  /** 저장할 표현 (고칠 게 없으면 원래 입력) */
  text: string;
  /** "locla → local" 형식. 비었으면 고친 것 없음 */
  fixes: string[];
}

/**
 * Bedrock이 고친 입력(corrected)에서 '오타 수정'으로 볼 수 있는 것만 반영한다. 순수함수.
 * LLM이 문장을 다시 쓰거나 문법을 고치면 사용자가 외우려던 원문이 바뀌므로,
 * 단어 단위로 편집 거리가 작은 변경만 받는다. 단어 수가 다르면 띄어쓰기 오타("alot" → "a lot")만.
 */
export function applyTypoFix(original: string, corrected: string | undefined): TypoFix {
  const a = original.trim().split(/\s+/);
  const keep: TypoFix = { text: original, fixes: [] };
  const fixed = corrected?.trim();
  if (!fixed) return keep;
  const b = fixed.split(/\s+/);

  if (a.length === b.length) {
    const fixes: string[] = [];
    const words = a.map((w, i) => {
      if (w === b[i] || editDistance(w.toLowerCase(), b[i].toLowerCase()) > typoBudget(w)) return w;
      fixes.push(`${w} → ${b[i]}`);
      return b[i];
    });
    return fixes.length ? { text: words.join(' '), fixes } : keep;
  }

  if (Math.abs(a.length - b.length) > 1) return keep;
  // 앞뒤 같은 단어를 걷어내고 바뀐 구간만 비교
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  const from = a.slice(s, a.length - e).join(' ');
  const to = b.slice(s, b.length - e).join(' ');
  if (editDistance(from.toLowerCase(), to.toLowerCase()) > typoBudget(from)) return keep;
  return { text: b.join(' '), fixes: [`${from} → ${to}`] };
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
