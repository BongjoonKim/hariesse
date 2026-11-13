import {
  normalizeWritingKey,
  needsWritingEnrichment,
  detectWritingCorrection,
  fillWritingFromEnrichment,
  applyWritingEnrichment,
  pickQuizEntries,
  applyQuizSent,
  WRITING_STATUS_LABEL,
} from '../src/domain/writing';
import { buildWritingProperties, parseWritingPage, WRITING_PROP } from '../src/lib/notion-writing';
import { formatWritingItem, formatWritingQuiz } from '../src/lib/telegram';
import { parseWritingEnrichment, buildWritingPrompt } from '../src/lib/bedrock';
import type { WritingEntry } from '../src/lib/types';

const TODAY = '2026-11-08';
const PAGE_ID = 'abcd1234abcd1234abcd1234abcd1234';

function entry(over: Partial<WritingEntry> = {}): WritingEntry {
  return { pageId: PAGE_ID, text: 'I needed something reliable for my long daily commute', quizCount: 0, ...over };
}

describe('채우기 대상', () => {
  test('상태가 비었거나 새로 추가거나 한국어가 비면 채운다', () => {
    expect(needsWritingEnrichment({ text: 'a b', status: undefined, korean: undefined })).toBe(true);
    expect(needsWritingEnrichment({ text: 'a b', status: 'new', korean: '뜻' })).toBe(true);
    expect(needsWritingEnrichment({ text: 'a b', status: 'active', korean: '' })).toBe(true);
    expect(needsWritingEnrichment({ text: 'a b', status: 'active', korean: '뜻' })).toBe(false);
  });
  test('빈 문장·제외 행은 건너뛴다', () => {
    expect(needsWritingEnrichment({ text: '  ', status: undefined, korean: undefined })).toBe(false);
    expect(needsWritingEnrichment({ text: 'a b', status: 'excluded', korean: undefined })).toBe(false);
  });
});

describe('교정 판별', () => {
  test('똑같거나 비어 있으면 교정이 아니다 (앞뒤 공백은 무시)', () => {
    expect(detectWritingCorrection('Which types of benefits do you prioritize?', ' Which types of benefits do you prioritize? ')).toBeUndefined();
    expect(detectWritingCorrection('x', '')).toBeUndefined();
    expect(detectWritingCorrection('x', undefined)).toBeUndefined();
  });
  test('대소문자·문장부호만 달라도 고친 문장으로 저장한다 (한 칸에 두니 제대로 된 문장으로)', () => {
    expect(detectWritingCorrection('which types of benefits do you prioritize', 'Which types of benefits do you prioritize?')).toBe(
      'Which types of benefits do you prioritize?'
    );
  });
  test('단어가 바뀌면 교정', () => {
    expect(detectWritingCorrection('The trainer was sick and could’t come', 'The trainer was sick and couldn’t come.')).toBe(
      'The trainer was sick and couldn’t come.'
    );
    expect(detectWritingCorrection('He wondered who presenting at the seminar', 'He wondered who was presenting at the seminar.')).toBe(
      'He wondered who was presenting at the seminar.'
    );
  });
  test('키는 단어장과 같은 규칙', () => {
    expect(normalizeWritingKey('  "Hello,  World!" ')).toBe('hello, world');
  });
});

describe('fillWritingFromEnrichment', () => {
  test('빈 칸만 채우고 사용자가 쓴 한국어·메모는 안 덮는다', () => {
    const filled = fillWritingFromEnrichment({ korean: '내가 쓴 뜻', note: '  ' }, { korean: '모델 뜻', note: '모델 메모' });
    expect(filled).toEqual({ korean: '내가 쓴 뜻', note: '모델 메모' });
  });
});

describe('applyWritingEnrichment', () => {
  test('고친 문장이 있으면 문장·키를 그걸로 바꾸고 상태는 출제 중', () => {
    const u = applyWritingEnrichment(
      { text: 'The trainer was sick and could’t come', key: 'the trainer was sick and could’t come', korean: undefined, note: undefined, quizCount: 0 },
      { korean: '트레이너가 아파서 올 수 없었다.', corrected: 'The trainer was sick and couldn’t come.', note: 'could’t → couldn’t 철자' }
    );
    expect(u).toEqual({
      text: 'The trainer was sick and couldn’t come.',
      key: "the trainer was sick and couldn't come", // 키는 따옴표를 곧은 것으로 정규화
      korean: '트레이너가 아파서 올 수 없었다.',
      note: 'could’t → couldn’t 철자',
      status: 'active',
      quizCount: 0,
    });
  });
  test('고칠 게 없으면 문장 키를 안 넣는다 (Notion 제목을 다시 쓰지 않게). 키는 있던 것 유지', () => {
    const u = applyWritingEnrichment({ text: 'Fine.', key: 'my-key', korean: '뜻', note: undefined, quizCount: 2 }, { korean: '모델 뜻', corrected: '', note: '표현: 뜻' });
    expect(u).toEqual({ key: 'my-key', korean: '뜻', note: '표현: 뜻', status: 'active', quizCount: 2 });
    expect('text' in u).toBe(false);
    expect(applyWritingEnrichment({ text: 'Fine.', quizCount: 0 }, { korean: '뜻' }).key).toBe('fine');
  });
});

describe('pickQuizEntries', () => {
  const list = [
    entry({ pageId: 'p1', korean: '1', quizCount: 1, lastQuizzed: '2026-11-01' }),
    entry({ pageId: 'p2', korean: '2', quizCount: 0 }),
    entry({ pageId: 'p3', korean: '3', quizCount: 1, lastQuizzed: '2026-10-20' }),
    entry({ pageId: 'p4', korean: undefined, quizCount: 0 }),
    entry({ pageId: 'p5', korean: '5', quizCount: 0, status: 'excluded' }),
    entry({ pageId: 'p6', korean: '6', quizCount: 0 }),
  ];
  test('덜 나온 것 → 오래전에 나온 것 → 추가 순. 한국어 없음·제외는 빠진다', () => {
    expect(pickQuizEntries(list, 10).map((e) => e.pageId)).toEqual(['p2', 'p6', 'p3', 'p1']);
  });
  test('limit', () => {
    expect(pickQuizEntries(list, 2).map((e) => e.pageId)).toEqual(['p2', 'p6']);
    expect(pickQuizEntries(list, 0)).toEqual([]);
  });
  test('출제하면 횟수 +1, 마지막 출제 = 오늘, 상태 = 출제 중', () => {
    expect(applyQuizSent({ quizCount: 2 }, TODAY)).toEqual({ quizCount: 3, lastQuizzed: TODAY, status: 'active' });
  });
});

describe('Notion 매핑', () => {
  test('넘긴 키만 properties로 만든다', () => {
    const props = buildWritingProperties({ quizCount: 1, lastQuizzed: TODAY, status: 'active' });
    expect(Object.keys(props).sort()).toEqual([WRITING_PROP.quizCount, WRITING_PROP.status, WRITING_PROP.lastQuizzed].sort());
    expect(props[WRITING_PROP.status]).toEqual({ select: { name: WRITING_STATUS_LABEL.active } });
    expect(props[WRITING_PROP.lastQuizzed]).toEqual({ date: { start: TODAY } });
  });
  test('값이 undefined인 키는 칸을 비운다', () => {
    const props = buildWritingProperties({ note: undefined, lastQuizzed: undefined });
    expect(props[WRITING_PROP.note]).toEqual({ rich_text: [] });
    expect(props[WRITING_PROP.lastQuizzed]).toEqual({ date: null });
  });
  test('page → entry 왕복', () => {
    const page = {
      id: 'abcd1234-abcd-1234-abcd-1234abcd1234',
      created_time: '2026-11-07T23:30:00.000Z',
      properties: {
        ...buildWritingProperties({
          text: 'She told us it should be finalized.',
          key: 'she told us it should be finalized',
          korean: '그녀는 그것이 마무리되어야 한다고 말했다',
          note: 'finialized → finalized 철자',
          source: 'Power Test 2 (p70)',
          order: 8,
          status: 'new',
          quizCount: 0,
        }),
      },
    };
    // Notion이 돌려주는 형식(plain_text)으로 바꿔서 파싱
    const asNotion = JSON.parse(
      JSON.stringify(page).replace(/"text":\{"content":"([^"]*)"\}/g, '"plain_text":"$1"')
    );
    const e = parseWritingPage(asNotion);
    expect(e.pageId).toBe(PAGE_ID);
    expect(e.text).toBe('She told us it should be finalized.');
    expect(e.note).toBe('finialized → finalized 철자');
    expect(e.source).toBe('Power Test 2 (p70)');
    expect(e.order).toBe(8);
    expect(e.status).toBe('new');
    expect(e.quizCount).toBe(0);
    expect(e.lastQuizzed).toBeUndefined();
    expect(e.createdDate).toBe('2026-11-08'); // KST
  });
  test('손으로 넣은 빈 행. 옛 교정 칸이 남아 있어도 무시', () => {
    const e = parseWritingPage({
      id: PAGE_ID,
      properties: { [WRITING_PROP.text]: { title: [{ plain_text: 'Hi there' }] }, 교정: { rich_text: [{ plain_text: 'Hi there.' }] } },
    });
    expect(e).not.toHaveProperty('corrected');
    expect(e).toMatchObject({ text: 'Hi there', quizCount: 0, status: undefined, korean: undefined });
  });
});

describe('Telegram 포맷', () => {
  test('한국어만 보이고 영어는 스포일러. 정답 = 문장 + 메모', () => {
    const msg = formatWritingItem(
      entry({
        text: 'He wondered who was presenting at the seminar.',
        korean: '그는 세미나에서 누가 발표하는지 궁금해했다.',
        note: 'who presenting → who was presenting',
        source: 'Power Test 2 (p70)',
      }),
      0,
      5
    );
    expect(msg).toContain('<b>1/5</b>');
    expect(msg).toContain('Power Test 2 (p70)');
    expect(msg).toContain('그는 세미나에서 누가 발표하는지 궁금해했다.');
    const spoiler = msg.slice(msg.indexOf('<tg-spoiler>'), msg.indexOf('</tg-spoiler>'));
    expect(spoiler).toContain('He wondered who was presenting at the seminar.');
    expect(spoiler).not.toContain('내가 쓴 것');
    expect(spoiler).toContain('💡 who presenting');
    // 영어는 스포일러 밖에 없어야 문제가 된다
    expect(msg.slice(0, msg.indexOf('<tg-spoiler>'))).not.toContain('wondered');
  });
  test('메모가 없으면 스포일러엔 문장만', () => {
    const msg = formatWritingItem(entry({ korean: '긴 통근에 쓸 믿을 만한 게 필요했다.' }), 2, 5);
    expect(msg).toContain('<b>3/5</b>');
    expect(msg).toContain('<tg-spoiler>I needed something reliable for my long daily commute</tg-spoiler>');
  });
  test('헤더 + 5문장이 메시지 1개에 들어간다. HTML은 이스케이프', () => {
    const msgs = formatWritingQuiz(
      Array.from({ length: 5 }, (_, i) => entry({ pageId: `p${i}`, korean: `문제 ${i} <b>`, text: `Answer ${i} & co` }))
    );
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain('✍️ <b>오늘의 TOEFL Writing</b> — 5문장');
    expect(msgs[0]).toContain('문제 0 &lt;b&gt;');
    expect(msgs[0]).toContain('Answer 0 &amp; co');
    expect(msgs[0].split('<tg-spoiler>')).toHaveLength(6);
  });
});

describe('Bedrock Writing 응답', () => {
  test('JSON 파싱, 빈 교정은 undefined', () => {
    const e = parseWritingEnrichment('{"korean": "뜻", "corrected": "", "note": "메모"}');
    expect(e).toEqual({ korean: '뜻', corrected: undefined, note: '메모' });
  });
  test('앞뒤 잡담이 있어도 JSON만 읽는다', () => {
    const e = parseWritingEnrichment('네, 결과입니다.\n{"korean": "뜻", "corrected": "Fixed.", "note": ""}\n끝');
    expect(e).toEqual({ korean: '뜻', corrected: 'Fixed.', note: undefined });
  });
  test('한국어가 없으면 throw', () => {
    expect(() => parseWritingEnrichment('{"corrected": "x"}')).toThrow();
  });
  test('프롬프트에 사용자가 적은 한국어가 들어간다', () => {
    expect(buildWritingPrompt('Hi', '안녕')).toContain('안녕');
    expect(buildWritingPrompt('Hi')).not.toContain('사용자가 적은');
  });
});
