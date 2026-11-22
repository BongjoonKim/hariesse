import { h, md, weekdayIndex, type Child } from './dom';
import { act, api, load, rerender, state, sync, toast } from './app';
import type { TechArticle, TechPayload, TodayPayload } from '../../src/lib/web-types';

/** 읽기(기술 글) · 기록(연속 기록·통계·설정) · 로그인 화면. */

// ---------------------------------------------------------------- 읽기

let techLoading = false;

async function loadTech(): Promise<void> {
  if (techLoading) return;
  techLoading = true;
  try {
    state.tech = await api<TechPayload>('/tech');
  } catch (err) {
    toast((err as Error).message);
    state.tech = { articles: [] };
  }
  techLoading = false;
  rerender();
}

const CATEGORY_LABEL: Record<string, string> = { 'dev-ai': '개발·AI', cloud: '클라우드', design: '디자인', travel: '여행' };

export function readView(): Child {
  const t = state.today;
  if (!state.tech) {
    void loadTech();
    return h('p', { class: 'boot' }, '불러오는 중…');
  }
  const read = new Set(t?.techIds ?? []);
  const mark = async (id: string, done: boolean) => {
    await act('/checkin', { kind: 'tech', id, done });
    rerender();
  };
  const readButton = (id: string) =>
    h('button', { class: `btn sm${read.has(id) ? ' ghost' : ''}`, onclick: () => void mark(id, !read.has(id)) }, read.has(id) ? '✓ 읽음' : '읽었어요');
  const { lesson, articles } = state.tech;
  return [
    h('div', { class: 'topbar' }, h('div', null, h('h1', null, '오늘 읽을 것'), h('div', { class: 'sub' }, '최근 이틀 다이제스트와 학습 레슨'))),
    h(
      'div',
      { class: 'stack' },
      lesson &&
        h(
          'div',
          { class: `card article${read.has(lesson.id) ? ' read' : ''}` },
          h('span', { class: 'tag' }, `학습 레슨 · ${lesson.track}`),
          h('h3', { style: 'margin-top:6px' }, lesson.title),
          h('p', null, `${md(lesson.sentDate)} 20:00에 Telegram으로 온 레슨이에요. 본문은 Telegram·Notion 학습노트에 있어요.`),
          h(
            'div',
            { class: 'row wrap', style: 'margin-top:10px' },
            h('a', { class: 'grow small', href: lesson.refs[0], target: '_blank', rel: 'noopener' }, '공식 문서 열기 ↗'),
            readButton(lesson.id)
          )
        ),
      articles.map((a) => articleCard(a, read.has(a.articleId), readButton(a.articleId))),
      !lesson && articles.length === 0 && h('div', { class: 'card center muted' }, '최근 이틀 동안 온 글이 없어요. 내일 07:00 다이제스트를 기다려요.')
    ),
  ];
}

function articleCard(a: TechArticle, isRead: boolean, button: HTMLElement): HTMLElement {
  return h(
    'div',
    { class: `card article${isRead ? ' read' : ''}` },
    h('span', { class: 'tag' }, CATEGORY_LABEL[a.category] ?? a.category),
    typeof a.score === 'number' && h('span', { class: 'tag' }, `${a.score}점`),
    h('h3', { style: 'margin-top:6px' }, h('a', { href: a.url, target: '_blank', rel: 'noopener' }, a.title)),
    a.summary && h('p', null, a.summary),
    a.aiOpinion && h('p', null, `💬 ${a.aiOpinion}`),
    h(
      'div',
      { class: 'row wrap', style: 'margin-top:10px' },
      h('a', { class: 'small', href: a.url, target: '_blank', rel: 'noopener' }, '원문 ↗'),
      a.discussionUrl && h('a', { class: 'small', href: a.discussionUrl, target: '_blank', rel: 'noopener' }, '토론 ↗'),
      h('span', { class: 'grow' }),
      button
    )
  );
}

// ---------------------------------------------------------------- 기록

export function meView(): Child {
  const t = state.today;
  const lib = state.lib;
  if (!t || !lib) return h('p', { class: 'boot' }, '불러오는 중…');
  const mastered = lib.vocab.filter((e) => e.status === 'mastered').length;
  const boxes = [0, 1, 2, 3, 4, 5].map((b) => lib.vocab.filter((e) => e.status !== 'mastered' && e.box === b).length);
  const max = Math.max(1, mastered, ...boxes);
  const boxLabel = ['새 표현', '박스 1', '박스 2', '박스 3', '박스 4', '박스 5'];
  // 달력: 첫 열의 요일을 맞추려고 앞을 비운다
  const pad = Array.from({ length: weekdayIndex(t.history[0].date) }, () => h('i', { class: 'pad' }));
  const level = (done: number, total: number, complete: boolean) => (complete ? 'l3' : done === 0 ? '' : done / Math.max(1, total) >= 0.5 ? 'l2' : 'l1');
  return [
    h('div', { class: 'topbar' }, h('h1', null, '기록')),
    h(
      'div',
      { class: 'card stack' },
      h(
        'div',
        { class: 'stats' },
        h('div', null, h('b', null, `🔥 ${t.streak.current}`), h('span', null, '연속 (일)')),
        h('div', null, h('b', null, t.streak.best), h('span', null, '최고 기록')),
        h('div', null, h('b', null, t.history.filter((d) => d.complete).length), h('span', null, '최근 18주 완료일'))
      ),
      h('div', { class: 'heat', role: 'img', 'aria-label': '최근 18주 미션 달성 달력' }, pad, t.history.map((d) => h('i', { class: level(d.done, d.total, d.complete), title: `${md(d.date)} · ${d.done}/${d.total}` })))
    ),
    h('div', { class: 'section-title' }, '단어장'),
    h(
      'div',
      { class: 'card stack' },
      h(
        'div',
        { class: 'stats' },
        h('div', null, h('b', null, lib.vocab.length), h('span', null, '전체 표현')),
        h('div', null, h('b', null, mastered), h('span', null, '외움')),
        h('div', null, h('b', null, lib.writing.length), h('span', null, 'Writing 문장'))
      ),
      h(
        'div',
        { class: 'boxes' },
        boxes.map((n, b) => h('div', null, h('span', null, boxLabel[b]), h('div', { class: 'bar' }, h('i', { style: `width:${(n / max) * 100}%` })), h('span', null, n))),
        h('div', null, h('span', null, '🎓 외움'), h('div', { class: 'bar' }, h('i', { style: `width:${(mastered / max) * 100}%` })), h('span', null, mastered))
      )
    ),
    h('div', { class: 'section-title' }, '하루 목표'),
    settingsCard(t),
    h('div', { class: 'section-title' }, '동기화'),
    h(
      'div',
      { class: 'card stack' },
      h('p', { class: 'small muted' }, '원본은 Notion이에요. Telegram·Notion에서 바꾼 내용은 30분마다(또는 아래 버튼으로) 여기에 반영돼요.'),
      h(
        'div',
        { class: 'row' },
        h('span', { class: 'grow small muted' }, t.syncedAt ? `마지막 동기화 ${new Date(t.syncedAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : '아직 동기화한 적이 없어요'),
        h('button', { class: 'btn ghost sm', disabled: state.syncing, onclick: () => void sync() }, state.syncing ? '맞추는 중…' : '지금 동기화')
      )
    ),
    h(
      'div',
      { class: 'center', style: 'margin-top:20px' },
      h(
        'button',
        {
          class: 'link',
          onclick: async () => {
            await api('/logout', {}).catch(() => undefined);
            state.authed = false;
            rerender();
          },
        },
        '로그아웃'
      )
    ),
  ];
}

function settingsCard(t: TodayPayload): HTMLElement {
  const s = t.settings;
  const num = (label: string, name: string, value: number) =>
    h('label', { class: 'field' }, label, h('input', { type: 'number', name, min: 0, max: 50, inputmode: 'numeric', value }));
  const form = h(
    'div',
    { class: 'stack' },
    h('div', { class: 'form2' }, num('단어 복습 (최대)', 'vocabGoal', s.vocabGoal), num('Writing 영작', 'writingGoal', s.writingGoal), num('새 표현 등록', 'addGoal', s.addGoal), num('기술 글 읽기', 'techGoal', s.techGoal)),
    h(
      'div',
      { class: 'form2' },
      h('label', { class: 'field' }, '읽는 책', h('input', { type: 'text', name: 'bookTitle', placeholder: '책 제목', value: s.bookTitle ?? '' })),
      h('label', { class: 'field' }, '하루 독서 목표', h('input', { type: 'text', name: 'bookTarget', placeholder: '20분', value: s.bookTarget ?? '' }))
    ),
    h('label', { class: 'row small' }, h('input', { type: 'checkbox', name: 'bookEnabled', checked: s.bookEnabled }), '책 읽기 미션 켜기'),
    h('p', { class: 'small muted' }, '0으로 두면 그 미션은 꺼져요.')
  );
  const save = async () => {
    const body: Record<string, unknown> = {};
    form.querySelectorAll<HTMLInputElement>('input[name]').forEach((el) => {
      body[el.name] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
    });
    if (await act('/settings', body)) toast('목표를 바꿨어요');
    rerender();
  };
  return h('div', { class: 'card stack' }, form, h('button', { class: 'btn sm', onclick: () => void save() }, '저장'));
}

// ---------------------------------------------------------------- 로그인

let loginBusy = false;
let loginError = '';

export function loginView(): Child {
  const submit = async (e: Event) => {
    e.preventDefault();
    if (loginBusy) return;
    const input = document.getElementById('pw') as HTMLInputElement;
    loginBusy = true;
    loginError = '';
    try {
      await api('/login', { password: input.value });
      loginBusy = false;
      state.authed = undefined;
      rerender();
      await load();
      return;
    } catch (err) {
      loginError = (err as Error).message;
    }
    loginBusy = false;
    rerender();
    document.getElementById('pw')?.focus();
  };
  return h(
    'form',
    { class: 'login', onsubmit: submit },
    h('h1', null, 'hariesse'),
    h('p', { class: 'muted' }, '오늘 할 일을 미루지 않게'),
    h('input', { id: 'pw', type: 'password', autocomplete: 'current-password', placeholder: '비밀번호', 'aria-label': '비밀번호', required: true }),
    loginError && h('p', { class: 'small', style: 'color:var(--bad)', role: 'alert' }, loginError),
    h('button', { class: 'btn block', type: 'submit', disabled: loginBusy }, loginBusy ? '확인 중…' : '들어가기')
  );
}
