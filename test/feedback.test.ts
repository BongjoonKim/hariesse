import {
  encodeCallback,
  decodeCallback,
  feedbackEffects,
  clampWeight,
  WEIGHT_MIN,
  WEIGHT_MAX,
  type FeedbackAction,
} from '../src/domain/feedback';

describe('encodeCallback / decodeCallback', () => {
  const articleId = 'a'.repeat(32);

  it.each<FeedbackAction>(['like', 'site', 'save', 'skip'])('%s 라운드트립', (action) => {
    const data = encodeCallback(action, articleId);
    expect(decodeCallback(data)).toEqual({ action, articleId });
  });

  it('callback_data는 Telegram 제한 64바이트 이하', () => {
    for (const action of ['like', 'site', 'save', 'skip'] as const) {
      expect(Buffer.byteLength(encodeCallback(action, articleId))).toBeLessThanOrEqual(64);
    }
  });

  it('잘못된 입력은 undefined', () => {
    expect(decodeCallback(undefined)).toBeUndefined();
    expect(decodeCallback('')).toBeUndefined();
    expect(decodeCallback('v1|like')).toBeUndefined(); // articleId 없음
    expect(decodeCallback('v2|like|abc')).toBeUndefined(); // 버전 불일치
    expect(decodeCallback('v1|nuke|abc')).toBeUndefined(); // 알 수 없는 액션
    expect(decodeCallback('v1|like|abc|extra')).toBeUndefined(); // 필드 초과
  });
});

describe('feedbackEffects', () => {
  it('like: 별표 + liked + 가중치↑ + 프로필 반영', () => {
    const fx = feedbackEffects('like');
    expect(fx.articleStatus).toBe('starred');
    expect(fx.setLiked).toBe(true);
    expect(fx.weightDelta).toBeGreaterThan(0);
    expect(fx.likeCountDelta).toBe(1);
    expect(fx.bumpProfileInterests).toBe(true);
  });

  it('site: 소스 가중치만 크게 올린다 (글 상태 불변)', () => {
    const fx = feedbackEffects('site');
    expect(fx.articleStatus).toBeUndefined();
    expect(fx.weightDelta).toBeGreaterThan(feedbackEffects('like').weightDelta);
    expect(fx.bumpProfileInterests).toBe(false);
  });

  it('save: nadeliv 글감 체크만', () => {
    const fx = feedbackEffects('save');
    expect(fx.setNadelivCandidate).toBe(true);
    expect(fx.weightDelta).toBe(0);
    expect(fx.likeCountDelta).toBe(0);
  });

  it('skip: 스킵 상태 + 가중치↓', () => {
    const fx = feedbackEffects('skip');
    expect(fx.articleStatus).toBe('skipped');
    expect(fx.weightDelta).toBeLessThan(0);
    expect(fx.skipCountDelta).toBe(1);
  });
});

describe('clampWeight', () => {
  it('범위 안 값은 그대로', () => {
    expect(clampWeight(1.0)).toBe(1.0);
  });
  it('하한 — 탐험 분배가 죽지 않도록 0 이하로 내려가지 않는다', () => {
    expect(clampWeight(-5)).toBe(WEIGHT_MIN);
    expect(clampWeight(0)).toBe(WEIGHT_MIN);
  });
  it('상한 — 에코챔버 방지', () => {
    expect(clampWeight(99)).toBe(WEIGHT_MAX);
  });
});
