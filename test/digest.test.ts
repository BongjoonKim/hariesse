import { isRead, pickResends, newSlotCount, ttlFrom, ttlExpiresSoon } from '../src/domain/digest';
import { buildItemKeyboard, formatItem, digestCountLabel } from '../src/lib/telegram';
import { decodeCallback } from '../src/domain/feedback';
import type { Article } from '../src/lib/types';

const NOW = Date.parse('2026-11-20T22:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

function article(id: string, over: Partial<Article> = {}): Article {
  return {
    articleId: id,
    url: `https://example.com/${id}`,
    title: id,
    siteId: 'site',
    category: 'dev-ai',
    source: 'blog',
    status: 'unread',
    collectedAt: daysAgo(10),
    ...over,
  };
}

describe('isRead', () => {
  it('전달만 되고 아무 버튼도 안 누른 글은 안 읽음', () => {
    expect(isRead(article('a', { deliveredAt: daysAgo(5) }))).toBe(false);
  });

  it('readAt이 있으면 읽음', () => {
    expect(isRead(article('a', { readAt: daysAgo(1) }))).toBe(true);
  });

  it.each(['likeFeedbackAt', 'siteFeedbackAt', 'saveFeedbackAt', 'skipFeedbackAt', 'readFeedbackAt'] as const)(
    'readAt 도입 전 버튼 기록(%s)만 있어도 읽음',
    (marker) => {
      expect(isRead(article('a', { [marker]: daysAgo(1) }))).toBe(true);
    }
  );

  it('status가 unread가 아니면 읽음', () => {
    expect(isRead(article('a', { status: 'starred' }))).toBe(true);
    expect(isRead(article('a', { status: 'skipped' }))).toBe(true);
  });
});

describe('pickResends', () => {
  it('마지막 전송 후 3일이 지난 안 읽은 글만, 오래 기다린 순서로', () => {
    const picked = pickResends(
      [
        article('recent', { deliveredAt: daysAgo(1) }),
        article('old', { deliveredAt: daysAgo(5) }),
        article('older', { deliveredAt: daysAgo(9) }),
        article('read', { deliveredAt: daysAgo(20), readAt: daysAgo(19) }),
        article('never-sent'),
      ],
      NOW,
      3,
      2
    );
    expect(picked.map((a) => a.articleId)).toEqual(['older', 'old']);
  });

  it('재전송한 글은 lastSentAt 기준으로 다시 3일을 기다린다', () => {
    const resentYesterday = article('a', { deliveredAt: daysAgo(30), lastSentAt: daysAgo(1) });
    const resentLongAgo = article('b', { deliveredAt: daysAgo(30), lastSentAt: daysAgo(4) });
    expect(pickResends([resentYesterday, resentLongAgo], NOW, 3, 5).map((a) => a.articleId)).toEqual(['b']);
  });

  it('횟수 제한이 없다 — 여러 번 보낸 글도 읽을 때까지 다시 고른다', () => {
    const many = article('a', { deliveredAt: daysAgo(60), lastSentAt: daysAgo(3), sendCount: 12 });
    expect(pickResends([many], NOW, 3, 1)).toHaveLength(1);
  });

  it('count 0이면 아무것도 고르지 않는다', () => {
    expect(pickResends([article('a', { deliveredAt: daysAgo(9) })], NOW, 3, 0)).toEqual([]);
  });
});

describe('newSlotCount', () => {
  it('재전송이 없으면 그대로', () => {
    expect(newSlotCount(4, 0)).toBe(4);
  });

  it('재전송 수만큼 새 글 자리를 줄인다', () => {
    expect(newSlotCount(4, 1)).toBe(3);
    expect(newSlotCount(2, 1)).toBe(1);
  });

  it('새 글은 최소 1건 남긴다', () => {
    expect(newSlotCount(2, 3)).toBe(1);
    expect(newSlotCount(1, 1)).toBe(1);
  });

  it('size가 0이면 0', () => {
    expect(newSlotCount(0, 1)).toBe(0);
  });
});

describe('TTL', () => {
  it('ttlFrom은 전송 시점 + N일 (epoch 초)', () => {
    expect(ttlFrom(NOW, 90)).toBe(Math.floor(NOW / 1000) + 90 * 86_400);
  });

  it('TTL이 7일 안에 끝나면 연장 대상', () => {
    expect(ttlExpiresSoon(article('a', { ttl: ttlFrom(NOW, 2) }), NOW, 7)).toBe(true);
    expect(ttlExpiresSoon(article('a', { ttl: ttlFrom(NOW, 30) }), NOW, 7)).toBe(false);
    expect(ttlExpiresSoon(article('a'), NOW, 7)).toBe(false);
  });
});

describe('다이제스트 메시지', () => {
  it('항목 버튼에 읽음이 있고 callback이 해석된다', () => {
    const id = 'a'.repeat(32);
    const buttons = buildItemKeyboard(id).inline_keyboard.flat();
    const read = buttons.find((b) => decodeCallback(b.callback_data)?.action === 'read');
    expect(read).toBeDefined();
    expect(decodeCallback(read!.callback_data)).toEqual({ action: 'read', articleId: id });
    expect(buttons).toHaveLength(5);
  });

  it('재전송 항목에는 안내 줄이 붙는다', () => {
    const a = article('a', { deliveredAt: '2026-11-15T22:10:00.000Z' });
    expect(formatItem(a)).not.toContain('🔁');
    expect(formatItem(a, { resend: true }).split('\n')[0]).toContain('다시 보내요 (지난 전송 2026-11-15)');
  });

  it('헤더 건수 표기', () => {
    expect(digestCountLabel(4, 0)).toBe('4건');
    expect(digestCountLabel(3, 1)).toBe('새 글 3건 + 다시 보내는 글 1건');
    expect(digestCountLabel(0, 1)).toBe('다시 보내는 글 1건');
  });
});
