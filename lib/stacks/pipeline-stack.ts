import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'path';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { ENV, SSM, SECRETS } from '../../src/lib/constants';

export interface PipelineStackProps extends cdk.StackProps {
  sourcesTable: dynamodb.Table;
  articlesTable: dynamodb.Table;
  profileTable: dynamodb.Table;
  rawBucket: s3.Bucket;
}

const SRC = path.join(__dirname, '..', '..', 'src', 'handlers');

export class PipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);

    const { sourcesTable, articlesTable, profileTable, rawBucket } = props;

    const commonEnv: Record<string, string> = {
      [ENV.SOURCES_TABLE]: sourcesTable.tableName,
      [ENV.ARTICLES_TABLE]: articlesTable.tableName,
      [ENV.PROFILE_TABLE]: profileTable.tableName,
      [ENV.RAW_BUCKET]: rawBucket.bucketName,
    };

    const bundling = {
      externalModules: ['@aws-sdk/*'], // 런타임에 포함됨
      nodeModules: ['jsdom', '@mozilla/readability', 'rss-parser'], // 번들 대신 설치 (jsdom 호환)
      format: OutputFormat.CJS,
      target: 'node20',
    };

    const makeFn = (name: string, entry: string, timeoutMin: number, memory: number) =>
      new NodejsFunction(this, name, {
        entry: path.join(SRC, entry, 'index.ts'),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        architecture: lambda.Architecture.ARM_64,
        timeout: cdk.Duration.minutes(timeoutMin),
        memorySize: memory,
        reservedConcurrentExecutions: 2, // 동시성 제한 (가드레일)
        environment: commonEnv,
        bundling,
      });

    // YouTube/Reddit 소스가 늘면서 소스당 fetch + 본문 추출 시간이 길어졌다.
    const collectFn = makeFn('CollectFn', 'collect', 14, 1024);
    const curateFn = makeFn('CurateFn', 'curate', 15, 512);
    const deliverFn = makeFn('DeliverFn', 'deliver', 5, 512);

    // ---- IAM (최소권한) ----
    // SSM 파라미터 읽기
    const ssmStmt = new iam.PolicyStatement({
      actions: ['ssm:GetParameters', 'ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/hariesse/*`,
      ],
    });
    [collectFn, curateFn, deliverFn].forEach((fn) => fn.addToRolePolicy(ssmStmt));

    // DynamoDB
    sourcesTable.grantReadWriteData(collectFn);
    articlesTable.grantReadWriteData(collectFn);
    rawBucket.grantPut(collectFn);

    articlesTable.grantReadWriteData(curateFn);
    profileTable.grantReadData(curateFn);
    rawBucket.grantRead(curateFn);

    articlesTable.grantReadWriteData(deliverFn);

    // Bedrock (curate만) — foundation model + 교차리전 추론 프로파일
    curateFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          'arn:aws:bedrock:*::foundation-model/*',
          `arn:aws:bedrock:*:${this.account}:inference-profile/*`,
        ],
      })
    );

    // Secrets (deliver만) — Telegram + Notion 토큰
    deliverFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${SECRETS.TELEGRAM_BOT_TOKEN}-*`,
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${SECRETS.NOTION_TOKEN}-*`,
        ],
      })
    );

    // ---- Step Functions: Collect → Curate → Deliver ----
    const collectTask = new tasks.LambdaInvoke(this, 'Collect', {
      lambdaFunction: collectFn,
      payloadResponseOnly: true,
    });
    const curateTask = new tasks.LambdaInvoke(this, 'Curate', {
      lambdaFunction: curateFn,
      payloadResponseOnly: true,
    });
    const deliverTask = new tasks.LambdaInvoke(this, 'Deliver', {
      lambdaFunction: deliverFn,
      payloadResponseOnly: true,
    });

    const definition = collectTask.next(curateTask).next(deliverTask);

    const stateMachine = new sfn.StateMachine(this, 'DailyPipeline', {
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: cdk.Duration.minutes(45),
      stateMachineType: sfn.StateMachineType.STANDARD,
    });

    // ---- 매일 07:00 KST (= 22:00 UTC) ----
    new events.Rule(this, 'DailySchedule', {
      schedule: events.Schedule.cron({ minute: '0', hour: '22' }),
      targets: [new targets.SfnStateMachine(stateMachine)],
    });

    new cdk.CfnOutput(this, 'StateMachineArn', { value: stateMachine.stateMachineArn });
    new cdk.CfnOutput(this, 'SsmPrefix', { value: '/hariesse/' });
    new cdk.CfnOutput(this, 'NotionDbParam', { value: SSM.NOTION_DATABASE_ID });
  }
}
