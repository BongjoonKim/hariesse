import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'path';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { ENV, SECRETS } from '../../src/lib/constants';
import { SLOT_HOUR_KST } from '../../src/domain/routine';
import type { BriefSlot } from '../../src/lib/types';

export interface AssistantStackProps extends cdk.StackProps {
  tasksTable: dynamodb.Table;
  // 브리핑은 아래 리소스를 읽지 않지만, 공용 로더 getConfig()가 이름을 요구한다.
  sourcesTable: dynamodb.Table;
  articlesTable: dynamodb.Table;
  profileTable: dynamodb.Table;
  rawBucket: s3.Bucket;
}

/**
 * Assistant 스택 — 하루 3회 할일/일정 브리핑.
 * 콘텐츠 파이프라인(PipelineStack)과 스케줄·실패 반경을 분리한다.
 * 한국은 서머타임이 없어 KST → UTC는 -9시간 고정 환산이면 정확하다.
 */
export class AssistantStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AssistantStackProps) {
    super(scope, id, props);

    const { tasksTable, sourcesTable, articlesTable, profileTable, rawBucket } = props;

    const briefFn = new NodejsFunction(this, 'BriefFn', {
      entry: path.join(__dirname, '..', '..', 'src', 'handlers', 'brief', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      reservedConcurrentExecutions: 2,
      environment: {
        [ENV.TASKS_TABLE]: tasksTable.tableName,
        // 이름만 주입 — 권한은 Tasks에만 부여한다 (실수로 건드리면 IAM에서 막힌다).
        [ENV.SOURCES_TABLE]: sourcesTable.tableName,
        [ENV.ARTICLES_TABLE]: articlesTable.tableName,
        [ENV.PROFILE_TABLE]: profileTable.tableName,
        [ENV.RAW_BUCKET]: rawBucket.bucketName,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        format: OutputFormat.CJS,
        target: 'node20',
      },
    });

    briefFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameters', 'ssm:GetParameter'],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/hariesse/*`],
      })
    );
    briefFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${SECRETS.TELEGRAM_BOT_TOKEN}-*`,
        ],
      })
    );
    tasksTable.grantReadWriteData(briefFn);

    // 슬롯별 EventBridge 규칙 — 같은 Lambda를 slot만 바꿔 호출.
    const slots: BriefSlot[] = ['morning', 'midday', 'evening'];
    for (const slot of slots) {
      const utcHour = (SLOT_HOUR_KST[slot] + 24 - 9) % 24;
      new events.Rule(this, `Brief${slot[0].toUpperCase()}${slot.slice(1)}`, {
        description: `hariesse ${slot} 브리핑 — ${SLOT_HOUR_KST[slot]}:00 KST`,
        schedule: events.Schedule.cron({ minute: '0', hour: String(utcHour) }),
        targets: [
          new targets.LambdaFunction(briefFn, {
            event: events.RuleTargetInput.fromObject({ slot }),
          }),
        ],
      });
    }

    new cdk.CfnOutput(this, 'BriefFunctionName', { value: briefFn.functionName });
  }
}
