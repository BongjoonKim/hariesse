import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as fs from 'fs';
import * as path from 'path';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import { ENV, SECRETS } from '../../src/lib/constants';

export interface WebStackProps extends cdk.StackProps {
  tasksTable: dynamodb.Table;
  // 아래 셋은 이름만 주입 — 공용 로더 getConfig()가 요구한다. 권한은 주지 않는다.
  sourcesTable: dynamodb.Table;
  articlesTable: dynamodb.Table;
  profileTable: dynamodb.Table;
  rawBucket: s3.Bucket;
}

const WEB_DIST = path.join(__dirname, '..', '..', 'web', 'dist');

/**
 * Web 스택 — hariesse 관리 UI.
 *
 * CloudFront 배포 **하나**에 두 오리진을 물린다:
 *   기본     → S3(비공개, OAC)   : SPA 정적 파일
 *   /api/*  → Lambda Function URL: 할일·루틴 API
 *
 * 같은 오리진이라 CORS가 없고, 세션 쿠키를 HttpOnly·Secure·SameSite=Lax로 쓸 수 있다.
 * API 인증은 세션 쿠키 검증이 맡는다 (Function URL에 OAC를 못 쓰는 이유는 아래 주석).
 */
export class WebStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);

    const { tasksTable, sourcesTable, articlesTable, profileTable, rawBucket } = props;

    // ---- API Lambda ----
    const apiFn = new NodejsFunction(this, 'WebApiFn', {
      entry: path.join(__dirname, '..', '..', 'src', 'handlers', 'api', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(20),
      memorySize: 256,
      reservedConcurrentExecutions: 5,
      environment: {
        [ENV.TASKS_TABLE]: tasksTable.tableName,
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

    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameters', 'ssm:GetParameter'],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/hariesse/*`],
      })
    );
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${SECRETS.GOOGLE_OAUTH}-*`,
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${SECRETS.SESSION_SECRET}-*`,
        ],
      })
    );
    tasksTable.grantReadWriteData(apiFn);

    // authType NONE + 세션 쿠키 검증. OAC(AWS_IAM)를 쓰지 않는 이유는 아래 오리진 설정 참고.
    const apiUrl = apiFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });

    // ---- SPA 버킷 ----
    const siteBucket = new s3.Bucket(this, 'Site', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ---- CloudFront ----
    // SPA 폴백을 errorResponses로 하면 **배포 전체**에 걸려 API의 404까지 index.html(200)로
    // 바뀐다. 기본 behavior에만 붙는 뷰어 함수로 처리해 /api/* 응답은 그대로 통과시킨다.
    const spaFallback = new cloudfront.Function(this, 'SpaFallback', {
      comment: '확장자 없는 경로를 index.html로 (클라이언트 라우팅 대비)',
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(
        [
          'function handler(event) {',
          '  var request = event.request;',
          '  if (request.uri.indexOf("/api/") === 0) return request;',
          '  var last = request.uri.split("/").pop();',
          '  if (last.indexOf(".") === -1) request.uri = "/index.html";',
          '  return request;',
          '}',
        ].join('\n')
      ),
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'hariesse web',
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200, // 서울 엣지 포함
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        functionAssociations: [
          {
            function: spaFallback,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      additionalBehaviors: {
        '/api/*': {
          /**
           * OAC(Function URL + AWS_IAM)를 쓰지 않는다.
           * AWS 문서: "If you use PUT or POST methods with your Lambda function URL, your users
           * must compute the SHA256 of the body and include the payload hash ... in the
           * x-amz-content-sha256 header. Lambda doesn't support unsigned payloads."
           * 그런데 CloudFront Function은 **요청 본문에 접근할 수 없어** 엣지에서 채워줄 수 없다.
           * 이 API는 저장·체크가 전부 POST/PATCH라 OAC를 쓰면 쓰기가 통째로 막힌다.
           *
           * 대신 인증은 핸들러의 세션 쿠키 검증이 맡는다 (기존 Telegram webhook과 같은 형태).
           * Function URL 자체는 공개지만 `/auth/*` 외 모든 경로가 유효한 서명 세션을 요구하고,
           * reservedConcurrentExecutions로 남용 반경을 묶어 둔다.
           */
          origin: new origins.FunctionUrlOrigin(apiUrl),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          // 쿠키·쿼리스트링은 그대로 넘기되 Host는 오리진 것으로.
          // Function URL은 Host가 자기 도메인이 아니면 동작하지 않는다(AWS 문서 명시).
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
    });

    // ---- 정적 파일 배포 ----
    const built = fs.existsSync(path.join(WEB_DIST, 'index.html'));
    if (!built) {
      cdk.Annotations.of(this).addWarning(
        'web/dist 가 없습니다. `npm run build:web` 후 다시 배포하세요 — 지금은 안내 페이지만 올라갑니다.'
      );
    }
    new s3deploy.BucketDeployment(this, 'DeploySite', {
      sources: built
        ? [s3deploy.Source.asset(WEB_DIST)]
        : [
            s3deploy.Source.data(
              'index.html',
              '<!doctype html><meta charset="utf-8"><title>hariesse</title>' +
                '<p style="font-family:system-ui;padding:2rem">웹이 아직 빌드되지 않았습니다. ' +
                '<code>npm run build:web</code> 후 다시 배포하세요.</p>'
            ),
          ],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ['/*'],
      prune: true,
    });

    new cdk.CfnOutput(this, 'WebUrl', { value: `https://${distribution.distributionDomainName}` });
    new cdk.CfnOutput(this, 'SiteBucketName', { value: siteBucket.bucketName });
    new cdk.CfnOutput(this, 'RedirectUri', {
      value: `https://${distribution.distributionDomainName}/api/auth/callback`,
      description: 'Google Cloud Console의 승인된 리디렉션 URI에 그대로 등록',
    });
  }
}
