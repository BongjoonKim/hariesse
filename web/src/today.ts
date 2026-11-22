import { h, md, weekday, type Child } from './dom';
import { act, go, rerender, state, toast, upsertVocab, upsertWriting } from './app';
import { startDailyWriting, startDueReview } from './session';
import type { AddOutcome, Mission, TodayPayload } from '../../src/lib/web-types';

/** 오늘 화면 — 미션 목록, 진행률, 연속 기록. */

const ui = {
  addOpen: false,
  addTarget: 'vocab' as 'vocab' | 'writing',
  addText: '',
  adding: false,
  outcomes: [] as AddOutcome[],
  bookMemo: undefined as string | undefined,
};

export function todayView(): Child {
  const t = state.today;
  if (!t) return h('p', { class: 'boot' }, '불러오는 중…');
  const pct = t.summary.total ? Math.round((t.summary.done / t.summary.total) * 100) : 0;
  const week = t.history.slice(-7);
  return [
    h(
      'div',
      { class: 'topbar' },
      h('div', null, h('h1', null, '오늘의 미션'), h('div', { class: 'sub' }, `${md(t.date)} (${weekday(t.date)})`)),
      h('div', { class: `streak${t.streak.current > 0 ? ' on' : ''}`, title: `최고 ${t.streak.best}일` }, '🔥 ', t.streak.current, '일')
    ),
    h(
      'div',
      { class: 'card' },
      h(
        'div',
        { class: 'hero' },
        h('div', { class: 'ring', style: `--p:${pct}`, role: 'img', 'aria-label': `미션 ${t.summary.done}/${t.summary.total}` }, h('div', null, `${t.summary.done}/${t.summary.total}`)),
        h('div', null, h('h2', null, headline(t)), h('p', { class: 'muted small' }, subline(t)))
      ),
      h(
        'div',
        { class: 'week' },
        week.map((d) =>
          h(
            'div',
            { class: [d.complete ? 'done' : d.done > 0 ? 'some' : '', d.date === t.date ? 'now' : ''].join(' ') },
            h('i', null, d.complete ? '✓' : ''),
            weekday(d.date)
          )
        )
      )
    ),
    h('div', { class: 'section-title' }, '할 일'),
    h('div', { class: 'stack' }, t.missions.map((m) => missionCard(m, t))),
    t.summary.complete && h('div', { class: 'banner', style: 'margin-top:12px' }, '🎉 오늘 미션을 다 했어요. 내일도 이어 가요!'),
  ];
}

function headline(t: TodayPayload): string {
  if (t.summary.complete) return `${t.streak.current}일 연속 달성!`;
  if (t.summary.done === 0) return t.streak.current > 0 ? `${t.streak.current}일 연속을 이어 갈 차례` : '오늘 하나만 시작해 봐요';
  return `${t.summary.total - t.summary.done}개 남았어요`;
}

function subline(t: TodayPayload): string {
  if (t.summary.complete) return `최고 기록 ${t.streak.best}일`;
  const next = t.missions.find((m) => !m.complete);
  return next ? `다음: ${next.emoji} ${next.title}` : '';
}

function missionCard(m: Mission, t: TodayPayload): HTMLElement {
  const pct = m.goal ? Math.round((m.done / m.goal) * 100) : 100;
  return h(
    'div',
    { class: `card mission${m.complete ? ' done' : ''}` },
    h('div', { class: 'emoji' }, m.complete ? '✅' : m.emoji),
    h('div', { class: 'row' }, h('h3', { class: 'grow' }, m.title), h('span', { class: 'count' }, m.goal ? `${m.done}/${m.goal}` : '완료')),
    h('div', { class: 'hint' }, m.hint),
    m.goal > 0 && m.id !== 'book' && h('div', { class: 'bar' }, h('i', { style: `width:${pct}%` })),
    h('div', { class: 'extra' }, missionAction(m, t))
  );
}

function missionAction(m: Mission, t: TodayPayload): Child {
  switch (m.id) {
    case 'vocab':
      if (t.dueIds.length === 0) return h('button', { class: 'btn ghost sm', onclick: () => go('#/vocab') }, '단어장에서 골라 복습');
      return h('button', { class: `btn sm${m.complete ? ' ghost' : ''}`, onclick: startDueReview }, m.complete ? `밀린 ${t.dueIds.length}개 더 하기` : m.done ? '이어서 복습' : '복습 시작');
    case 'writing':
      if (t.quizIds.length === 0) return h('span', { class: 'small muted' }, m.goal ? '오늘은 모든 문장을 써 봤어요' : '문장 탭에서 먼저 등록해 주세요');
      return h('button', { class: `btn sm${m.complete ? ' ghost' : ''}`, onclick: startDailyWriting }, m.complete ? '더 써 보기' : m.done ? '이어서 쓰기' : '영작 시작');
    case 'add':
      return addForm();
    case 'tech':
      return h('button', { class: `btn sm${m.complete ? ' ghost' : ''}`, onclick: () => go('#/read') }, m.complete ? '더 읽기' : '오늘의 글 보기');
    case 'book':
      return bookForm(t);
  }
}

function bookForm(t: TodayPayload): HTMLElement {
  const done = Boolean(t.book?.done);
  const memo = ui.bookMemo ?? t.book?.memo ?? '';
  const save = async (next: boolean) => {
    await act('/checkin', { kind: 'book', done: next, memo: ui.bookMemo ?? t.book?.memo });
    ui.bookMemo = undefined;
    rerender();
  };
  return h(
    'div',
    { class: 'row' },
    h('input', {
      type: 'text',
      class: 'grow',
      placeholder: '어디까지 읽었나요? (선택)',
      'aria-label': '독서 메모',
      value: memo,
      oninput: (e: Event) => (ui.bookMemo = (e.target as HTMLInputElement).value),
    }),
    h('button', { class: `btn sm${done ? ' ghost' : ''}`, onclick: () => void save(!done) }, done ? '취소' : '읽었어요')
  );
}

/** 새 표현·문장 등록 폼 — 오늘 화면과 단어장·문장 탭이 같이 쓴다. */
export function addForm(fixedTarget?: 'vocab' | 'writing'): HTMLElement {
  const target = fixedTarget ?? ui.addTarget;
  if (!ui.addOpen && !fixedTarget) {
    return h(
      'button',
      {
        class: 'btn ghost sm',
        onclick: () => {
          ui.addOpen = true;
          rerender();
          document.getElementById('add-text')?.focus();
        },
      },
      '＋ 등록하기'
    );
  }
  const submit = async () => {
    if (ui.adding || !ui.addText.trim()) return;
    ui.adding = true;
    rerender();
    const res = await act<{ outcomes: AddOutcome[]; today: TodayPayload }>('/add', { text: ui.addText, target });
    ui.adding = false;
    if (res) {
      ui.outcomes = res.outcomes;
      for (const o of res.outcomes) {
        if (o.vocab) upsertVocab(o.vocab);
        if (o.writing) upsertWriting(o.writing);
      }
      // 실패한 줄만 남겨 다시 고칠 수 있게
      ui.addText = res.outcomes.filter((o) => !o.ok).map((o) => o.input).join('\n');
      if (res.outcomes.every((o) => o.ok)) toast('저장했어요');
    }
    rerender();
  };
  return h(
    'div',
    { class: 'stack' },
    !fixedTarget &&
      h(
        'div',
        { class: 'seg', role: 'tablist' },
        (['vocab', 'writing'] as const).map((k) =>
          h(
            'button',
            {
              class: target === k ? 'on' : '',
              onclick: () => {
                ui.addTarget = k;
                rerender();
              },
            },
            k === 'vocab' ? '단어·표현' : 'Writing 문장'
          )
        )
      ),
    h('textarea', {
      id: 'add-text',
      lang: 'en',
      rows: 2,
      spellcheck: false,
      placeholder: target === 'vocab' ? '한 줄에 하나씩 (최대 5줄)\n예: ubiquitous\n예: take into account :: 고려하다' : '교재 연습하며 쓴 영어 문장을 한 줄에 하나씩 (최대 5줄)',
      value: ui.addText,
      oninput: (e: Event) => (ui.addText = (e.target as HTMLTextAreaElement).value),
    }),
    h('div', { class: 'row' }, h('span', { class: 'grow small muted' }, ui.adding ? '뜻을 채우는 중… (줄마다 몇 초)' : '뜻·예문은 자동으로 채워져요'), h('button', { class: 'btn sm', disabled: ui.adding, onclick: () => void submit() }, ui.adding ? '저장 중…' : '등록')),
    ui.outcomes.length > 0 && h('div', { class: 'outcomes' }, ui.outcomes.map(outcomeRow))
  );
}

function outcomeRow(o: AddOutcome): HTMLElement {
  if (!o.ok) return h('div', { class: 'err' }, `⚠️ ${o.input} — ${o.error}`);
  const text = o.vocab?.text ?? o.writing?.text ?? o.input;
  const gloss = o.vocab?.meaning ?? o.writing?.korean;
  return h(
    'div',
    { class: 'ok' },
    h('b', null, o.repeated ? '↺ ' : '✓ '),
    h('span', { lang: 'en' }, text),
    gloss ? ` — ${gloss}` : '',
    o.repeated && h('span', { class: 'muted' }, ' (이미 있어요)'),
    o.note && h('div', { class: 'small muted' }, o.note)
  );
}
