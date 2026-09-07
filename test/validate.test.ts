import {
  isValidDate,
  parseRoutineInput,
  parseStatusInput,
  parseTaskInput,
} from '../src/domain/routine';

function ok<T>(parsed: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!parsed.ok) throw new Error(`예상과 달리 실패: ${parsed.error}`);
  return parsed.value;
}

describe('isValidDate', () => {
  it('YYYY-MM-DD만 통과', () => {
    expect(isValidDate('2026-09-07')).toBe(true);
    expect(isValidDate('2026-9-7')).toBe(false);
    expect(isValidDate('20260907')).toBe(false);
    expect(isValidDate(20260907)).toBe(false);
    expect(isValidDate(undefined)).toBe(false);
  });

  it('없는 날짜는 거부 (JS Date의 자동 보정을 막는다)', () => {
    expect(isValidDate('2026-02-30')).toBe(false);
    expect(isValidDate('2026-13-01')).toBe(false);
    expect(isValidDate('2028-02-29')).toBe(true); // 윤년
  });
});

describe('parseRoutineInput', () => {
  const base = { title: '토플 Reading', daysOfWeek: [1, 3] };

  it('최소 입력이 통과하고 active는 기본 true', () => {
    const v = ok(parseRoutineInput(base));
    expect(v.title).toBe('토플 Reading');
    expect(v.daysOfWeek).toEqual([1, 3]);
    expect(v.active).toBe(true);
    expect(v.timeOfDay).toBeUndefined();
  });

  it('요일은 중복 제거 후 정렬', () => {
    expect(ok(parseRoutineInput({ ...base, daysOfWeek: [5, 1, 5, 0] })).daysOfWeek).toEqual([
      0, 1, 5,
    ]);
  });

  it('제목·요일이 없으면 거부', () => {
    expect(parseRoutineInput({ daysOfWeek: [1] })).toMatchObject({ ok: false });
    expect(parseRoutineInput({ title: '   ', daysOfWeek: [1] })).toMatchObject({ ok: false });
    expect(parseRoutineInput({ ...base, daysOfWeek: [] })).toMatchObject({ ok: false });
    expect(parseRoutineInput({ ...base, daysOfWeek: [7] })).toMatchObject({ ok: false });
    expect(parseRoutineInput({ ...base, daysOfWeek: [1.5] })).toMatchObject({ ok: false });
  });

  it('본문이 객체가 아니면 거부', () => {
    for (const bad of [undefined, null, 'x', 42, [base]]) {
      expect(parseRoutineInput(bad)).toMatchObject({ ok: false });
    }
  });

  it('시간은 HH:MM만', () => {
    expect(ok(parseRoutineInput({ ...base, timeOfDay: '09:05' })).timeOfDay).toBe('09:05');
    expect(ok(parseRoutineInput({ ...base, timeOfDay: '' })).timeOfDay).toBeUndefined();
    for (const bad of ['24:00', '9:05', '09:60', 'aa:bb', 900]) {
      expect(parseRoutineInput({ ...base, timeOfDay: bad })).toMatchObject({ ok: false });
    }
  });

  it('소요시간은 1~600 정수', () => {
    expect(ok(parseRoutineInput({ ...base, estimatedMinutes: 30 })).estimatedMinutes).toBe(30);
    expect(ok(parseRoutineInput({ ...base, estimatedMinutes: '' })).estimatedMinutes).toBeUndefined();
    for (const bad of [0, 601, 1.5, 'x']) {
      expect(parseRoutineInput({ ...base, estimatedMinutes: bad })).toMatchObject({ ok: false });
    }
  });

  it('슬롯을 전부 고르면 비운다 (전부 = 기본값과 같은 의미)', () => {
    expect(
      ok(parseRoutineInput({ ...base, remindSlots: ['morning', 'midday', 'evening'] })).remindSlots
    ).toBeUndefined();
    expect(ok(parseRoutineInput({ ...base, remindSlots: [] })).remindSlots).toBeUndefined();
    expect(ok(parseRoutineInput({ ...base, remindSlots: ['evening'] })).remindSlots).toEqual([
      'evening',
    ]);
  });

  it('없는 슬롯은 거부', () => {
    expect(parseRoutineInput({ ...base, remindSlots: ['night'] })).toMatchObject({ ok: false });
    expect(parseRoutineInput({ ...base, remindSlots: 'evening' })).toMatchObject({ ok: false });
  });

  it('길이 상한', () => {
    expect(parseRoutineInput({ ...base, title: 'a'.repeat(121) })).toMatchObject({ ok: false });
    expect(parseRoutineInput({ ...base, note: 'a'.repeat(301) })).toMatchObject({ ok: false });
    expect(parseRoutineInput({ ...base, category: 'a'.repeat(41) })).toMatchObject({ ok: false });
  });

  it('공백은 다듬는다', () => {
    const v = ok(parseRoutineInput({ ...base, title: '  운동  ', note: '  ' }));
    expect(v.title).toBe('운동');
    expect(v.note).toBeUndefined();
  });
});

describe('parseTaskInput / parseStatusInput', () => {
  it('단건 할일은 요일이 필요 없다', () => {
    expect(ok(parseTaskInput({ title: '병원 예약' })).title).toBe('병원 예약');
    expect(parseTaskInput({})).toMatchObject({ ok: false });
  });

  it('상태는 셋 중 하나만', () => {
    expect(ok(parseStatusInput({ status: 'done' }))).toBe('done');
    expect(ok(parseStatusInput({ status: 'todo' }))).toBe('todo');
    expect(ok(parseStatusInput({ status: 'skipped' }))).toBe('skipped');
    expect(parseStatusInput({ status: 'DONE' })).toMatchObject({ ok: false });
    expect(parseStatusInput(null)).toMatchObject({ ok: false });
    expect(parseStatusInput({})).toMatchObject({ ok: false });
  });
});
