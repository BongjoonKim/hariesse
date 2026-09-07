import { useCallback, useEffect, useMemo, useState } from 'react';
import { UnauthorizedError, api, dateLabel, shiftDate, summarize } from './api';
import type { TaskInstance, TaskStatus } from './types';

interface Props {
  today: string;
  onUnauthorized: () => void;
}

export default function Today({ today, onUnauthorized }: Props) {
  const [date, setDate] = useState(today);
  const [tasks, setTasks] = useState<TaskInstance[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [title, setTitle] = useState('');
  const [adding, setAdding] = useState(false);

  const fail = useCallback(
    (err: unknown) => {
      if (err instanceof UnauthorizedError) onUnauthorized();
      else setError((err as Error).message);
    },
    [onUnauthorized]
  );

  useEffect(() => {
    let stale = false;
    setTasks(undefined);
    setError(undefined);
    api
      .day(date)
      .then((res) => {
        if (!stale) setTasks(res.tasks);
      })
      .catch(fail);
    return () => {
      stale = true;
    };
  }, [date, fail]);

  const summary = useMemo(() => summarize(tasks ?? []), [tasks]);

  const patch = async (task: TaskInstance, status: TaskStatus) => {
    // 낙관적 반영 — 실패하면 되돌린다. 체크는 즉각적으로 느껴져야 한다.
    const before = tasks;
    setTasks((prev) => prev?.map((t) => (t.sk === task.sk ? { ...t, status } : t)));
    try {
      const res = await api.setStatus(date, task.sk, status);
      setTasks((prev) => prev?.map((t) => (t.sk === task.sk ? res.task : t)));
    } catch (err) {
      setTasks(before);
      fail(err);
    }
  };

  const addTask = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    setAdding(true);
    try {
      const res = await api.addTask(date, { title: trimmed });
      setTasks((prev) => [...(prev ?? []), res.task]);
      setTitle('');
    } catch (err) {
      fail(err);
    } finally {
      setAdding(false);
    }
  };

  const removeTask = async (task: TaskInstance) => {
    if (!confirm(`"${task.title}" 삭제할까요?`)) return;
    try {
      await api.deleteTask(date, task.sk);
      setTasks((prev) => prev?.filter((t) => t.sk !== task.sk));
    } catch (err) {
      fail(err);
    }
  };

  return (
    <>
      <div className="daynav">
        <button className="btn icon" onClick={() => setDate(shiftDate(date, -1))} aria-label="이전 날">
          ‹
        </button>
        <span className="today-label">{dateLabel(date)}</span>
        {date !== today && (
          <button className="btn ghost" onClick={() => setDate(today)}>
            오늘로
          </button>
        )}
        <span className="spacer" />
        <button className="btn icon" onClick={() => setDate(shiftDate(date, 1))} aria-label="다음 날">
          ›
        </button>
      </div>

      {error && <div className="banner">{error}</div>}

      <div className="card">
        {tasks === undefined ? (
          <p className="empty-state">불러오는 중…</p>
        ) : tasks.length === 0 ? (
          <p className="empty-state">
            이 날 할일이 없어요.
            <br />
            아래에서 추가하거나, 주간 루틴을 등록해 보세요.
          </p>
        ) : (
          <>
            <ul className="tasks">
              {tasks.map((task) => (
                <TaskRow
                  key={task.sk}
                  task={task}
                  onToggle={() => patch(task, task.status === 'done' ? 'todo' : 'done')}
                  onSkip={() => patch(task, task.status === 'skipped' ? 'todo' : 'skipped')}
                  onDelete={task.origin === 'adhoc' ? () => removeTask(task) : undefined}
                />
              ))}
            </ul>
            <div className="progress-line">
              <div className="progress">
                <span style={{ width: `${Math.round(summary.rate * 100)}%` }} />
              </div>
              <span>
                {summary.done}/{summary.total - summary.skipped} 완료
                {summary.skipped > 0 && ` · ${summary.skipped} 건너뜀`}
              </span>
            </div>
          </>
        )}

        <form className="inline" onSubmit={addTask}>
          <input
            type="text"
            value={title}
            placeholder="이 날만 할 일 추가"
            maxLength={120}
            onChange={(e) => setTitle(e.target.value)}
          />
          <button className="btn primary" type="submit" disabled={adding || !title.trim()}>
            추가
          </button>
        </form>
      </div>
    </>
  );
}

function TaskRow({
  task,
  onToggle,
  onSkip,
  onDelete,
}: {
  task: TaskInstance;
  onToggle: () => void;
  onSkip: () => void;
  onDelete?: () => void;
}) {
  const meta: string[] = [];
  if (task.timeOfDay) meta.push(task.timeOfDay);
  if (task.estimatedMinutes) meta.push(`${task.estimatedMinutes}분`);

  return (
    <li data-status={task.status}>
      <button
        className="check"
        data-status={task.status}
        onClick={onToggle}
        aria-label={task.status === 'done' ? '완료 취소' : '완료'}
      >
        {task.status === 'done' ? '✓' : task.status === 'skipped' ? '⏭' : ''}
      </button>
      <div className="task-body">
        <div className="task-title">{task.title}</div>
        {(meta.length > 0 || task.category || task.note) && (
          <div className="task-meta">
            {meta.join(' · ')}
            {meta.length > 0 && task.category && <span className="dot">·</span>}
            {task.category && <span className="tag">{task.category}</span>}
            {task.note && (
              <>
                <br />
                {task.note}
              </>
            )}
          </div>
        )}
      </div>
      <button className="btn ghost icon" onClick={onSkip} title="오늘은 건너뛰기">
        {task.status === 'skipped' ? '↩︎' : '⏭'}
      </button>
      {onDelete && (
        <button className="btn danger icon" onClick={onDelete} title="삭제">
          ✕
        </button>
      )}
    </li>
  );
}
