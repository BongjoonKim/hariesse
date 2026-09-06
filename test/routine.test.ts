import {
  ALL_SLOTS,
  dateLabel,
  dayPk,
  decodeTaskCallback,
  encodeTaskCallback,
  kstMoment,
  orderTasksBy,
  planForDay,
  routineRunsOn,
  shiftDate,
  shouldSendBrief,
  skipToggleStatus,
  slotsOf,
  sortTasks,
  summarizeDay,
  tasksForSlot,
  toggleStatus,
  weekdayOf,
} from '../src/domain/routine';
import type { BriefSlot, Routine, TaskInstance, TaskStatus } from '../src/lib/types';

const AT = '2026-09-07T00:10:00.000Z';

function routine(over: Partial<Routine> = {}): Routine {
  return {
    pk: 'ROUTINE',
    sk: 'r1',
    routineId: 'r1',
    title: '토플 Reading',
    daysOfWeek: [1],
    active: true,
    createdAt: AT,
    updatedAt: AT,
    ...over,
  };
}

function task(over: Partial<TaskInstance> = {}): TaskInstance {
  return {
    pk: dayPk('2026-09-07'),
    sk: 't1',
    date: '2026-09-07',
    title: '할일',
    status: 'todo',
    origin: 'routine',
    createdAt: AT,
    updatedAt: AT,
    ...over,
  };
}

describe('KST 시간 계산', () => {
  it('UTC 자정 직후는 이미 KST로 다음 날 오전 9시', () => {
    expect(kstMoment(new Date('2026-09-06T00:00:00Z'))).toEqual({
      date: '2026-09-06',
      weekday: 0, // 일요일
      time: '09:00',
    });
  });

  it('UTC 늦은 밤은 KST 기준 다음 날로 넘어간다', () => {
    const m = kstMoment(new Date('2026-09-06T15:30:00Z'));
    expect(m.date).toBe('2026-09-07'); // 월요일 00:30 KST
    expect(m.weekday).toBe(1);
    expect(m.time).toBe('00:30');
  });

  it('shiftDate는 월 경계를 넘긴다', () => {
    expect(shiftDate('2026-08-31', 1)).toBe('2026-09-01');
    expect(shiftDate('2026-09-01', -1)).toBe('2026-08-31');
  });

  it('weekdayOf / dateLabel', () => {
    expect(weekdayOf('2026-09-07')).toBe(1);
    expect(dateLabel('2026-09-07')).toBe('09/07(월)');
  });
});

describe('루틴 → 하루 전개', () => {
  it('해당 요일 + active인 루틴만 전개한다', () => {
    const routines = [
      routine({ routineId: 'mon', sk: 'mon', daysOfWeek: [1] }),
      routine({ routineId: 'tue', sk: 'tue', daysOfWeek: [2] }),
      routine({ routineId: 'off', sk: 'off', daysOfWeek: [1], active: false }),
    ];
    const plan = planForDay(routines, '2026-09-07', AT); // 월요일
    expect(plan.map((t) => t.sk)).toEqual(['mon']);
    expect(plan[0].pk).toBe('DAY#2026-09-07');
    expect(plan[0].status).toBe('todo');
    expect(plan[0].origin).toBe('routine');
  });

  it('전개된 아이템에 TTL이 붙는다', () => {
    const plan = planForDay([routine()], '2026-09-07', AT, 10);
    expect(plan[0].ttl).toBe(Math.floor(new Date(AT).getTime() / 1000) + 10 * 86400);
  });

  it('routineRunsOn은 비활성 루틴을 거른다', () => {
    expect(routineRunsOn(routine({ daysOfWeek: [1] }), 1)).toBe(true);
    expect(routineRunsOn(routine({ daysOfWeek: [1] }), 2)).toBe(false);
    expect(routineRunsOn(routine({ daysOfWeek: [1], active: false }), 1)).toBe(false);
  });

  it('remindSlots가 없으면 3회 모두', () => {
    expect(slotsOf({})).toEqual([...ALL_SLOTS]);
    expect(slotsOf({ remindSlots: [] })).toEqual([...ALL_SLOTS]);
    expect(slotsOf({ remindSlots: ['evening'] })).toEqual(['evening']);
  });
});

describe('정렬·요약', () => {
  it('시각 있는 것이 먼저, 이른 순', () => {
    const sorted = sortTasks([
      task({ sk: 'c', title: '가나다' }),
      task({ sk: 'a', timeOfDay: '21:00', title: '늦은것' }),
      task({ sk: 'b', timeOfDay: '09:00', title: '이른것' }),
    ]);
    expect(sorted.map((t) => t.sk)).toEqual(['b', 'a', 'c']);
  });

  it('완료율은 스킵을 분모에서 뺀다', () => {
    const s = summarizeDay([
      task({ sk: '1', status: 'done' }),
      task({ sk: '2', status: 'todo' }),
      task({ sk: '3', status: 'skipped' }),
    ]);
    expect(s).toEqual({ total: 3, done: 1, skipped: 1, todo: 1, rate: 0.5 });
  });

  it('전부 스킵이면 0으로 나누지 않고 1', () => {
    expect(summarizeDay([task({ status: 'skipped' })]).rate).toBe(1);
    expect(summarizeDay([]).rate).toBe(1);
  });
});

describe('슬롯별 노출', () => {
  const tasks = [
    task({ sk: 'done', status: 'done', timeOfDay: '08:00' }),
    task({ sk: 'todo', status: 'todo', timeOfDay: '09:00' }),
    task({ sk: 'eveOnly', status: 'todo', timeOfDay: '10:00', remindSlots: ['evening'] }),
  ];

  it('아침은 상태와 무관하게 전부 보여준다', () => {
    expect(tasksForSlot(tasks, 'morning').map((t) => t.sk)).toEqual(['done', 'todo', 'eveOnly']);
  });

  it('점심은 남은 것 중 해당 슬롯 구독분만', () => {
    expect(tasksForSlot(tasks, 'midday').map((t) => t.sk)).toEqual(['todo']);
  });

  it('저녁은 evening 전용 루틴까지 포함', () => {
    expect(tasksForSlot(tasks, 'evening').map((t) => t.sk)).toEqual(['todo', 'eveOnly']);
  });
});

describe('상태 전이', () => {
  it('토글은 완료↔미완료를 오간다 (오탭 되돌리기)', () => {
    expect(toggleStatus('todo')).toBe('done');
    expect(toggleStatus('done')).toBe('todo');
    expect(toggleStatus('skipped')).toBe('done');
  });

  it('스킵도 같은 버튼으로 되돌아온다', () => {
    expect(skipToggleStatus('todo')).toBe('skipped');
    expect(skipToggleStatus('skipped')).toBe('todo');
    expect(skipToggleStatus('done')).toBe('skipped');
  });
});

describe('callback_data', () => {
  it('왕복 인코딩', () => {
    const data = encodeTaskCallback('toggle', '2026-09-07', 'evening', 'a1b2c3d4');
    expect(data).toBe('t1|toggle|20260907|e|a1b2c3d4');
    expect(decodeTaskCallback(data)).toEqual({
      action: 'toggle',
      date: '2026-09-07',
      slot: 'evening',
      sk: 'a1b2c3d4',
    });
  });

  it('Telegram 64바이트 제한 안에 들어간다', () => {
    const slots: BriefSlot[] = ['morning', 'midday', 'evening'];
    for (const slot of slots) {
      const data = encodeTaskCallback('toggle', '2026-09-07', slot, 'deadbeef');
      expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
    }
  });

  it('잘못된 데이터는 undefined', () => {
    expect(decodeTaskCallback(undefined)).toBeUndefined();
    expect(decodeTaskCallback('')).toBeUndefined();
    expect(decodeTaskCallback('v1|like|abc')).toBeUndefined(); // 다이제스트 피드백은 여기서 안 잡힌다
    expect(decodeTaskCallback('t1|nope|20260907|m|a1')).toBeUndefined();
    expect(decodeTaskCallback('t1|toggle|2026-09-07|m|a1')).toBeUndefined();
    expect(decodeTaskCallback('t1|toggle|20260907|z|a1')).toBeUndefined();
    expect(decodeTaskCallback('t1|toggle|20260907|m|')).toBeUndefined();
  });
});

describe('메시지 재구성', () => {
  it('버튼에 실렸던 순서를 그대로 유지하고, 사라진 항목은 뺀다', () => {
    const tasks = [task({ sk: 'b' }), task({ sk: 'a' }), task({ sk: 'c' })];
    expect(orderTasksBy(['a', 'b', 'gone'], tasks).map((t) => t.sk)).toEqual(['a', 'b']);
  });
});

describe('전송 여부', () => {
  it('아침은 할일이 없어도 보낸다', () => {
    expect(shouldSendBrief('morning', 0, 0)).toBe(true);
  });

  it('할일 없는 날의 점심/저녁은 건너뛴다', () => {
    expect(shouldSendBrief('midday', 0, 3)).toBe(false);
    expect(shouldSendBrief('evening', 0, 0)).toBe(false);
  });

  it('저녁은 내일 할일이 있으면 미리보기용으로 보낸다', () => {
    expect(shouldSendBrief('evening', 0, 2)).toBe(true);
    expect(shouldSendBrief('midday', 2, 0)).toBe(true);
  });
});

describe('상태 타입', () => {
  it('TaskStatus 값이 아이콘 매핑과 어긋나지 않는다', () => {
    const all: TaskStatus[] = ['todo', 'done', 'skipped'];
    expect(new Set(all).size).toBe(3);
  });
});
