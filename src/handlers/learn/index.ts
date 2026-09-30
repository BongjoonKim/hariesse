import { getConfig, getTelegramBotToken, getNotionToken } from '../../lib/config';
import { getLearningProgress, putLearningProgress, listArticlesByStatus } from '../../lib/dynamo';
import { writeLesson } from '../../lib/bedrock';
import { formatLesson, sendLesson } from '../../lib/telegram';
import { createLessonPageIfNew } from '../../lib/notion';
import { CURRICULUM } from '../../domain/curriculum';
import {
  initialProgress,
  planNextLesson,
  advanceProgress,
  pickRelatedArticles,
  totalLessons,
} from '../../domain/learning';
import type { Article } from '../../lib/types';

/**
 * 매일 학습 레슨 1건 발송 (EventBridge → Lambda, 다이제스트와 별도 스케줄).
 * 진도는 Profile 테이블 pk='LEARNING'. 같은 KST 날짜에 이미 보냈으면 건너뛴다
 * (EventBridge 비동기 재시도로 인한 중복 발송 방지). 수동 테스트는 `{"force": true}`.
 */

interface LearnEvent {
  force?: boolean;
}

interface LearnResult {
  sent: boolean;
  lessonId?: string;
  mode?: string;
  messages?: number;
  reason?: string;
}

const RELATED_LIMIT = 2;

function kstDate(): string {
  // en-CA 로케일은 YYYY-MM-DD 형식
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

async function loadRelated(table: string, keywords: string[]): Promise<Article[]> {
  try {
    const [unread, starred] = await Promise.all([
      listArticlesByStatus(table, 'unread', 300),
      listArticlesByStatus(table, 'starred', 100),
    ]);
    return pickRelatedArticles([...starred, ...unread], keywords, RELATED_LIMIT);
  } catch (err) {
    console.warn(`관련 글 조회 실패 (레슨은 계속): ${(err as Error).message}`);
    return [];
  }
}

export const handler = async (event: LearnEvent = {}): Promise<LearnResult> => {
  const cfg = await getConfig();
  const today = kstDate();
  const now = new Date().toISOString();

  const progress = (await getLearningProgress(cfg.profileTable)) ?? initialProgress(now);
  if (progress.lastSentDate === today && !event.force) {
    console.log(`learn: 오늘(${today}) 이미 발송함 → 건너뜀`);
    return { sent: false, reason: 'already-sent-today' };
  }

  const plan = planNextLesson(progress, CURRICULUM);
  const content = await writeLesson(cfg.bedrockModelId, cfg.bedrockRegion, plan);
  const related = await loadRelated(cfg.articlesTable, plan.track.keywords);

  const messages = formatLesson(plan, content, related, {
    completed: progress.completed.length,
    total: totalLessons(CURRICULUM),
  });
  const botToken = await getTelegramBotToken();
  await sendLesson(botToken, cfg.telegramChatId, messages, plan.lesson.id);

  // 발송이 끝났으면 진도부터 저장 — Notion 실패가 다음 날 같은 레슨 재발송으로 이어지지 않게
  await putLearningProgress(cfg.profileTable, advanceProgress(progress, plan, today, now));

  if (cfg.notionDatabaseId) {
    try {
      const notionToken = await getNotionToken();
      await createLessonPageIfNew(notionToken, cfg.notionDatabaseId, plan, content, today);
    } catch (err) {
      console.warn(`Notion 레슨 아카이브 실패 ${plan.lesson.id}: ${(err as Error).message}`);
    }
  }

  console.log(
    `learn 완료: ${plan.lesson.id} (${plan.mode}) 메시지 ${messages.length}건, 관련 글 ${related.length}건`
  );
  return { sent: true, lessonId: plan.lesson.id, mode: plan.mode, messages: messages.length };
};
