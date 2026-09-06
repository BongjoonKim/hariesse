#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DataStack } from '../lib/stacks/data-stack';
import { PipelineStack } from '../lib/stacks/pipeline-stack';
import { ApiStack } from '../lib/stacks/api-stack';
import { AssistantStack } from '../lib/stacks/assistant-stack';

const app = new cdk.App();

// 개인 AWS 계정, 서울 리전 (Bedrock·DynamoDB·S3 모두 동일 리전).
const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT ?? '611288736262',
  region: process.env.CDK_DEFAULT_REGION ?? 'ap-northeast-2',
};

const data = new DataStack(app, 'HariesseData', { env });

new PipelineStack(app, 'HariessePipeline', {
  env,
  sourcesTable: data.sourcesTable,
  articlesTable: data.articlesTable,
  profileTable: data.profileTable,
  rawBucket: data.rawBucket,
});

new AssistantStack(app, 'HariesseAssistant', {
  env,
  tasksTable: data.tasksTable,
  sourcesTable: data.sourcesTable,
  articlesTable: data.articlesTable,
  profileTable: data.profileTable,
  rawBucket: data.rawBucket,
});

new ApiStack(app, 'HariesseApi', {
  env,
  sourcesTable: data.sourcesTable,
  articlesTable: data.articlesTable,
  profileTable: data.profileTable,
  tasksTable: data.tasksTable,
  rawBucket: data.rawBucket,
});

app.synth();
