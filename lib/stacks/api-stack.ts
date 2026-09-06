import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'path';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import { ENV, SECRETS } from '../../src/lib/constants';

export interface ApiStackProps extends cdk.StackProps {
  sourcesTable: dynamodb.Table;
  articlesTable: dynamodb.Table;
  profileTable: dynamodb.Table;
  tasksTable: dynamodb.Table;
  rawBucket: s3.Bucket;
}

/**
 * API 스택 — Telegram webhook 수신용 Feedback Lambda + Function URL.
 * 다이제스트 피드백 버튼(`v1|…`)과 브리핑 할일 체크 버튼(`t1|…`)을 한 webhook에서 처리한다.
 * 인증은 Telegram secret_token 헤더 검증으로 처리 (API Gateway 불필요).
 * 배포 후: setWebhook으로 Function URL + secret_token 등록 필요.
 */
export class ApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const { sourcesTable, articlesTable, profileTable, tasksTable, rawBucket } = props;

    const feedbackFn = new NodejsFunction(this, 'FeedbackFn', {
      entry: path.join(__dirname, '..', '..', 'src', 'handlers', 'feedback', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(15), // Telegram webhook 타임아웃 안쪽
      memorySize: 256,
      reservedConcurrentExecutions: 2,
      environment: {
        [ENV.SOURCES_TABLE]: sourcesTable.tableName,
        [ENV.ARTICLES_TABLE]: articlesTable.tableName,
        [ENV.PROFILE_TABLE]: profileTable.tableName,
        [ENV.TASKS_TABLE]: tasksTable.tableName,
        [ENV.RAW_BUCKET]: rawBucket.bucketName,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        format: OutputFormat.CJS,
        target: 'node20',
      },
    });

    feedbackFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameters', 'ssm:GetParameter'],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/hariesse/*`],
      })
    );
    feedbackFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${SECRETS.TELEGRAM_BOT_TOKEN}-*`,
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${SECRETS.NOTION_TOKEN}-*`,
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${SECRETS.TELEGRAM_WEBHOOK_SECRET}-*`,
        ],
      })
    );

    articlesTable.grantReadWriteData(feedbackFn);
    sourcesTable.grantReadWriteData(feedbackFn);
    profileTable.grantReadWriteData(feedbackFn);
    tasksTable.grantReadWriteData(feedbackFn); // 브리핑 할일 체크 버튼

    const fnUrl = feedbackFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE, // 인증은 핸들러의 secret_token 검증
    });

    new cdk.CfnOutput(this, 'FeedbackUrl', { value: fnUrl.url });
  }
}
