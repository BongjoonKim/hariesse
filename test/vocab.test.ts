import {
  addDays,
  shortDate,
  kstDate,
  normalizeVocabKey,
  detectKind,
  parseVocabMessage,
  fillFromEnrichment,
  detectSpellingCorrection,
  withSpellingNote,
  initialReview,
  applyReview,
  applyRepeatCapture,
  pickDueEntries,
  needsEnrichment,
  encodeVocabCallback,
  decodeVocabCallback,
  isCorrectionRequest,
  pageIdFromReplyMarkup,
  applyRevision,
  isWithinCorrectionWindow,
  hasKoreanInstruction,
  splitKoreanInstruction,
  classifyVocabMessageLocally,
  fallbackVocabIntent,
  guessIntentFromInstruction,
  joinClause,
  appendToEntry,
  MAX_INPUTS_PER_MESSAGE,
  type ReviewFields,
  type VocabAction,
} from '../src/domain/vocab';
import { buildVocabProperties, parseVocabPage, VOCAB_PROP } from '../src/lib/notion-vocab';
import { formatVocabCard, formatReviewItem, buildVocabSavedKeyboard, buildReviewKeyboard } from '../src/lib/telegram';
import { parseVocabEnrichment, buildVocabPrompt, parseVocabRevision, buildVocabRevisionPrompt, parseVocabIntent, buildVocabIntentPrompt } from '../src/lib/bedrock';
import type { VocabEntry } from '../src/lib/types';

const TODAY = '2026-10-11';
const PAGE_ID = '1234abcd1234abcd1234abcd1234abcd';

function entry(over: Partial<VocabEntry> = {}): VocabEntry {
  return { pageId: PAGE_ID, text: 'ubiquitous', tags: [], box: 0, missCount: 0, status: 'learning', ...over };
}

describe('날짜', () => {
  it('addDays는 월·연 경계를 넘는다', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-25', 14)).toBe('2027-01-08');
  });

  it('shortDate', () => {
    expect(shortDate('2026-10-08')).toBe('10/8');
  });

  it('kstDate는 UTC 15시 이후를 다음 날로 본다', () => {
    expect(kstDate(new Date('2026-10-11T14:59:00Z'))).toBe('2026-10-11');
    expect(kstDate(new Date('2026-10-11T15:00:00Z'))).toBe('2026-10-12');
  });
});

describe('입력 파싱', () => {
  it('정규화 키: 대소문자·공백·끝 문장부호·둥근 따옴표를 무시', () => {
    expect(normalizeVocabKey('  Ubiquitous. ')).toBe('ubiquitous');
    expect(normalizeVocabKey('Take   into  Account')).toBe('take into account');
    expect(normalizeVocabKey('“It’s raining.”')).toBe("it's raining");
  });

  it('종류 판별: 짧은 표현은 단어, 길거나 문장부호로 끝나면 문장', () => {
    expect(detectKind('ubiquitous')).toBe('word');
    expect(detectKind('take into account')).toBe('word');
    expect(detectKind('The findings corroborate the hypothesis')).toBe('sentence');
    expect(detectKind('It works.')).toBe('sentence');
    expect(detectKind('Is it?')).toBe('sentence');
  });

  it('한 줄 = 1건, 뜻(::)과 태그(#) 분리', () => {
    const inputs = parseVocabMessage('mitigate :: 완화하다 #reading #Writing\n\n  The findings corroborate the hypothesis.  ');
    expect(inputs).toEqual([
      { text: 'mitigate', meaning: '완화하다', tags: ['reading', 'writing'], kind: 'word' },
      { text: 'The findings corroborate the hypothesis.', meaning: undefined, tags: [], kind: 'sentence' },
    ]);
  });

  it('빈 뜻·태그만 있는 줄·중복 태그 처리', () => {
    expect(parseVocabMessage('#reading')).toEqual([]);
    expect(parseVocabMessage('abate ::  #r #r')).toEqual([{ text: 'abate', meaning: undefined, tags: ['r'], kind: 'word' }]);
    expect(parseVocabMessage(':: 뜻만')).toEqual([]);
  });

  it('한 메시지 최대 건수 제한', () => {
    const many = Array.from({ length: 15 }, (_, i) => `word${i}`).join('\n');
    expect(parseVocabMessage(many)).toHaveLength(MAX_INPUTS_PER_MESSAGE);
  });
});

describe('수정 요청', () => {
  it('한국어가 영문보다 많으면 수정 요청, 영어 입력은 아니다', () => {
    expect(isCorrectionRequest('고용이라기 보다는 근무가 9/1일 부터 시작할 거라는 뜻이 맞을 것 같아 수정해줘')).toBe(true);
    expect(isCorrectionRequest("commence는 '근무를 시작하다'로 번역해줘")).toBe(true);
    expect(isCorrectionRequest('the employment will commerce on Septemper 1')).toBe(false);
    expect(isCorrectionRequest('ubiquitous')).toBe(false);
    expect(isCorrectionRequest('')).toBe(false);
  });

  it('`표현 :: 뜻`과 #태그는 뜻이 한국어라도 단어 입력이다', () => {
    expect(isCorrectionRequest('mitigate :: 완화하다, 줄이다 #reading')).toBe(false);
    expect(isCorrectionRequest('take into account :: 고려하다\nabate :: 약해지다')).toBe(false);
  });

  it('답장 대상 카드의 키보드에서 page id를 찾는다', () => {
    expect(pageIdFromReplyMarkup(buildVocabSavedKeyboard(PAGE_ID))).toBe(PAGE_ID);
    expect(pageIdFromReplyMarkup(buildReviewKeyboard(PAGE_ID))).toBe(PAGE_ID);
    // 다이제스트·레슨 메시지에 답장한 건 단어장 수정이 아니다
    expect(pageIdFromReplyMarkup({ inline_keyboard: [[{ callback_data: 'v1|like|abc' }]] })).toBeUndefined();
    expect(pageIdFromReplyMarkup({ inline_keyboard: [] })).toBeUndefined();
    expect(pageIdFromReplyMarkup(undefined)).toBeUndefined();
  });

  const revision = {
    meaning: '근무는 9월 1일에 시작될 것이다',
    pos: undefined,
    pronunciation: undefined,
    example: undefined,
    exampleKo: undefined,
    synonyms: [],
    note: 'employment: (여기서는) 근무, 고용 관계\ncommence: 시작하다',
  };

  it('수정 결과는 채워진 칸도 덮어쓰고, 표현이 그대로면 text·key는 건드리지 않는다', () => {
    const fields = applyRevision(
      { text: 'the employment will commerce on Septemper 1', key: 'x', kind: 'sentence', meaning: '고용은 9월 1일에 시작될 것이다' },
      revision
    );
    expect(fields.meaning).toBe('근무는 9월 1일에 시작될 것이다');
    expect(fields.note).toContain('근무');
    expect(fields).not.toHaveProperty('text');
    expect(fields).not.toHaveProperty('key');
    const same = applyRevision({ text: 'abate', key: 'abate', kind: 'word' }, { ...revision, text: ' abate ' });
    expect(same).not.toHaveProperty('text');
  });

  it('응답이 비운 칸은 원래 값을 둔다 (발음·예문이 지워지지 않게)', () => {
    const fields = applyRevision(
      { text: 'abate', key: 'abate', kind: 'word', meaning: '줄다', pronunciation: '/əˈbeɪt/', example: 'The storm abated.\n→ 폭풍이 잦아들었다.' },
      { ...revision, meaning: '약해지다', note: undefined }
    );
    expect(fields).toMatchObject({ meaning: '약해지다', pronunciation: '/əˈbeɪt/', example: 'The storm abated.\n→ 폭풍이 잦아들었다.', note: undefined });
  });

  it('답장 없는 수정은 24시간 안에 저장한 표현에만', () => {
    const now = new Date('2026-10-17T09:14:00+09:00');
    expect(isWithinCorrectionWindow('2026-10-17T00:13:00.000Z', now)).toBe(true);
    expect(isWithinCorrectionWindow('2026-10-15T00:13:00.000Z', now)).toBe(false);
    expect(isWithinCorrectionWindow(undefined, now)).toBe(false);
    expect(isWithinCorrectionWindow('garbage', now)).toBe(false);
  });

  it('표현 자체를 고치면 key·kind도 같이 간다', () => {
    const fields = applyRevision(
      { text: 'the employment will commerce on Septemper 1', key: 'the employment will commerce on septemper 1', kind: 'sentence' },
      { ...revision, text: 'The employment will commence on September 1.' }
    );
    expect(fields).toMatchObject({
      text: 'The employment will commence on September 1.',
      key: 'the employment will commence on september 1',
      kind: 'sentence',
    });
  });
});

describe('fillFromEnrichment', () => {
  const e = {
    meaning: '어디에나 있는',
    pos: 'adjective',
    pronunciation: '/juːˈbɪkwɪtəs/',
    example: 'Phones are ubiquitous.',
    exampleKo: '휴대폰은 어디에나 있다.',
    synonyms: ['omnipresent', 'pervasive'],
    note: 'ubiquitous in ~',
  };

  it('빈 칸은 Bedrock 결과로 채우고 예문엔 번역을 붙인다', () => {
    expect(fillFromEnrichment({}, e)).toEqual({
      meaning: '어디에나 있는',
      pos: 'adjective',
      pronunciation: '/juːˈbɪkwɪtəs/',
      example: 'Phones are ubiquitous.\n→ 휴대폰은 어디에나 있다.',
      synonyms: 'omnipresent, pervasive',
      note: 'ubiquitous in ~',
    });
  });

  it('사용자가 적은 칸은 덮어쓰지 않는다', () => {
    const filled = fillFromEnrichment({ meaning: '흔한', example: '내 예문' }, e);
    expect(filled.meaning).toBe('흔한');
    expect(filled.example).toBe('내 예문');
    expect(filled.pos).toBe('adjective');
  });

  it('공백뿐인 칸은 빈 칸으로 본다', () => {
    expect(fillFromEnrichment({ meaning: '  ' }, e).meaning).toBe('어디에나 있는');
  });
});

describe('철자 교정', () => {
  const sentence = "send them to me as soon as they're done and i'll get everiything edited";
  const fixed = "send them to me as soon as they're done and i'll get everything edited";

  it('오타가 있으면 고친 표현·키·종류와 바뀐 단어 기록을 돌려준다', () => {
    const c = detectSpellingCorrection(sentence, { correctedText: fixed });
    expect(c).toEqual({
      text: fixed,
      key: normalizeVocabKey(fixed),
      kind: 'sentence',
      noteLine: '✏️ 철자 교정: everiything → everything',
    });
    expect(detectSpellingCorrection('ubiquitious', { correctedText: 'ubiquitous' })?.noteLine).toBe(
      '✏️ 철자 교정: ubiquitious → ubiquitous'
    );
  });

  it('단어 수가 달라지면 원래 입력 전체를 남긴다', () => {
    const c = detectSpellingCorrection('alot of people', { correctedText: 'a lot of people' });
    expect(c?.text).toBe('a lot of people');
    expect(c?.noteLine).toBe('✏️ 철자 교정 · 원래 입력: alot of people');
  });

  it('고칠 게 없거나 대소문자·문장부호만 다르면 교정이 아니다', () => {
    expect(detectSpellingCorrection('ubiquitous', {})).toBeUndefined();
    expect(detectSpellingCorrection('ubiquitous', { correctedText: '' })).toBeUndefined();
    expect(detectSpellingCorrection('ubiquitous', { correctedText: 'Ubiquitous.' })).toBeUndefined();
    expect(detectSpellingCorrection('"ubiquitous"', { correctedText: 'ubiquitous' })).toBeUndefined();
  });

  it('메모 맨 앞에 교정 기록을 붙이고, 모델이 쓴 "철자 확인:" 줄은 뺀다', () => {
    const c = detectSpellingCorrection('everiything', { correctedText: 'everything' })!;
    expect(withSpellingNote(undefined, c)).toBe('✏️ 철자 교정: everiything → everything');
    expect(withSpellingNote('철자 확인: everything\nevery single thing과 비슷', c)).toBe(
      '✏️ 철자 교정: everiything → everything\nevery single thing과 비슷'
    );
    expect(withSpellingNote('as soon as: ~하자마자', c)).toBe('✏️ 철자 교정: everiything → everything\nas soon as: ~하자마자');
  });
});

describe('Leitner 복습', () => {
  const fresh: ReviewFields = initialReview(TODAY);

  it('새 표현은 박스 0, 다음 날 첫 복습', () => {
    expect(fresh).toEqual({ box: 0, nextReview: '2026-10-12', status: 'learning', missCount: 0 });
  });

  it('✅를 계속 누르면 1·1·3·7·14·30일 간격 뒤 외움으로 졸업', () => {
    let f: ReviewFields = fresh;
    let day = '2026-10-12';
    const gaps: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = applyReview(f, 'know', day);
      expect(r.changed).toBe(true);
      f = r.fields;
      if (f.status === 'mastered') break;
      gaps.push((Date.parse(f.nextReview!) - Date.parse(day)) / 86400000);
      day = f.nextReview!;
    }
    expect(gaps).toEqual([1, 3, 7, 14, 30]);
    expect(f).toMatchObject({ status: 'mastered', box: 5, nextReview: undefined });
  });

  it('❌는 박스 1로 내리고 내일 다시, 헷갈린 횟수 +1', () => {
    const r = applyReview({ ...fresh, box: 4, missCount: 2 }, 'forgot', TODAY);
    expect(r.fields).toEqual({ box: 1, nextReview: '2026-10-12', lastReviewed: TODAY, status: 'learning', missCount: 3 });
    expect(r.ack).toContain('내일');
  });

  it('같은 날 두 번 누르면 반영하지 않는다', () => {
    const once = applyReview(fresh, 'know', TODAY);
    const twice = applyReview(once.fields, 'forgot', TODAY);
    expect(twice.changed).toBe(false);
    expect(twice.fields).toEqual(once.fields);
  });

  it('VocabEntry 전체를 넘겨도 복습 필드만 돌려준다 (Notion에서 손댄 칸을 다시 쓰지 않게)', () => {
    const full = entry({ meaning: '뜻', example: '예문', tags: ['reading'] });
    for (const f of [applyReview(full, 'know', TODAY).fields, applyReview(full, 'forgot', TODAY).fields, applyRepeatCapture(full, TODAY)]) {
      expect(Object.keys(f).sort()).toEqual(['box', 'lastReviewed', 'missCount', 'nextReview', 'status']);
    }
  });

  it('✅ 토스트에 다음 복습일과 간격', () => {
    expect(applyReview({ ...fresh, box: 2 }, 'know', TODAY).ack).toBe('✅ 다음 복습 10/18 (7일 뒤)');
  });

  it('이미 있는 표현을 또 보내면 헷갈린 횟수 +1, 외운 표현이면 되살린다', () => {
    expect(applyRepeatCapture({ ...fresh, box: 3, missCount: 1 }, TODAY)).toMatchObject({ box: 3, missCount: 2 });
    expect(applyRepeatCapture({ box: 5, status: 'mastered', missCount: 0 }, TODAY)).toEqual({
      box: 1,
      nextReview: '2026-10-12',
      status: 'learning',
      missCount: 1,
    });
  });
});

describe('pickDueEntries', () => {
  it('오늘까지 차례인 것만, 오래 밀린 순 → 많이 헷갈린 순, limit까지', () => {
    const list = [
      entry({ pageId: 'a', nextReview: '2026-10-11', missCount: 0 }),
      entry({ pageId: 'b', nextReview: '2026-10-11', missCount: 3 }),
      entry({ pageId: 'c', nextReview: '2026-10-05' }),
      entry({ pageId: 'd', nextReview: '2026-10-12' }), // 내일
      entry({ pageId: 'e', nextReview: '2026-10-01', status: 'mastered' }),
      entry({ pageId: 'f', nextReview: undefined }),
    ];
    expect(pickDueEntries(list, TODAY, 10).map((e) => e.pageId)).toEqual(['c', 'b', 'a']);
    expect(pickDueEntries(list, TODAY, 2).map((e) => e.pageId)).toEqual(['c', 'b']);
  });
});

describe('needsEnrichment', () => {
  it('상태가 비었거나 새로 추가면 채운다, 빈 제목은 건너뛴다', () => {
    expect(needsEnrichment({ text: 'abate', status: undefined })).toBe(true);
    expect(needsEnrichment({ text: 'abate', status: 'new' })).toBe(true);
    expect(needsEnrichment({ text: 'abate', status: 'learning' })).toBe(false);
    expect(needsEnrichment({ text: '  ', status: undefined })).toBe(false);
  });
});

describe('callback_data', () => {
  it.each<VocabAction>(['know', 'forgot', 'delete'])('%s 라운드트립 + 64바이트 이하', (action) => {
    const data = encodeVocabCallback(action, '1234abcd-1234-abcd-1234-abcd1234abcd');
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(decodeVocabCallback(data)).toEqual({ action, pageId: PAGE_ID });
  });

  it('다른 prefix·잘못된 id는 undefined', () => {
    expect(decodeVocabCallback(undefined)).toBeUndefined();
    expect(decodeVocabCallback(`l1|k|${PAGE_ID}`)).toBeUndefined();
    expect(decodeVocabCallback(`t1|z|${PAGE_ID}`)).toBeUndefined();
    expect(decodeVocabCallback('t1|k|not-a-page-id')).toBeUndefined();
  });
});

describe('Notion 매핑', () => {
  it('넘긴 필드만 만들고, undefined로 넘긴 칸은 비운다', () => {
    const props = buildVocabProperties({ box: 5, nextReview: undefined, status: 'mastered' });
    expect(Object.keys(props).sort()).toEqual([VOCAB_PROP.box, VOCAB_PROP.nextReview, VOCAB_PROP.status].sort());
    expect(props[VOCAB_PROP.nextReview]).toEqual({ date: null });
    expect(props[VOCAB_PROP.status]).toEqual({ select: { name: '외움' } });
  });

  it('select 옵션엔 쉼표를 넣지 않는다', () => {
    expect(buildVocabProperties({ pos: 'Noun, Verb' })[VOCAB_PROP.pos]).toEqual({ select: { name: 'noun  verb' } });
  });

  it('build → Notion 응답 형태 → parse 라운드트립', () => {
    const fields = {
      text: 'ubiquitous',
      key: 'ubiquitous',
      kind: 'word' as const,
      meaning: '어디에나 있는',
      tags: ['reading'],
      box: 2,
      nextReview: '2026-10-14',
      status: 'learning' as const,
      missCount: 1,
      origin: 'telegram' as const,
    };
    // Notion은 rich_text/title에 plain_text를 돌려준다
    const props = JSON.parse(
      JSON.stringify(buildVocabProperties(fields)).replace(/"text":\{"content":("(?:[^"\\]|\\.)*")\}/g, '"plain_text":$1')
    );
    const parsed = parseVocabPage({
      id: '1234abcd-1234-abcd-1234-abcd1234abcd',
      created_time: '2026-10-10T16:00:00.000Z',
      properties: props,
    });
    expect(parsed).toMatchObject({ ...fields, pageId: PAGE_ID, createdDate: '2026-10-11' });
  });

  it('Notion에서 손으로 넣은 행: 제목만 있어도 파싱된다', () => {
    const parsed = parseVocabPage({
      id: PAGE_ID,
      properties: {
        [VOCAB_PROP.text]: { title: [{ plain_text: 'abate' }] },
        [VOCAB_PROP.status]: { select: null },
        [VOCAB_PROP.box]: { number: null },
        [VOCAB_PROP.nextReview]: { date: null },
      },
    });
    expect(parsed).toMatchObject({ text: 'abate', box: 0, missCount: 0, tags: [], status: undefined, nextReview: undefined });
    expect(needsEnrichment(parsed)).toBe(true);
  });
});

describe('Telegram 포맷', () => {
  it('저장 카드: HTML 이스케이프 + 다음 복습일', () => {
    const card = formatVocabCard(
      entry({ text: 'a < b', kind: 'word', meaning: '뜻 & 의미', nextReview: '2026-10-12', tags: ['reading'] }),
      { repeated: false }
    );
    expect(card).toContain('<b>a &lt; b</b>');
    expect(card).toContain('뜻: 뜻 &amp; 의미');
    expect(card).toContain('#reading');
    expect(card).toContain('다음 복습 10/12');
  });

  it('고친 카드는 ✏️ 머리말', () => {
    const card = formatVocabCard(entry({ kind: 'sentence', meaning: '근무는 9월 1일에 시작된다' }), { repeated: false, corrected: true });
    expect(card).toContain('✏️ <b>고쳤어요</b> · 문장');
    expect(card).not.toContain('저장했어요');
  });

  it('문장 카드는 "번역", 뜻이 비면 안내', () => {
    expect(formatVocabCard(entry({ kind: 'sentence', meaning: '번역문' }), { repeated: false })).toContain('번역: 번역문');
    expect(formatVocabCard(entry({ meaning: undefined }), { repeated: false })).toContain('뜻을 아직 못 채웠어요');
  });

  it('복습 퀴즈: 뜻은 스포일러 안에만', () => {
    const msg = formatReviewItem(entry({ meaning: '어디에나 있는', box: 2, missCount: 1 }), 0, 3);
    expect(msg).toContain('1/3 · 📦 박스 2 · ❗헷갈림 1회');
    expect(msg).toMatch(/<tg-spoiler>뜻: 어디에나 있는<\/tg-spoiler>/);
    expect(msg.split('<tg-spoiler>')[0]).not.toContain('어디에나');
  });
});

describe('Bedrock 단어 응답', () => {
  it('JSON 파싱 + 빈 문자열은 undefined', () => {
    const r = parseVocabEnrichment(
      '```json\n{"meaning":"번역","pos":"","pronunciation":"","example":"","exampleKo":"","synonyms":[],"note":"corroborate: 뒷받침하다"}\n```'
    );
    expect(r).toEqual({
      meaning: '번역',
      pos: undefined,
      pronunciation: undefined,
      example: undefined,
      exampleKo: undefined,
      synonyms: [],
      note: 'corroborate: 뒷받침하다',
      correctedText: undefined,
    });
  });

  it('철자를 고친 표현을 correctedText로 받는다', () => {
    const r = parseVocabEnrichment('{"correctedText":"everything","meaning":"모든 것","synonyms":[]}');
    expect(r.correctedText).toBe('everything');
  });

  it('뜻이 없으면 throw', () => {
    expect(() => parseVocabEnrichment('{"meaning":""}')).toThrow();
  });

  it('프롬프트에 사용자 뜻을 기준으로 넣는다', () => {
    expect(buildVocabPrompt('bank', 'word', '둑')).toContain('사용자가 적은 뜻');
    expect(buildVocabPrompt('bank', 'word')).not.toContain('사용자가 적은 뜻');
  });

  it('수정 프롬프트에 현재 카드와 요청이 들어가고, 응답의 text는 선택', () => {
    const prompt = buildVocabRevisionPrompt(
      entry({ kind: 'sentence', meaning: '고용은 9월 1일에 시작될 것이다', example: 'Work starts.\n→ 일이 시작된다.' }),
      '근무가 시작된다는 뜻이야'
    );
    expect(prompt).toContain('고용은 9월 1일에 시작될 것이다');
    expect(prompt).toContain('근무가 시작된다는 뜻이야');
    expect(prompt).toContain('"example": "Work starts."');
    expect(prompt).toContain('"exampleKo": "일이 시작된다."');
    expect(parseVocabRevision('{"meaning":"근무는 9월 1일에 시작된다","synonyms":[]}')).toMatchObject({ meaning: '근무는 9월 1일에 시작된다', text: undefined });
    expect(parseVocabRevision('{"text":"commence","meaning":"시작하다","synonyms":[]}').text).toBe('commence');
    expect(() => parseVocabRevision('{"text":"commence","meaning":""}')).toThrow();
  });
});

describe('의도 분류 (새 표현 / 수정 / 이어 붙이기)', () => {
  const FIRST = 'that also happens to be our Wind & appetizer Special night';
  const SECOND = '아까 문장에 추가로 which offers a 5 percent discout on all appetizers and select winds';

  it('영어만 있으면 Bedrock 분류 없이 바로 저장(new) — 답장이면 수정(revise)', () => {
    expect(classifyVocabMessageLocally(FIRST, false)).toEqual({ intent: 'new', english: FIRST });
    expect(classifyVocabMessageLocally('mitigate :: 완화하다 #reading', false)).toEqual({ intent: 'new', english: 'mitigate :: 완화하다 #reading' });
    expect(classifyVocabMessageLocally('it means to start', true)).toMatchObject({ intent: 'revise', instruction: 'it means to start' });
    expect(hasKoreanInstruction(FIRST)).toBe(false);
    expect(hasKoreanInstruction('take into account :: 고려하다\nabate :: 약해지다')).toBe(false);
  });

  it('한글이 영문보다 많으면 빠른 경로로 수정(revise)', () => {
    const msg = '고용이라기 보다는 근무가 9/1일 부터 시작할 거라는 뜻이 맞을 것 같아 수정해줘';
    expect(classifyVocabMessageLocally(msg, false)).toMatchObject({ intent: 'revise', instruction: msg });
  });

  it('한글이 섞여 있는데 영문이 더 많으면 Bedrock 분류로 넘긴다(undefined)', () => {
    expect(hasKoreanInstruction(SECOND)).toBe(true);
    expect(isCorrectionRequest(SECOND)).toBe(false);
    expect(classifyVocabMessageLocally(SECOND, false)).toBeUndefined();
  });

  it('한국어 지시 접두어/접미어와 영어 본문을 나눈다', () => {
    expect(splitKoreanInstruction(SECOND)).toEqual({
      instruction: '아까 문장에 추가로',
      english: 'which offers a 5 percent discout on all appetizers and select winds',
    });
    expect(splitKoreanInstruction('which offers a discount 를 앞 문장 뒤에 붙여줘')).toEqual({
      instruction: '를 앞 문장 뒤에 붙여줘',
      english: 'which offers a discount',
    });
    expect(splitKoreanInstruction('앞 문장에 이어서: and select wines')).toEqual({ instruction: '앞 문장에 이어서:', english: 'and select wines' });
    expect(splitKoreanInstruction("commence는 '근무를 시작하다'로 번역해줘").english).toBe('');
    expect(splitKoreanInstruction(FIRST)).toEqual({ instruction: '', english: FIRST });
  });

  it('Bedrock 분류가 실패하면 규칙으로 추정 — 한국어 접두어는 표현에 들어가지 않는다', () => {
    expect(guessIntentFromInstruction('아까 문장에 추가로')).toBe('append');
    expect(guessIntentFromInstruction('앞 문장 뒤에 붙여줘')).toBe('append');
    expect(guessIntentFromInstruction('~라는 뜻이야')).toBe('revise');
    expect(fallbackVocabIntent(SECOND)).toEqual({
      intent: 'append',
      english: 'which offers a 5 percent discout on all appetizers and select winds',
      instruction: '아까 문장에 추가로',
    });
    expect(fallbackVocabIntent(FIRST)).toEqual({ intent: 'new', english: FIRST });
  });

  it('절을 이어 붙일 때 앞 문장의 마침표는 소문자/쉼표로 시작하는 절에서만 뗀다', () => {
    expect(joinClause('The storm abated.', 'which surprised everyone')).toBe('The storm abated which surprised everyone');
    expect(joinClause('The storm abated.', ', which surprised everyone')).toBe('The storm abated, which surprised everyone');
    expect(joinClause('The storm abated.', 'Nobody expected it.')).toBe('The storm abated. Nobody expected it.');
    expect(joinClause('abate', '')).toBe('abate');
  });

  it('스크린샷 사례: 20:36 저장 → 20:40 "아까 문장에 추가로 …" = 새 카드가 아니라 첫 카드에 이어 붙은 한 장', () => {
    // 20:36 — 영어만 → 바로 저장
    const first = classifyVocabMessageLocally(FIRST, false)!;
    expect(first.intent).toBe('new');
    const card = entry({ text: FIRST, key: normalizeVocabKey(FIRST), kind: 'sentence', meaning: '그것은 또한 우리의 와인 & 애피타이저 스페셜 나이트이기도 합니다' });

    // 20:40 — 한글 섞임 → 로컬 판단 불가 → Bedrock 분류 결과(append)로 분기
    expect(classifyVocabMessageLocally(SECOND, false)).toBeUndefined();
    const decision = parseVocabIntent(
      '{"intent":"append","english":"which offers a 5 percent discout on all appetizers and select winds","instruction":"아까 문장에 추가로"}'
    );
    expect(decision.intent).toBe('append');

    const joined = appendToEntry(card, decision.english);
    expect(joined.text).toBe(
      'that also happens to be our Wind & appetizer Special night which offers a 5 percent discout on all appetizers and select winds'
    );
    expect(joined.key).toBe(normalizeVocabKey(joined.text));
    expect(joined.key).not.toBe(card.key);
    expect(joined.kind).toBe('sentence');
    expect(joined.text).not.toMatch(/[가-힣]/);
    // 카드는 같은 pageId 한 장 — 새 카드 생성 경로(parseVocabMessage)로 가지 않는다
    expect({ ...card, ...joined }.pageId).toBe(PAGE_ID);
  });
});

describe('Bedrock 의도 분류 응답', () => {
  it('프롬프트에 마지막 카드와 메시지가 들어간다 (카드 없으면 "없음")', () => {
    const prompt = buildVocabIntentPrompt('아까 문장에 추가로 which offers a discount', { text: 'our Special night', meaning: '스페셜 나이트' });
    expect(prompt).toContain('"text": "our Special night"');
    expect(prompt).toContain('아까 문장에 추가로 which offers a discount');
    expect(buildVocabIntentPrompt('x')).toContain('마지막 카드: 없음');
  });

  it('intent 셋 중 하나가 아니면 throw, english에 남은 한국어는 떼어 낸다', () => {
    expect(parseVocabIntent('{"intent":"new","english":"take into account","instruction":""}')).toEqual({
      intent: 'new',
      english: 'take into account',
      instruction: undefined,
    });
    expect(parseVocabIntent('```json\n{"intent":"revise","english":"","instruction":"근무가 시작된다는 뜻이야"}\n```')).toMatchObject({
      intent: 'revise',
      instruction: '근무가 시작된다는 뜻이야',
    });
    // LLM이 지시를 english에 같이 넣어도 표현에는 한국어가 섞이지 않는다
    expect(parseVocabIntent('{"intent":"append","english":"아까 문장에 추가로 which offers a discount","instruction":""}')).toEqual({
      intent: 'append',
      english: 'which offers a discount',
      instruction: '아까 문장에 추가로',
    });
    expect(() => parseVocabIntent('{"intent":"delete","english":"x"}')).toThrow();
  });
});
