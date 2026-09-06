/**
 * 주간 루틴 시드/갱신. 아래 ROUTINES 배열을 고쳐 다시 실행하면 그대로 반영된다
 * (routineId를 제목 해시로 고정 → 재실행해도 중복 생성되지 않음).
 *
 * 실행:
 *   AWS_REGION=ap-northeast-2 TASKS_TABLE=<name> npm run seed:routines
 *
 * 테이블 이름은 `cdk deploy`의 CfnOutput(TasksTableName)에서 확인.
 * 웹(hariesse UI)이 붙으면 이 스크립트는 초기 적재용으로만 남는다.
 */
import { createHash } from 'crypto';
import { listRoutines, putRoutine } from '../src/lib/tasks';
import { DAY_LABEL } from '../src/domain/routine';
import type { BriefSlot, Routine } from '../src/lib/types';

const TASKS_TABLE = process.env.TASKS_TABLE;

// 요일 상수 — 0=일 … 6=토
const 요일 = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 } as const;
const { 일, 월, 화, 수, 목, 금 } = 요일;

interface RoutineSeed {
  title: string;
  daysOfWeek: number[];
  timeOfDay?: string;
  remindSlots?: BriefSlot[];
  category?: string;
  estimatedMinutes?: number;
  note?: string;
}

const ROUTINES: RoutineSeed[] = [
  {
    title: '토플 Reading 1지문',
    daysOfWeek: [월, 수, 금],
    timeOfDay: '21:00',
    category: 'toefl',
    estimatedMinutes: 30,
    note: '오답 노트까지 마무리',
  },
  {
    title: '토플 Listening 2섹션',
    daysOfWeek: [월, 목],
    timeOfDay: '22:00',
    category: 'toefl',
    estimatedMinutes: 40,
  },
  {
    title: '토플 Speaking 템플릿 연습',
    daysOfWeek: [화, 금],
    category: 'toefl',
    estimatedMinutes: 20,
  },
  {
    title: '운동 (헬스장)',
    daysOfWeek: [월, 화, 수, 목, 금],
    timeOfDay: '19:00',
    category: 'health',
    estimatedMinutes: 60,
    remindSlots: ['midday', 'evening'],
  },
  {
    title: 'nadeliv 블로그 글감 정리',
    daysOfWeek: [일],
    category: 'blog',
    estimatedMinutes: 30,
    note: '이번 주 💾 저장한 글들 훑어보기',
  },
];

/** 제목 기준 고정 ID — 재실행이 upsert가 되도록. */
function routineIdFor(title: string): string {
  return createHash('sha256').update(title.trim()).digest('hex').slice(0, 8);
}

function describe(seed: RoutineSeed): string {
  const days = seed.daysOfWeek.map((d) => DAY_LABEL[d]).join('·');
  return `${days} ${seed.timeOfDay ?? '시간미정'} — ${seed.title}`;
}

async function main() {
  if (!TASKS_TABLE) throw new Error('환경변수 TASKS_TABLE 필요');

  const now = new Date().toISOString();
  const existing = new Map((await listRoutines(TASKS_TABLE)).map((r) => [r.routineId, r]));

  for (const seed of ROUTINES) {
    const routineId = routineIdFor(seed.title);
    const prev = existing.get(routineId);
    const routine: Routine = {
      pk: 'ROUTINE',
      sk: routineId,
      routineId,
      title: seed.title,
      daysOfWeek: [...seed.daysOfWeek].sort((a, b) => a - b),
      timeOfDay: seed.timeOfDay,
      remindSlots: seed.remindSlots,
      category: seed.category,
      estimatedMinutes: seed.estimatedMinutes,
      note: seed.note,
      active: true,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    };
    await putRoutine(TASKS_TABLE, routine);
    console.log(`${prev ? '↻' : '✔'} ${describe(seed)} (${routineId})`);
  }

  const orphans = [...existing.values()].filter(
    (r) => !ROUTINES.some((s) => routineIdFor(s.title) === r.routineId)
  );
  for (const r of orphans) {
    console.log(`… 시드 밖 루틴은 그대로 둠: ${r.title} (${r.routineId})`);
  }
  console.log('완료.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
