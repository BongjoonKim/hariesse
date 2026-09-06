import { buildTaskKeyboard, formatBrief } from '../src/lib/telegram';
import { dayPk, decodeTaskCallback } from '../src/domain/routine';
import type { TaskInstance } from '../src/lib/types';

const AT = '2026-09-07T00:10:00.000Z';
const DATE = '2026-09-07'; // 월요일

function task(over: Partial<TaskInstance> = {}): TaskInstance {
  return {
    pk: dayPk(DATE),
    sk: 'a1b2c3d4',
    date: DATE,
    title: '토플 Reading 1지문',
    status: 'todo',
    origin: 'routine',
    createdAt: AT,
    updatedAt: AT,
    ...over,
  };
}

describe('formatBrief', () => {
  it('아침 브리핑은 번호·아이콘·시각·소요시간을 담는다', () => {
    const tasks = [task({ timeOfDay: '21:00', estimatedMinutes: 30 })];
    const text = formatBrief('morning', DATE, tasks, tasks);
    expect(text).toContain('좋은 아침이에요');
    expect(text).toContain('09/07(월)');
    expect(text).toContain('1. ⬜ 21:00 토플 Reading 1지문 (30분)');
    expect(text).toContain('오늘 1개');
  });

  it('할일이 하나도 없는 날엔 안내 문구', () => {
    const text = formatBrief('morning', DATE, [], []);
    expect(text).toContain('오늘 등록된 할일이 없어요');
    expect(text).not.toContain('진행');
  });

  it('점심/저녁은 진행률을 보여준다 (스킵은 분모 제외)', () => {
    const day = [
      task({ sk: '1', status: 'done' }),
      task({ sk: '2', status: 'todo' }),
      task({ sk: '3', status: 'skipped' }),
    ];
    const text = formatBrief('midday', DATE, [day[1]], day);
    expect(text).toContain('진행 1/2 (50%)');
  });

  it('남은 게 없으면 격려 문구로 바뀐다', () => {
    const day = [task({ status: 'done' })];
    expect(formatBrief('midday', DATE, [], day)).toContain('남은 할일이 없네요');
    expect(formatBrief('evening', DATE, [], day)).toContain('오늘 할일 전부 끝냈어요');
  });

  it('저녁에는 내일 미리보기가 붙는다', () => {
    const day = [task({ status: 'done' })];
    const tomorrow = [task({ sk: 'x', date: '2026-09-08', title: '토플 Listening 2섹션' })];
    const text = formatBrief('evening', DATE, [], day, tomorrow);
    expect(text).toContain('📌 내일 09/08(화): 토플 Listening 2섹션');
  });

  it('내일 할일이 없어도 명시한다', () => {
    expect(formatBrief('evening', DATE, [], [task()], [])).toContain(
      '📌 내일 09/08(화): 등록된 할일 없음'
    );
  });

  it('제목의 HTML은 이스케이프한다', () => {
    const text = formatBrief('morning', DATE, [task({ title: '<b>주의</b> & 확인' })], [task()]);
    expect(text).toContain('&lt;b&gt;주의&lt;/b&gt; &amp; 확인');
    expect(text).not.toContain('<b>주의</b>');
  });
});

describe('buildTaskKeyboard', () => {
  it('할일마다 [체크][스킵] 한 줄, callback_data는 슬롯·날짜·sk를 담는다', () => {
    const tasks = [task({ sk: 'aaaa1111' }), task({ sk: 'bbbb2222' })];
    const kb = buildTaskKeyboard('morning', DATE, tasks)!;
    expect(kb.inline_keyboard).toHaveLength(2);
    expect(kb.inline_keyboard[0]).toHaveLength(2);
    expect(decodeTaskCallback(kb.inline_keyboard[0][0].callback_data)).toEqual({
      action: 'toggle',
      date: DATE,
      slot: 'morning',
      sk: 'aaaa1111',
    });
    expect(decodeTaskCallback(kb.inline_keyboard[1][1].callback_data)).toMatchObject({
      action: 'skip',
      sk: 'bbbb2222',
    });
  });

  it('완료·스킵 상태는 되돌리기 버튼으로 바뀐다', () => {
    const kb = buildTaskKeyboard('midday', DATE, [
      task({ sk: 'd', status: 'done' }),
      task({ sk: 's', status: 'skipped' }),
    ])!;
    expect(kb.inline_keyboard[0][0].text.startsWith('↩️')).toBe(true);
    expect(kb.inline_keyboard[1][1].text).toBe('↩️');
  });

  it('긴 제목은 버튼 라벨에서 잘린다', () => {
    const kb = buildTaskKeyboard('morning', DATE, [task({ title: '가'.repeat(50) })])!;
    expect(kb.inline_keyboard[0][0].text.length).toBeLessThanOrEqual(24);
    expect(kb.inline_keyboard[0][0].text).toContain('…');
  });

  it('보여줄 할일이 없으면 키보드를 만들지 않는다', () => {
    expect(buildTaskKeyboard('evening', DATE, [])).toBeUndefined();
  });
});
