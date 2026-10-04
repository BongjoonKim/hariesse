#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DataStack } from '../lib/stacks/data-stack';
import { PipelineStack } from '../lib/stacks/pipeline-stack';
import { ApiStack } from '../lib/stacks/api-stack';
import { OperatorStack } from '../lib/stacks/operator-stack';
import { stackPrefix } from '../src/lib/constants';

const app = new cdk.App();

// 개인 AWS 계정, 서울 리전 (Bedrock·DynamoDB·S3 모두 동일 리전).
const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT ?? '611288736262',
  region: process.env.CDK_DEFAULT_REGION ?? 'ap-northeast-2',
};

/**
 * stage: 같은 계정에 hariesse를 여러 벌 올리기 위한 접두어.
 *   npx cdk deploy --all                              → 내 배포 (Hariesse*, /hariesse/*). 기존 그대로.
 *   npx cdk deploy --all -c stage=design -c learning=false -c operator=true
 *                                                     → 디자인 배포 (HariesseDesign*, /hariesse-design/*) + 운영자 IAM 사용자
 * 한 번의 synth/deploy는 한 stage만 다룬다. stage 없이 실행하면 항상 내 스택이 대상이다.
 */
const ctx = (k: string): string | undefined => {
  const v = app.node.tryGetContext(k);
  return v === undefined ? undefined : String(v);
};
const stage = ctx('stage')?.trim() || undefined;
if (stage && !/^[a-z][a-z0-9]{1,15}$/.test(stage)) {
  throw new Error(`stage는 소문자 영숫자 2~16자 (받음: ${stage})`);
}
const learning = ctx('learning') !== 'false'; // 기본 켜짐. 디자인 배포는 -c learning=false
const operator = ctx('operator') === 'true'; // 운영자 IAM 사용자 스택 (stage 필수)
const operatorDeploy = ctx('operatorDeploy') === 'true'; // 운영자에게 cdk deploy 권한까지 (기본 꺼짐)
const P = stackPrefix(stage);

const data = new DataStack(app, `${P}Data`, { env });

const pipeline = new PipelineStack(app, `${P}Pipeline`, {
  env,
  stage,
  learning,
  sourcesTable: data.sourcesTable,
  articlesTable: data.articlesTable,
  profileTable: data.profileTable,
  rawBucket: data.rawBucket,
});

const api = new ApiStack(app, `${P}Api`, {
  env,
  stage,
  sourcesTable: data.sourcesTable,
  articlesTable: data.articlesTable,
  profileTable: data.profileTable,
  rawBucket: data.rawBucket,
});

if (operator) {
  if (!stage) throw new Error('-c operator=true 는 -c stage=<name> 과 함께 써야 한다 (내 기본 배포에는 운영자 사용자를 만들지 않는다)');
  new OperatorStack(app, `${P}Operator`, {
    env,
    stage,
    tables: [data.sourcesTable, data.articlesTable, data.profileTable],
    rawBucket: data.rawBucket,
    functions: [...pipeline.functions, api.feedbackFn],
    stateMachine: pipeline.stateMachine,
    allowDeploy: operatorDeploy,
  });
}

app.synth();
