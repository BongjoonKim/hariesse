import type { ArticleStatus } from '../lib/types';

/**
 * 피드백 도메인 로직 (순수함수, 테스트 대상).
 * Telegram callback_data 인코딩/디코딩 + 액션별 효과 정의.
 */

export type FeedbackAction = 'like' | 'site' | 'save' | 'skip';

const PREFIX = 'v1';
const ACTIONS: readonly FeedbackAction[] = ['like', 'site', 'save', 'skip'];

/** callback_data는 Telegram 제한 64바이트 이하여야 한다. articleId(32) + "v1|site|" = 40. */
export function encodeCallback(action: FeedbackAction, articleId: string): string {
  return `${PREFIX}|${action}|${articleId}`;
}

export function decodeCallback(
  data: string | undefined
): { action: FeedbackAction; articleId: string } | undefined {
  if (!data) return undefined;
  const parts = data.split('|');
  if (parts.length !== 3) return undefined;
  const [prefix, action, articleId] = parts;
  if (prefix !== PREFIX || !articleId) return undefined;
  if (!ACTIONS.includes(action as FeedbackAction)) return undefined;
  return { action: action as FeedbackAction, articleId };
}

/** Sources.weight 클램프 범위 — 0이 되면 탐험 슬롯까지 죽으므로 하한을 둔다. */
export const WEIGHT_MIN = 0.1;
export const WEIGHT_MAX = 3.0;

export function clampWeight(w: number): number {
  return Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, w));
}

export interface FeedbackEffects {
  weightDelta: number;
  likeCountDelta: number;
  skipCountDelta: number;
  articleStatus?: ArticleStatus;
  setLiked?: boolean;
  setNadelivCandidate?: boolean;
  bumpProfileInterests: boolean;
  ack: string; // 버튼 누른 뒤 Telegram 토스트 문구
}

export function feedbackEffects(action: FeedbackAction): FeedbackEffects {
  switch (action) {
    case 'like':
      return {
        weightDelta: 0.1,
        likeCountDelta: 1,
        skipCountDelta: 0,
        articleStatus: 'starred',
        setLiked: true,
        bumpProfileInterests: true,
        ack: '👍 좋아요 반영했어요',
      };
    case 'site':
      return {
        weightDelta: 0.25,
        likeCountDelta: 1,
        skipCountDelta: 0,
        bumpProfileInterests: false,
        ack: '⭐ 이 사이트 글을 더 자주 보여줄게요',
      };
    case 'save':
      return {
        weightDelta: 0,
        likeCountDelta: 0,
        skipCountDelta: 0,
        setNadelivCandidate: true,
        bumpProfileInterests: false,
        ack: '💾 nadeliv 글감으로 저장했어요',
      };
    case 'skip':
      return {
        weightDelta: -0.1,
        likeCountDelta: 0,
        skipCountDelta: 1,
        articleStatus: 'skipped',
        bumpProfileInterests: false,
        ack: '⏭ 이런 글은 덜 보여줄게요',
      };
  }
}
