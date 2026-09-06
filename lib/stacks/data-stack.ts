import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';

/**
 * Data 스택 — 상태/메타(DynamoDB) + 본문 원문(S3).
 * 개인용이라 RETAIN 대신 DESTROY(빈 버킷 자동 삭제)로 두되, 운영 전환 시 변경.
 */
export class DataStack extends cdk.Stack {
  readonly sourcesTable: dynamodb.Table;
  readonly articlesTable: dynamodb.Table;
  readonly profileTable: dynamodb.Table;
  readonly tasksTable: dynamodb.Table;
  readonly rawBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Sources — 수집 대상 사이트와 가중치 (PK: siteId)
    this.sourcesTable = new dynamodb.Table(this, 'Sources', {
      partitionKey: { name: 'siteId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // 가중치 학습 데이터는 보존
    });
    this.sourcesTable.addGlobalSecondaryIndex({
      indexName: 'category-index',
      partitionKey: { name: 'category', type: dynamodb.AttributeType.STRING },
    });
    this.sourcesTable.addGlobalSecondaryIndex({
      indexName: 'status-index',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
    });

    // Articles — 개별 글/영상 (PK: articleId = URL 해시, dedup 키), TTL 정리
    this.articlesTable = new dynamodb.Table(this, 'Articles', {
      partitionKey: { name: 'articleId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.articlesTable.addGlobalSecondaryIndex({
      indexName: 'status-index',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'collectedAt', type: dynamodb.AttributeType.STRING },
    });
    this.articlesTable.addGlobalSecondaryIndex({
      indexName: 'category-deliveredAt-index',
      partitionKey: { name: 'category', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'deliveredAt', type: dynamodb.AttributeType.STRING },
    });

    // Profile — 단일 아이템 (PK: pk = "PROFILE")
    this.profileTable = new dynamodb.Table(this, 'Profile', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Tasks — 루틴 정의 + 날짜별 할일 (pk="ROUTINE" | "DAY#YYYY-MM-DD", sk=id)
    // 하루치 조회가 pk 하나로 끝나도록 잡은 단일 테이블 구조.
    this.tasksTable = new dynamodb.Table(this, 'Tasks', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl', // 날짜별 할일만 ttl을 갖는다. 루틴 정의는 영구 보존.
      removalPolicy: cdk.RemovalPolicy.RETAIN, // 직접 등록한 일정 — 스택을 지워도 남긴다
    });

    // S3 — raw/<articleId>.txt 본문 원문
    this.rawBucket = new s3.Bucket(this, 'RawText', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(180) }],
    });

    new cdk.CfnOutput(this, 'SourcesTableName', { value: this.sourcesTable.tableName });
    new cdk.CfnOutput(this, 'ArticlesTableName', { value: this.articlesTable.tableName });
    new cdk.CfnOutput(this, 'ProfileTableName', { value: this.profileTable.tableName });
    new cdk.CfnOutput(this, 'TasksTableName', { value: this.tasksTable.tableName });
    new cdk.CfnOutput(this, 'RawBucketName', { value: this.rawBucket.bucketName });
  }
}
