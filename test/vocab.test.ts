import {
  addDays,
  shortDate,
  kstDate,
  normalizeVocabKey,
  detectKind,
  parseVocabMessage,
  fillFromEnrichment,
  applyTypoFix,
  editDistance,
  splitKoreanMemo,
  withUserMemo,
  initialReview,
  applyReview,
  applyRepeatCapture,
  pickDueEntries,
  needsEnrichment,
  encodeVocabCallback,
  decodeVocabCallback,
  MAX_INPUTS_PER_MESSAGE,
  type ReviewFields,
  type VocabAction,
} from '../src/domain/vocab';
import { buildVocabProperties, parseVocabPage, VOCAB_PROP } from '../src/lib/notion-vocab';
import { formatVocabCard, formatReviewItem } from '../src/lib/telegram';
import { parseVocabEnrichment, buildVocabPrompt } from '../src/lib/bedrock';
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

  it('영어 뒤에 붙여 쓴 한국어 메모는 표현에서 떼어낸다', () => {
    expect(splitKoreanMemo('Thank you all for being so proactive가 모두 매우 선제적으로 움직여줘서 고마워요 라는 뜻')).toEqual({
      text: 'Thank you all for being so proactive',
      memo: '모두 매우 선제적으로 움직여줘서 고마워요 라는 뜻',
    });
    expect(
      splitKoreanMemo(
        "I'll finish preparing the Interactive Data Storytelling case studies and share them with everyone by Monday morning에서 case studies가 사례 연구래"
      )
    ).toEqual({
      text: "I'll finish preparing the Interactive Data Storytelling case studies and share them with everyone by Monday morning",
      memo: 'case studies가 사례 연구래',
    });
    // 조사 뒤에 공백이 없으면 메모의 일부로 본다 ("이해" 의 "이"를 떼면 안 됨)
    expect(splitKoreanMemo('ubiquitous 이해했다').memo).toBe('이해했다');
  });

  it('영어만 있거나 한국어로 시작하면 그대로', () => {
    expect(splitKoreanMemo('The findings corroborate the hypothesis.')).toEqual({
      text: 'The findings corroborate the hypothesis.',
    });
    expect(splitKoreanMemo('선제적인 = proactive')).toEqual({ text: '선제적인 = proactive' });
  });

  it('메시지 파싱: 메모를 떼고 종류는 영어 부분으로 판별', () => {
    expect(parseVocabMessage('case studies가 사례 연구래 #work')).toEqual([
      { text: 'case studies', memo: '사례 연구래', meaning: undefined, tags: ['work'], kind: 'word' },
    ]);
    expect(parseVocabMessage('mitigate :: 완화하다')[0]).toMatchObject({ text: 'mitigate', meaning: '완화하다', memo: undefined });
  });

  it('메모는 메모 칸 끝에 "내 느낀점"으로 붙이고 중복으로 붙이지 않는다', () => {
    expect(withUserMemo('case studies: 사례 연구', '사례 연구래')).toBe('case studies: 사례 연구\n🙋 내 느낀점: 사례 연구래');
    expect(withUserMemo(undefined, '사례 연구래')).toBe('🙋 내 느낀점: 사례 연구래');
    expect(withUserMemo('팁', undefined)).toBe('팁');
    expect(withUserMemo('팁\n🙋 내 느낀점: 메모', '메모')).toBe('팁\n🙋 내 느낀점: 메모');
  });

  it('한 메시지 최대 건수 제한', () => {
    const many = Array.from({ length: 15 }, (_, i) => `word${i}`).join('\n');
    expect(parseVocabMessage(many)).toHaveLength(MAX_INPUTS_PER_MESSAGE);
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

describe('오타 수정', () => {
  const SENTENCE =
    "However few realize that the company's very first project was a pro-bono initiative - developing a secure data management platform for locla non-profits";

  it('편집 거리: 인접 글자 뒤바꿈은 1', () => {
    expect(editDistance('locla', 'local')).toBe(1);
    expect(editDistance('teh', 'the')).toBe(1);
    expect(editDistance('recieve', 'receive')).toBe(1);
    expect(editDistance('big', 'large')).toBe(4);
    expect(editDistance('', 'abc')).toBe(3);
  });

  it('문장 속 오타 단어만 고친다 (locla → local)', () => {
    const fix = applyTypoFix(SENTENCE, SENTENCE.replace('locla', 'local'));
    expect(fix.text).toBe(SENTENCE.replace('locla', 'local'));
    expect(fix.fixes).toEqual(['locla → local']);
  });

  it('여러 오타를 각각 기록', () => {
    expect(applyTypoFix('teh goverment', 'the government')).toEqual({
      text: 'the government',
      fixes: ['teh → the', 'goverment → government'],
    });
  });

  it('고칠 게 없거나 응답이 비면 원래 입력 그대로', () => {
    expect(applyTypoFix('ubiquitous', 'ubiquitous')).toEqual({ text: 'ubiquitous', fixes: [] });
    expect(applyTypoFix('ubiquitous', undefined)).toEqual({ text: 'ubiquitous', fixes: [] });
    expect(applyTypoFix('ubiquitous', '  ')).toEqual({ text: 'ubiquitous', fixes: [] });
  });

  it('단어 바꾸기·문법 수정은 오타가 아니므로 반영하지 않는다', () => {
    expect(applyTypoFix('a big house', 'a large house').fixes).toEqual([]);
    expect(applyTypoFix('He go to school', 'He goes to school').fixes).toEqual([]);
    // 오타는 고치고 문법 수정만 버린다
    expect(applyTypoFix('He go to scohol', 'He goes to school')).toEqual({
      text: 'He go to school',
      fixes: ['scohol → school'],
    });
  });

  it('띄어쓰기 오타는 받고, 단어를 덧붙인 재작성은 버린다', () => {
    expect(applyTypoFix('I like it alot', 'I like it a lot')).toEqual({
      text: 'I like it a lot',
      fixes: ['alot → a lot'],
    });
    expect(applyTypoFix('a big house', 'a very big house').fixes).toEqual([]);
    expect(applyTypoFix('one two', 'one two three four').fixes).toEqual([]);
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

  it('문장 카드는 "번역", 뜻이 비면 안내', () => {
    expect(formatVocabCard(entry({ kind: 'sentence', meaning: '번역문' }), { repeated: false })).toContain('번역: 번역문');
    expect(formatVocabCard(entry({ meaning: undefined }), { repeated: false })).toContain('뜻을 아직 못 채웠어요');
  });

  it('오타를 고쳤으면 카드에 고친 내역을 보여준다', () => {
    const card = formatVocabCard(entry({ text: 'for local non-profits' }), { repeated: false, fixes: ['locla → local'] });
    expect(card).toContain('<b>for local non-profits</b>');
    expect(card).toContain('✏️ 오타 고침: locla → local');
    expect(formatVocabCard(entry(), { repeated: false, fixes: [] })).not.toContain('오타');
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
    });
  });

  it('corrected(오타 고친 입력)를 읽는다', () => {
    expect(parseVocabEnrichment('{"meaning":"지역의","corrected":" local "}').corrected).toBe('local');
    expect(parseVocabEnrichment('{"meaning":"지역의"}').corrected).toBeUndefined();
  });

  it('뜻이 없으면 throw', () => {
    expect(() => parseVocabEnrichment('{"meaning":""}')).toThrow();
  });

  it('프롬프트에 사용자 뜻을 기준으로 넣는다', () => {
    expect(buildVocabPrompt('bank', 'word', '둑')).toContain('사용자가 적은 뜻');
    expect(buildVocabPrompt('bank', 'word')).not.toContain('사용자가 적은 뜻');
  });
});
