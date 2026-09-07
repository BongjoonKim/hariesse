import { randomBytes } from 'crypto';
import { GetCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { doc } from './dynamo';
import { DEFAULTS } from './constants';
import { dayPk, planForDay, shiftDate } from '../domain/routine';
import type { Routine, TaskInstance, TaskStatus } from './types';

/**
 * Tasks 테이블 CRUD. 단일 테이블 pk/sk:
 *   루틴 정의  pk="ROUTINE"          sk=<routineId>
 *   하루 할일  pk="DAY#YYYY-MM-DD"   sk=<routineId> | "x<8hex>"(단건)
 * 하루치 조회가 pk 하나로 끝나도록 잡은 구조.
 */

const ROUTINE_PK = 'ROUTINE';

/** 8 hex — Telegram callback_data(64B) 안에 날짜와 함께 넉넉히 들어간다. */
export function newId(): string {
  return randomBytes(4).toString('hex');
}

// ---- 루틴 ----

export async function listRoutines(table: string): Promise<Routine[]> {
  const res = await doc.send(
    new QueryCommand({
      TableName: table,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': ROUTINE_PK },
    })
  );
  return (res.Items ?? []) as Routine[];
}

export async function getRoutine(table: string, routineId: string): Promise<Routine | undefined> {
  const res = await doc.send(
    new GetCommand({ TableName: table, Key: { pk: ROUTINE_PK, sk: routineId } })
  );
  return res.Item as Routine | undefined;
}

export async function putRoutine(table: string, routine: Routine): Promise<void> {
  await doc.send(new PutCommand({ TableName: table, Item: routine }));
}

export async function deleteRoutine(table: string, routineId: string): Promise<void> {
  await doc.send(new DeleteCommand({ TableName: table, Key: { pk: ROUTINE_PK, sk: routineId } }));
}

// ---- 하루 할일 ----

export async function listDayTasks(table: string, date: string): Promise<TaskInstance[]> {
  const res = await doc.send(
    new QueryCommand({
      TableName: table,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': dayPk(date) },
    })
  );
  return (res.Items ?? []) as TaskInstance[];
}

export async function getTask(
  table: string,
  date: string,
  sk: string
): Promise<TaskInstance | undefined> {
  const res = await doc.send(
    new GetCommand({ TableName: table, Key: { pk: dayPk(date), sk } })
  );
  return res.Item as TaskInstance | undefined;
}

/** 이미 있으면 건드리지 않는다 (체크해 둔 상태를 재전개가 덮어쓰면 안 된다). */
export async function putTaskIfNew(table: string, task: TaskInstance): Promise<boolean> {
  try {
    await doc.send(
      new PutCommand({
        TableName: table,
        Item: task,
        ConditionExpression: 'attribute_not_exists(pk)',
      })
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

export async function putTask(table: string, task: TaskInstance): Promise<void> {
  await doc.send(new PutCommand({ TableName: table, Item: task }));
}

export async function deleteTask(table: string, date: string, sk: string): Promise<void> {
  await doc.send(new DeleteCommand({ TableName: table, Key: { pk: dayPk(date), sk } }));
}

/**
 * 그날의 루틴을 전개한 뒤 하루치 할일을 돌려준다 (idempotent).
 * 브리핑 Lambda와 웹 API가 같은 함수를 타므로 별도 스케줄러가 필요 없다.
 */
export async function ensureDayPlan(
  table: string,
  date: string,
  at: string
): Promise<TaskInstance[]> {
  const routines = await listRoutines(table);
  for (const task of planForDay(routines, date, at, DEFAULTS.TASK_TTL_DAYS)) {
    await putTaskIfNew(table, task);
  }
  return listDayTasks(table, date);
}

/** 상태 변경. 없는 할일이면 undefined (지워졌거나 TTL로 사라진 경우). */
export async function setTaskStatus(
  table: string,
  date: string,
  sk: string,
  status: TaskStatus,
  at: string
): Promise<TaskInstance | undefined> {
  const sets = ['#s = :st', 'updatedAt = :at'];
  const values: Record<string, unknown> = { ':st': status, ':at': at };
  let expression: string;
  if (status === 'done') {
    sets.push('doneAt = :at');
    expression = `SET ${sets.join(', ')}`;
  } else {
    expression = `SET ${sets.join(', ')} REMOVE doneAt`;
  }
  try {
    const res = await doc.send(
      new UpdateCommand({
        TableName: table,
        Key: { pk: dayPk(date), sk },
        UpdateExpression: expression,
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      })
    );
    return res.Attributes as TaskInstance | undefined;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return undefined;
    throw err;
  }
}

/**
 * 루틴을 고치거나 지웠을 때, 앞으로 며칠치 중 **아직 todo인 루틴 전개분만** 지운다.
 * 다음 조회(`ensureDayPlan`)가 새 정의로 다시 만든다. 이미 체크/스킵한 기록은 건드리지 않는다.
 */
export async function resyncRoutineDays(
  table: string,
  routineId: string,
  fromDate: string,
  days: number = DEFAULTS.ROUTINE_RESYNC_DAYS
): Promise<number> {
  let removed = 0;
  for (let i = 0; i < days; i += 1) {
    const date = shiftDate(fromDate, i);
    const existing = await getTask(table, date, routineId);
    if (existing?.origin === 'routine' && existing.status === 'todo') {
      await deleteTask(table, date, routineId);
      removed += 1;
    }
  }
  return removed;
}
