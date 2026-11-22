import { h, type Child } from './dom';
import { act, go, rerender, state, toast, upsertVocab, upsertWriting, vocabById, writingById } from './app';
import type { TodayPayload, VocabEntry, WritingEntry } from '../../src/lib/web-types';

/** 문제 풀이 화면 — 단어 복습(플래시카드)과 Writing 영작. 한 번에 하나만 진행한다. */

interface ReviewSession {
  kind: 'review';
  title: string;
  ids: string[];
  index: number;
  revealed: boolean;
  know: number;
  forgot: number;
  busy: boolean;
}

interface WriteSession {
  kind: 'write';
  title: string;
  ids: string[];
  index: number;
  answer: string;
  result?: { match: boolean; entry: WritingEntry };
  matched: number;
  busy: boolean;
}

let session: ReviewSession | WriteSession | undefined;

export function startReview(ids: string[], title: string): void {
  if (ids.length === 0) return toast('복습할 표현이 없어요');
  session = { kind: 'review', title, ids, index: 0, revealed: false, know: 0, forgot: 0, busy: false };
  go('#/session');
}

export function startWriting(ids: string[], title: string): void {
  if (ids.length === 0) return toast('연습할 문장이 없어요');
  session = { kind: 'write', title, ids, index: 0, answer: '', matched: 0, busy: false };
  go('#/session');
}

/** 오늘 미션의 남은 분량만큼 (다 했으면 밀린 것 전부). */
export function startDueReview(): void {
  const t = state.today;
  if (!t) return;
  const m = t.missions.find((x) => x.id === 'vocab');
  const left = m ? m.goal - m.done : 0;
  startReview(left > 0 ? t.dueIds.slice(0, left) : t.dueIds, '오늘의 복습');
}

export function startDailyWriting(): void {
  const t = state.today;
  if (!t) return;
  const m = t.missions.find((x) => x.id === 'writing');
  const left = m ? m.goal - m.done : 0;
  startWriting(t.quizIds.slice(0, left > 0 ? left : t.settings.writingGoal || 5), '오늘의 영작');
}

function close(): void {
  session = undefined;
  go('#/');
}

function top(s: ReviewSession | WriteSession): HTMLElement {
  return h(
    'div',
    { class: 'session-top' },
    h('button', { class: 'x', 'aria-label': '그만하기', onclick: close }, '✕'),
    h('div', { class: 'bar' }, h('i', { style: `width:${Math.round((s.index / s.ids.length) * 100)}%` })),
    h('span', { class: 'small muted' }, `${Math.min(s.index + 1, s.ids.length)} / ${s.ids.length}`)
  );
}

export function sessionView(): Child {
  if (!session) {
    return h('div', { class: 'card center stack' }, h('p', null, '진행 중인 연습이 없어요.'), h('button', { class: 'btn', onclick: close }, '오늘로'));
  }
  if (session.index >= session.ids.length) return finished(session);
  return session.kind === 'review' ? reviewCard(session) : writeCard(session);
}

function finished(s: ReviewSession | WriteSession): Child {
  const t = state.today;
  const more = s.kind === 'review' ? t?.dueIds.length ?? 0 : 0;
  return h(
    'div',
    { class: 'card center stack' },
    h('div', { style: 'font-size:56px' }, t?.summary.complete ? '🎉' : '💪'),
    h('h2', null, t?.summary.complete ? '오늘 미션 완료!' : `${s.title} 끝`),
    h(
      'p',
      { class: 'muted' },
      s.kind === 'review' ? `알아요 ${s.know} · 몰라요 ${s.forgot}` : `${s.ids.length}문장 중 ${s.matched}문장을 그대로 썼어요`
    ),
    more > 0 && h('button', { class: 'btn ghost', onclick: () => startReview(state.today!.dueIds, '밀린 복습') }, `밀린 ${more}개 더 하기`),
    h('button', { class: 'btn', onclick: close }, '오늘로 돌아가기')
  );
}

// ---------------------------------------------------------------- 단어 복습

function reviewCard(s: ReviewSession): Child {
  const entry = vocabById(s.ids[s.index]);
  if (!entry) {
    s.index++;
    return sessionView();
  }
  const long = entry.kind === 'sentence' || entry.text.length > 28;
  const reveal = () => {
    s.revealed = true;
    rerender();
  };
  return [
    top(s),
    h(
      'div',
      { class: 'card flash' },
      h('div', { class: `term${long ? ' long' : ''}`, lang: 'en' }, entry.text),
      h('div', { class: 'meta' }, [entry.pos, entry.pronunciation, entry.missCount > 0 && `헷갈림 ${entry.missCount}`].filter(Boolean).join(' · ')),
      s.revealed ? vocabAnswer(entry) : h('p', { class: 'muted small' }, '뜻을 떠올려 보고 확인하세요')
    ),
    s.revealed
      ? h(
          'div',
          { class: 'duo' },
          h('button', { class: 'btn bad', disabled: s.busy, onclick: () => void answerReview(s, entry, 'forgot') }, '❌ 몰라요'),
          h('button', { class: 'btn', disabled: s.busy, onclick: () => void answerReview(s, entry, 'know') }, '✅ 알아요')
        )
      : h('button', { class: 'btn block', style: 'margin-top:16px', onclick: reveal }, '뜻 보기'),
  ];
}

export function vocabAnswer(entry: VocabEntry): HTMLElement {
  return h(
    'div',
    { class: 'answer' },
    h('div', { class: 'meaning' }, entry.meaning ?? '(아직 뜻이 없어요)'),
    entry.example && h('div', { class: 'ex', lang: 'en' }, entry.example),
    entry.synonyms && h('div', { class: 'small muted' }, `≈ ${entry.synonyms}`),
    entry.note && h('div', { class: 'note' }, entry.note)
  );
}

async function answerReview(s: ReviewSession, entry: VocabEntry, result: 'know' | 'forgot'): Promise<void> {
  if (s.busy) return;
  s.busy = true;
  rerender();
  const res = await act<{ entry: VocabEntry; ack: string; today: TodayPayload }>('/vocab/review', { pageId: entry.pageId, result });
  s.busy = false;
  if (res) {
    upsertVocab(res.entry);
    toast(res.ack);
    s[result]++;
    s.index++;
    s.revealed = false;
  }
  rerender();
}

// ---------------------------------------------------------------- Writing 영작

function writeCard(s: WriteSession): Child {
  const entry = writingById(s.ids[s.index]);
  if (!entry) {
    s.index++;
    return sessionView();
  }
  const next = () => {
    s.index++;
    s.answer = '';
    s.result = undefined;
    rerender();
  };
  if (s.result) {
    const model = s.result.entry.text;
    const diff = diffWords(s.answer, model);
    return [
      top(s),
      h(
        'div',
        { class: 'card stack' },
        h('p', { class: 'muted small' }, entry.korean),
        h('div', { class: `verdict${s.result.match ? ' good' : ''}` }, s.result.match ? '✅ 그대로 썼어요' : s.answer.trim() ? '👀 비교해 보세요' : '정답'),
        h('div', { class: 'model', lang: 'en' }, diff.model.map((w) => [w.hit ? w.text : h('mark', null, w.text), ' '])),
        s.answer.trim() && !s.result.match && h('div', { class: 'mine', lang: 'en' }, '내가 쓴 것: ', diff.mine.map((w) => [w.hit ? w.text : h('s', null, w.text), ' '])),
        entry.note && h('div', { class: 'answer' }, h('div', { class: 'note' }, `💡 ${entry.note}`))
      ),
      h('button', { class: 'btn block', style: 'margin-top:16px', id: 'next', onclick: next }, s.index + 1 >= s.ids.length ? '끝내기' : '다음'),
    ];
  }
  const submit = async () => {
    if (s.busy) return;
    s.busy = true;
    rerender();
    const res = await act<{ entry: WritingEntry; match: boolean; today: TodayPayload }>('/writing/attempt', { pageId: entry.pageId, answer: s.answer });
    s.busy = false;
    if (res) {
      upsertWriting(res.entry);
      s.result = { match: res.match, entry: res.entry };
      if (res.match) s.matched++;
    }
    rerender();
  };
  return [
    top(s),
    h(
      'div',
      { class: 'card stack' },
      entry.source && h('span', { class: 'small muted' }, entry.source),
      h('div', { class: 'prompt' }, entry.korean),
      h('textarea', {
        id: 'answer',
        lang: 'en',
        rows: 3,
        placeholder: '영어로 써 보세요',
        autocapitalize: 'sentences',
        spellcheck: false,
        value: s.answer,
        oninput: (e: Event) => (s.answer = (e.target as HTMLTextAreaElement).value),
        onkeydown: (e: KeyboardEvent) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
        },
      })
    ),
    h(
      'div',
      { class: 'duo' },
      h(
        'button',
        {
          class: 'btn ghost',
          disabled: s.busy,
          onclick: () => {
            s.answer = '';
            void submit();
          },
        },
        '모르겠어요'
      ),
      h('button', { class: 'btn', disabled: s.busy, onclick: () => void submit() }, '확인')
    ),
  ];
}

const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9']/g, '');

/** 단어 단위 비교 (LCS). model에서 hit=false = 내가 빠뜨리거나 다르게 쓴 단어, mine에서 hit=false = 정답에 없는 단어. */
export function diffWords(mine: string, model: string): { mine: { text: string; hit: boolean }[]; model: { text: string; hit: boolean }[] } {
  const a = mine.trim().split(/\s+/).filter(Boolean);
  const b = model.trim().split(/\s+/).filter(Boolean);
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = norm(a[i]) === norm(b[j]) ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const hitA = new Array<boolean>(a.length).fill(false);
  const hitB = new Array<boolean>(b.length).fill(false);
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (norm(a[i]) === norm(b[j])) {
      hitA[i++] = true;
      hitB[j++] = true;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++;
    else j++;
  }
  return { mine: a.map((text, i) => ({ text, hit: hitA[i] })), model: b.map((text, i) => ({ text, hit: hitB[i] })) };
}

/** 복습 화면 단축키: Space/Enter = 뜻 보기, ←/1 = 몰라요, →/2 = 알아요. 영작 결과 화면에서는 Enter = 다음. */
export function sessionKey(e: KeyboardEvent): void {
  if (!session || !location.hash.startsWith('#/session') || session.index >= session.ids.length) return;
  if (session.kind === 'write') {
    if (session.result && e.key === 'Enter') document.getElementById('next')?.click();
    return;
  }
  const entry = vocabById(session.ids[session.index]);
  if (!entry) return;
  if (!session.revealed) {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      session.revealed = true;
      rerender();
    }
  } else if (e.key === 'ArrowLeft' || e.key === '1') void answerReview(session, entry, 'forgot');
  else if (e.key === 'ArrowRight' || e.key === '2') void answerReview(session, entry, 'know');
}

export function focusSession(): void {
  if (session?.kind === 'write' && !session.result) document.getElementById('answer')?.focus();
}
