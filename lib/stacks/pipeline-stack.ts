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
import { ENV, configPrefix, ssmPaths, secretNames } from '../../src/lib/constants';

export interface PipelineStackProps extends cdk.StackProps {
  sourcesTable: dynamodb.Table;
  articlesTable: dynamodb.Table;
  profileTable: dynamodb.Table;
  rawBucket: s3.Bucket;
  /** 배포 stage (없으면 기본 배포). SSM/Secrets 접두어와 Lambda 환경변수에 쓰인다. */
  stage?: string;
  /** 학습 트랙(LearnFn + 20:00 KST 스케줄) 배포 여부. 기본 true. */
  learning?: boolean;
  /** TOEFL 단어장(VocabFn + 21:00 KST 복습 스케줄) 배포 여부. 기본 true. */
  vocab?: boolean;
}

const SRC = path.join(__dirname, '..', '..', 'src', 'handlers');

export class PipelineStack extends cdk.Stack {
  /** 운영자 IAM 정책 범위용 — 이 stage의 함수들 */
  readonly functions: lambda.IFunction[];
  readonly stateMachine: sfn.StateMachine;
  readonly learnFn?: lambda.IFunction;
  /** TOEFL 단어장 Lambda — ApiStack의 Feedback Lambda가 비동기 호출한다. vocab=false면 없음. */
  readonly vocabFn?: lambda.IFunction;

  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);

    const { sourcesTable, articlesTable, profileTable, rawBucket, stage } = props;
    const learning = props.learning ?? true;
    const vocab = props.vocab ?? true;
    const prefix = configPrefix(stage);
    const SSM = ssmPaths(prefix.ssm);
    const SECRETS = secretNames(prefix.secrets);

    const commonEnv: Record<string, string> = {
      [ENV.SOURCES_TABLE]: sourcesTable.tableName,
      [ENV.ARTICLES_TABLE]: articlesTable.tableName,
      [ENV.PROFILE_TABLE]: profileTable.tableName,
      [ENV.RAW_BUCKET]: rawBucket.bucketName,
      ...(stage ? { [ENV.STAGE]: stage } : {}),
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
    // 학습 레슨 — Bedrock 1회 + Telegram/Notion. 다이제스트 파이프라인과 독립. (-c learning=false 로 끌 수 있음)
    const learnFn = learning ? makeFn('LearnFn', 'learn', 3, 512) : undefined;
    // TOEFL 단어장 — 기록(capture, Feedback이 비동기 호출) + 매일 복습. 원본 저장소는 Notion DB. (-c vocab=false 로 끌 수 있음)
    // 복습 실행은 뜻 채우기(Bedrock) 최대 VOCAB_ENRICH_CAP건이 먼저 돌아서 넉넉히.
    const vocabFn = vocab ? makeFn('VocabFn', 'vocab', 5, 512) : undefined;
    // 비동기 재시도 끔 — capture가 재실행되면 같은 표현이 '또 헷갈림'으로 집계된다.
    vocabFn?.configureAsyncInvoke({ retryAttempts: 0 });
    const optional = [learnFn, vocabFn].filter((fn): fn is NodejsFunction => fn !== undefined);
    const bedrockFns = [curateFn, ...optional];
    const secretFns = [deliverFn, ...optional];
    const allFns = [collectFn, curateFn, deliverFn, ...optional];

    // ---- IAM (최소권한) ----
    // SSM 파라미터 읽기
    const ssmStmt = new iam.PolicyStatement({
      actions: ['ssm:GetParameters', 'ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter${prefix.ssm}/*`,
      ],
    });
    allFns.forEach((fn) => fn.addToRolePolicy(ssmStmt));

    // DynamoDB
    sourcesTable.grantReadWriteData(collectFn);
    articlesTable.grantReadWriteData(collectFn);
    rawBucket.grantPut(collectFn);

    articlesTable.grantReadWriteData(curateFn);
    profileTable.grantReadData(curateFn);
    rawBucket.grantRead(curateFn);

    articlesTable.grantReadWriteData(deliverFn);

    if (learnFn) {
      profileTable.grantReadWriteData(learnFn); // 진도 = pk 'LEARNING'
      articlesTable.grantReadData(learnFn); // 관련 글 찾기
    }

    if (vocabFn) {
      profileTable.grantReadWriteData(vocabFn); // 정기 복습 발송일 = pk 'VOCAB'
    }

    // Bedrock (curate, learn) — foundation model + 교차리전 추론 프로파일
    const bedrockStmt = new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        'arn:aws:bedrock:*::foundation-model/*',
        `arn:aws:bedrock:*:${this.account}:inference-profile/*`,
      ],
    });
    bedrockFns.forEach((fn) => fn.addToRolePolicy(bedrockStmt));

    // Secrets (deliver, learn, vocab) — Telegram + Notion 토큰
    const secretsStmt = new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${SECRETS.TELEGRAM_BOT_TOKEN}-*`,
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${SECRETS.NOTION_TOKEN}-*`,
      ],
    });
    secretFns.forEach((fn) => fn.addToRolePolicy(secretsStmt));

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

    // ---- 학습 레슨: 매일 20:00 KST (= 11:00 UTC) — 아침 다이제스트와 겹치지 않게 저녁에 ----
    if (learnFn) {
      new events.Rule(this, 'DailyLearningSchedule', {
        schedule: events.Schedule.cron({ minute: '0', hour: '11' }),
        targets: [new targets.LambdaFunction(learnFn)],
      });
      new cdk.CfnOutput(this, 'LearnFunctionName', { value: learnFn.functionName });
    }

    // ---- TOEFL 단어장 복습: 매일 21:00 KST (= 12:00 UTC) — 20:00 레슨 다음 ----
    if (vocabFn) {
      new events.Rule(this, 'DailyVocabReviewSchedule', {
        schedule: events.Schedule.cron({ minute: '0', hour: '12' }),
        targets: [
          new targets.LambdaFunction(vocabFn, {
            event: events.RuleTargetInput.fromObject({ type: 'review' }),
            retryAttempts: 0,
          }),
        ],
      });
      new cdk.CfnOutput(this, 'VocabFunctionName', { value: vocabFn.functionName });
    }

    this.functions = allFns;
    this.stateMachine = stateMachine;
    this.learnFn = learnFn;
    this.vocabFn = vocabFn;

    new cdk.CfnOutput(this, 'CollectFunctionName', { value: collectFn.functionName });
    new cdk.CfnOutput(this, 'CurateFunctionName', { value: curateFn.functionName });
    new cdk.CfnOutput(this, 'DeliverFunctionName', { value: deliverFn.functionName });
    new cdk.CfnOutput(this, 'StateMachineArn', { value: stateMachine.stateMachineArn });
    new cdk.CfnOutput(this, 'SsmPrefix', { value: `${prefix.ssm}/` });
    new cdk.CfnOutput(this, 'SecretsPrefix', { value: `${prefix.secrets}/` });
    new cdk.CfnOutput(this, 'NotionDbParam', { value: SSM.NOTION_DATABASE_ID });
  }
}
