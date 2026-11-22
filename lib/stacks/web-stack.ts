import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'path';
import * as fs from 'fs';
import * as esbuild from 'esbuild';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { ENV, configPrefix, secretNames } from '../../src/lib/constants';

/** 사용자 도메인 연결 (cdk.json context `web`). 없으면 CloudFront 기본 주소(xxxx.cloudfront.net)만 쓴다. */
export interface WebDomain {
  /** 예: hariesse.nadeliv.com */
  domainName: string;
  /** us-east-1의 ACM 인증서 ARN (CloudFront는 us-east-1 인증서만 받는다) */
  certificateArn: string;
  hostedZoneId: string;
  /** 예: nadeliv.com */
  zoneName: string;
}

export interface WebStackProps extends cdk.StackProps {
  sourcesTable: dynamodb.Table;
  articlesTable: dynamodb.Table;
  profileTable: dynamodb.Table;
  rawBucket: s3.Bucket;
  stage?: string;
  domain?: WebDomain;
}

const ROOT = path.join(__dirname, '..', '..');
const WEB_DIR = path.join(ROOT, 'web');

/**
 * 프론트 빌드: web/src/main.ts → web/dist/app.js (esbuild) + 정적 파일 복사.
 * synth 때마다 돈다 — 따로 빌드 단계를 두지 않아 CI(deploy.yml)가 그대로 쓴다. dist는 커밋하지 않는다.
 */
export function buildWebAssets(): string {
  const out = path.join(WEB_DIR, 'dist');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  esbuild.buildSync({
    entryPoints: [path.join(WEB_DIR, 'src', 'main.ts')],
    bundle: true,
    minify: true,
    format: 'iife',
    target: 'es2020',
    outfile: path.join(out, 'app.js'),
    logLevel: 'warning',
  });
  for (const file of fs.readdirSync(path.join(WEB_DIR, 'public'))) {
    fs.copyFileSync(path.join(WEB_DIR, 'public', file), path.join(out, file));
  }
  return out;
}

/**
 * Web 스택 — "오늘의 미션" 웹.
 *   CloudFront ─┬─ /        → S3 (정적 프론트, OAC로만 접근)
 *               └─ /api/*  → WebFn Function URL (비밀번호 로그인 + 세션 쿠키)
 *   학습 테이블(DynamoDB) = Notion 단어장·Writing 사본 + 일별 미션 기록. 30분마다 Notion → 사본 동기화.
 * TOEFL 기능과 같이 내 배포 전용이다 (stage 배포에는 만들지 않는다 — bin/app.ts).
 */
export class WebStack extends cdk.Stack {
  readonly webFn: lambda.IFunction;

  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);

    const { sourcesTable, articlesTable, profileTable, rawBucket, stage, domain } = props;
    const prefix = configPrefix(stage);
    const SECRETS = secretNames(prefix.secrets);

    // 학습 테이블 — 미러는 Notion에서 다시 만들 수 있지만 일별 미션 기록(연속 기록)은 여기만 있으므로 보존
    const studyTable = new dynamodb.Table(this, 'Study', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // 로그인 비밀번호 — 처음엔 무작위 값. 사용자가 Secrets Manager에서 원하는 값으로 바꿔 쓴다 (재배포해도 덮어쓰지 않는다).
    const password = new secretsmanager.Secret(this, 'WebPassword', {
      secretName: SECRETS.WEB_PASSWORD,
      description: 'hariesse 웹 로그인 비밀번호',
      generateSecretString: { passwordLength: 24, excludePunctuation: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const webFn = new NodejsFunction(this, 'WebFn', {
      entry: path.join(ROOT, 'src', 'handlers', 'web', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      // 등록 1회 = Bedrock 최대 5번. CloudFront origin 응답 대기(60초)와 맞춘다.
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      // 화면 하나가 API 2~3개를 동시에 부른다 + 30분 동기화
      reservedConcurrentExecutions: 5,
      environment: {
        [ENV.SOURCES_TABLE]: sourcesTable.tableName,
        [ENV.ARTICLES_TABLE]: articlesTable.tableName,
        [ENV.PROFILE_TABLE]: profileTable.tableName,
        [ENV.RAW_BUCKET]: rawBucket.bucketName,
        [ENV.STUDY_TABLE]: studyTable.tableName,
        ...(stage ? { [ENV.STAGE]: stage } : {}),
      },
      bundling: { externalModules: ['@aws-sdk/*'], format: OutputFormat.CJS, target: 'node20' },
    });

    webFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameters', 'ssm:GetParameter'],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${prefix.ssm}/*`],
      })
    );
    webFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:${SECRETS.NOTION_TOKEN}-*`],
      })
    );
    password.grantRead(webFn);
    webFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: ['arn:aws:bedrock:*::foundation-model/*', `arn:aws:bedrock:*:${this.account}:inference-profile/*`],
      })
    );
    studyTable.grantReadWriteData(webFn);
    articlesTable.grantReadData(webFn); // 오늘 다이제스트 글
    profileTable.grantReadData(webFn); // 학습 레슨 진도 (pk 'LEARNING')

    // Notion → 사본 동기화. Telegram·Notion에서 바꾼 것이 웹에 보이기까지 최대 30분 (웹의 새로고침 버튼은 즉시).
    webFn.configureAsyncInvoke({ retryAttempts: 0 });
    new events.Rule(this, 'StudySyncSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(30)),
      targets: [
        new targets.LambdaFunction(webFn, { event: events.RuleTargetInput.fromObject({ type: 'sync' }), retryAttempts: 0 }),
      ],
    });

    // 인증은 핸들러의 세션 쿠키 검증 (Telegram webhook과 같은 방식 — Function URL 자체는 공개)
    const fnUrl = webFn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });

    const siteBucket = new s3.Bucket(this, 'Site', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `hariesse web${stage ? ` (${stage})` : ''}`,
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200, // 아시아 엣지 포함
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      ...(domain
        ? {
            domainNames: [domain.domainName],
            certificate: acm.Certificate.fromCertificateArn(this, 'Cert', domain.certificateArn),
          }
        : {}),
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        compress: true,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.FunctionUrlOrigin(fnUrl, { readTimeout: cdk.Duration.seconds(60) }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          // 쿠키·본문·쿼리를 그대로 넘긴다. Host는 Function URL 것이어야 하므로 뺀다.
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        },
      },
    });

    new s3deploy.BucketDeployment(this, 'DeploySite', {
      sources: [s3deploy.Source.asset(buildWebAssets())],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ['/*'],
      // 파일 이름에 해시를 안 붙이므로 브라우저는 매번 확인한다 (파일 3개, 변경 없으면 304)
      cacheControl: [s3deploy.CacheControl.noCache()],
      prune: true,
    });

    if (domain) {
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
        hostedZoneId: domain.hostedZoneId,
        zoneName: domain.zoneName,
      });
      const target = route53.RecordTarget.fromAlias(new route53targets.CloudFrontTarget(distribution));
      new route53.ARecord(this, 'AliasA', { zone, recordName: domain.domainName, target });
      new route53.AaaaRecord(this, 'AliasAaaa', { zone, recordName: domain.domainName, target });
    }

    this.webFn = webFn;
    new cdk.CfnOutput(this, 'WebUrl', { value: `https://${domain?.domainName ?? distribution.distributionDomainName}` });
    new cdk.CfnOutput(this, 'DistributionDomain', { value: distribution.distributionDomainName });
    new cdk.CfnOutput(this, 'WebFunctionName', { value: webFn.functionName });
    new cdk.CfnOutput(this, 'StudyTableName', { value: studyTable.tableName });
    new cdk.CfnOutput(this, 'WebPasswordSecret', { value: password.secretName });
  }
}
