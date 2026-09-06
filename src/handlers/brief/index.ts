import { getConfig, getTelegramBotToken } from '../../lib/config';
import { ensureDayPlan } from '../../lib/tasks';
import { kstMoment, shiftDate, shouldSendBrief, tasksForSlot } from '../../domain/routine';
import { buildTaskKeyboard, formatBrief, sendMessage } from '../../lib/telegram';
import type { BriefSlot } from '../../lib/types';

/**
 * 하루 3회 브리핑 (09:00 / 12:00 / 20:00 KST).
 * EventBridge 규칙 3개가 slot만 바꿔 같은 Lambda를 호출한다.
 * 루틴 전개(ensureDayPlan)는 idempotent라 어느 슬롯이 먼저 돌아도 결과가 같다.
 */

export interface BriefEvent {
  slot: BriefSlot;
}

interface BriefResult {
  slot: BriefSlot;
  date: string;
  shown: number;
  total: number;
  sent: boolean;
}

export const handler = async (event: BriefEvent): Promise<BriefResult> => {
  const slot = event?.slot;
  if (slot !== 'morning' && slot !== 'midday' && slot !== 'evening') {
    throw new Error(`알 수 없는 브리핑 슬롯: ${String(slot)}`);
  }

  const cfg = await getConfig();
  if (!cfg.tasksTable) throw new Error('TASKS_TABLE 환경변수가 없습니다');
  if (!cfg.telegramChatId) throw new Error('SSM /hariesse/telegram-chat-id 가 비어 있습니다');

  const now = new Date();
  const { date } = kstMoment(now);
  const at = now.toISOString();

  const dayTasks = await ensureDayPlan(cfg.tasksTable, date, at);
  // 저녁에만 내일 미리보기 — 여기서 미리 전개해도 idempotent라 아침 브리핑과 충돌하지 않는다.
  const tomorrow =
    slot === 'evening' ? await ensureDayPlan(cfg.tasksTable, shiftDate(date, 1), at) : [];

  const shown = tasksForSlot(dayTasks, slot);

  if (!shouldSendBrief(slot, dayTasks.length, tomorrow.length)) {
    console.log(`brief 생략: slot=${slot} date=${date} (오늘 할일 없음)`);
    return { slot, date, shown: 0, total: dayTasks.length, sent: false };
  }

  const token = await getTelegramBotToken();
  await sendMessage(
    token,
    cfg.telegramChatId,
    formatBrief(slot, date, shown, dayTasks, tomorrow),
    buildTaskKeyboard(slot, date, shown)
  );

  console.log(`brief 전송: slot=${slot} date=${date} 표시 ${shown.length}/${dayTasks.length}건`);
  return { slot, date, shown: shown.length, total: dayTasks.length, sent: true };
};
