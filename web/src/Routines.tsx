import { useCallback, useEffect, useState } from 'react';
import { DAY_LABEL, UnauthorizedError, api, type RoutineBody } from './api';
import type { BriefSlot, Routine } from './types';

interface Props {
  onUnauthorized: () => void;
}

const SLOT_LABEL: Record<BriefSlot, string> = {
  morning: '아침 9시',
  midday: '점심 12시',
  evening: '저녁 8시',
};
const SLOTS: BriefSlot[] = ['morning', 'midday', 'evening'];

const EMPTY: RoutineBody = { title: '', daysOfWeek: [], active: true };

export default function Routines({ onUnauthorized }: Props) {
  const [routines, setRoutines] = useState<Routine[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [editing, setEditing] = useState<{ id?: string; body: RoutineBody } | undefined>();

  const fail = useCallback(
    (err: unknown) => {
      if (err instanceof UnauthorizedError) onUnauthorized();
      else setError((err as Error).message);
    },
    [onUnauthorized]
  );

  const reload = useCallback(() => {
    api
      .listRoutines()
      .then((res) => setRoutines(res.routines))
      .catch(fail);
  }, [fail]);

  useEffect(reload, [reload]);

  const save = async (body: RoutineBody, id?: string) => {
    setError(undefined);
    try {
      if (id) await api.updateRoutine(id, body);
      else await api.createRoutine(body);
      setEditing(undefined);
      reload();
    } catch (err) {
      fail(err);
    }
  };

  const remove = async (routine: Routine) => {
    if (!confirm(`"${routine.title}" 루틴을 삭제할까요?\n이미 체크한 기록은 남습니다.`)) return;
    try {
      await api.deleteRoutine(routine.routineId);
      setEditing(undefined);
      reload();
    } catch (err) {
      fail(err);
    }
  };

  if (editing) {
    return (
      <RoutineForm
        initial={editing.body}
        editingId={editing.id}
        onCancel={() => setEditing(undefined)}
        onSave={(body) => save(body, editing.id)}
        error={error}
      />
    );
  }

  return (
    <>
      {error && <div className="banner">{error}</div>}

      <div className="daynav">
        <span className="today-label">주간 루틴</span>
        <span className="spacer" />
        <button className="btn primary" onClick={() => setEditing({ body: { ...EMPTY } })}>
          + 루틴 추가
        </button>
      </div>

      {routines === undefined ? (
        <div className="card">
          <p className="empty-state">불러오는 중…</p>
        </div>
      ) : routines.length === 0 ? (
        <div className="card">
          <p className="empty-state">
            아직 루틴이 없어요.
            <br />
            "월요일 = 토플 Reading" 처럼 요일마다 반복할 일을 등록하면
            <br />
            매일 9시·12시·8시에 텔레그램으로 챙겨줍니다.
          </p>
        </div>
      ) : (
        <div className="card">
          {DAY_LABEL.map((label, weekday) => {
            const onDay = routines
              .filter((r) => r.daysOfWeek.includes(weekday))
              .sort((a, b) => (a.timeOfDay ?? '99:99').localeCompare(b.timeOfDay ?? '99:99'));
            return (
              <div className="week-day" key={weekday}>
                <h3>{label}요일</h3>
                {onDay.length === 0 ? (
                  <div className="empty">—</div>
                ) : (
                  onDay.map((r) => (
                    <div
                      className={`routine-row${r.active ? '' : ' inactive'}`}
                      key={`${weekday}-${r.routineId}`}
                    >
                      <div className="grow">
                        <div className="title">{r.title}</div>
                        <div className="task-meta">
                          {[r.timeOfDay, r.estimatedMinutes && `${r.estimatedMinutes}분`]
                            .filter(Boolean)
                            .join(' · ') || '시간 미정'}
                          {r.category && <span className="tag" style={{ marginLeft: 6 }}>{r.category}</span>}
                        </div>
                      </div>
                      <button
                        className="btn ghost"
                        onClick={() => setEditing({ id: r.routineId, body: toBody(r) })}
                      >
                        수정
                      </button>
                    </div>
                  ))
                )}
              </div>
            );
          })}
        </div>
      )}

      {routines && routines.some((r) => !r.active) && (
        <p className="muted center" style={{ fontSize: 13 }}>
          취소선은 꺼둔 루틴입니다.
        </p>
      )}

      {routines && routines.length > 0 && (
        <div className="card">
          <h3 style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 6px' }}>전체 루틴</h3>
          {routines.map((r) => (
            <div className={`routine-row${r.active ? '' : ' inactive'}`} key={r.routineId}>
              <div className="grow">
                <div className="title">{r.title}</div>
                <div className="task-meta">
                  {r.daysOfWeek.map((d) => DAY_LABEL[d]).join('·')}
                  {r.remindSlots && r.remindSlots.length > 0 && (
                    <>
                      <span className="dot">·</span>
                      {r.remindSlots.map((s) => SLOT_LABEL[s]).join(', ')}만
                    </>
                  )}
                </div>
              </div>
              <button className="btn danger" onClick={() => remove(r)}>
                삭제
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function toBody(r: Routine): RoutineBody {
  return {
    title: r.title,
    daysOfWeek: [...r.daysOfWeek],
    timeOfDay: r.timeOfDay,
    remindSlots: r.remindSlots ? [...r.remindSlots] : undefined,
    category: r.category,
    estimatedMinutes: r.estimatedMinutes,
    note: r.note,
    active: r.active,
  };
}

function RoutineForm({
  initial,
  editingId,
  onCancel,
  onSave,
  error,
}: {
  initial: RoutineBody;
  editingId?: string;
  onCancel: () => void;
  onSave: (body: RoutineBody) => void;
  error?: string;
}) {
  const [body, setBody] = useState<RoutineBody>(initial);
  const set = <K extends keyof RoutineBody>(key: K, value: RoutineBody[K]) =>
    setBody((prev) => ({ ...prev, [key]: value }));

  const toggleDay = (d: number) =>
    set(
      'daysOfWeek',
      body.daysOfWeek.includes(d)
        ? body.daysOfWeek.filter((x) => x !== d)
        : [...body.daysOfWeek, d].sort((a, b) => a - b)
    );

  const slots = body.remindSlots ?? [...SLOTS];
  const toggleSlot = (s: BriefSlot) => {
    const next = slots.includes(s) ? slots.filter((x) => x !== s) : [...slots, s];
    set('remindSlots', next.length === 0 || next.length === SLOTS.length ? undefined : next);
  };

  const valid = body.title.trim().length > 0 && body.daysOfWeek.length > 0;

  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSave({ ...body, title: body.title.trim() });
      }}
    >
      <div className="daynav">
        <span className="today-label">{editingId ? '루틴 수정' : '새 루틴'}</span>
        <span className="spacer" />
        <button className="btn ghost" type="button" onClick={onCancel}>
          취소
        </button>
      </div>

      {error && <div className="banner">{error}</div>}

      <div className="field">
        <label htmlFor="r-title">할 일</label>
        <input
          id="r-title"
          type="text"
          value={body.title}
          maxLength={120}
          placeholder="예: 토플 Reading 1지문"
          onChange={(e) => set('title', e.target.value)}
        />
      </div>

      <div className="field">
        <label>반복 요일</label>
        <div className="daypicker">
          {DAY_LABEL.map((label, d) => (
            <button
              key={d}
              type="button"
              aria-pressed={body.daysOfWeek.includes(d)}
              onClick={() => toggleDay(d)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="row">
        <div className="field">
          <label htmlFor="r-time">시간 (선택)</label>
          <input
            id="r-time"
            type="time"
            value={body.timeOfDay ?? ''}
            onChange={(e) => set('timeOfDay', e.target.value || undefined)}
          />
        </div>
        <div className="field">
          <label htmlFor="r-min">예상 소요 (분)</label>
          <input
            id="r-min"
            type="number"
            min={1}
            max={600}
            value={body.estimatedMinutes ?? ''}
            onChange={(e) =>
              set('estimatedMinutes', e.target.value ? Number(e.target.value) : undefined)
            }
          />
        </div>
      </div>

      <div className="field">
        <label htmlFor="r-cat">분류 (선택)</label>
        <input
          id="r-cat"
          type="text"
          value={body.category ?? ''}
          maxLength={40}
          placeholder="toefl, health …"
          onChange={(e) => set('category', e.target.value || undefined)}
        />
      </div>

      <div className="field">
        <label htmlFor="r-note">메모 (선택)</label>
        <input
          id="r-note"
          type="text"
          value={body.note ?? ''}
          maxLength={300}
          onChange={(e) => set('note', e.target.value || undefined)}
        />
      </div>

      <div className="field">
        <label>어느 브리핑에 띄울까요</label>
        <div className="chips">
          {SLOTS.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={slots.includes(s)}
              onClick={() => toggleSlot(s)}
            >
              {SLOT_LABEL[s]}
            </button>
          ))}
        </div>
        <p className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
          아침 브리핑은 그날 할일을 전부 보여주고, 점심·저녁은 아직 남은 것만 알립니다.
        </p>
      </div>

      <div className="field">
        <label>
          <input
            type="checkbox"
            checked={body.active}
            style={{ width: 'auto', marginRight: 8 }}
            onChange={(e) => set('active', e.target.checked)}
          />
          사용 중
        </label>
      </div>

      <button className="btn primary" type="submit" disabled={!valid} style={{ width: '100%' }}>
        저장
      </button>
    </form>
  );
}
