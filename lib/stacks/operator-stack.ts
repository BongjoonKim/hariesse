import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { configPrefix, stackPrefix } from '../../src/lib/constants';

export interface OperatorStackProps extends cdk.StackProps {
  stage: string;
  tables: dynamodb.Table[];
  rawBucket: s3.Bucket;
  functions: lambda.IFunction[];
  stateMachine: sfn.StateMachine;
  /**
   * CDK 배포 권한(bootstrap 역할 assume)까지 줄지. 기본 false.
   * true면 이 사용자는 사실상 계정 전체에 배포할 수 있다(bootstrap 실행 역할이 관리자 권한) — 신뢰하는 사람에게만.
   */
  allowDeploy?: boolean;
}

/**
 * Operator 스택 — 이 stage의 리소스만 "운영"할 수 있는 IAM 사용자.
 * 다른 PC의 Claude Code에 액세스 키를 주고 설정·소스 추가·수동 실행·로그 확인을 맡기기 위한 것.
 *
 * 할 수 있는 것: SSM(이 stage 접두어) 읽기/쓰기, Secrets(이 stage 접두어) 생성/갱신/읽기,
 *   이 stage의 Lambda 호출·설정 변경(콜드스타트 강제용)·로그 조회, 상태머신 실행, 테이블 읽기/쓰기(seed/add-source),
 *   이 stage 스택의 Outputs 조회, Bedrock 모델/추론 프로파일 목록 조회.
 * 할 수 없는 것: 코드 배포(cdk deploy), 다른 stage(=내 것) 리소스 접근, IAM 변경.
 *
 * 액세스 키는 CDK로 만들지 않는다(시크릿이 CloudFormation에 남는다). 배포 후 콘솔/CLI로 직접 발급:
 *   aws iam create-access-key --user-name <OperatorUserName>
 */
export class OperatorStack extends cdk.Stack {
  readonly user: iam.User;

  constructor(scope: Construct, id: string, props: OperatorStackProps) {
    super(scope, id, props);

    const { stage, tables, rawBucket, functions, stateMachine } = props;
    const prefix = configPrefix(stage);
    const stacks = stackPrefix(stage);
    const userName = `${prefix.secrets}-operator`; // 예: hariesse-design-operator

    this.user = new iam.User(this, 'OperatorUser', { userName });

    const policy = new iam.ManagedPolicy(this, 'OperatorPolicy', {
      managedPolicyName: `${userName}-policy`,
      description: `hariesse stage=${stage} 운영 권한 (배포 불가)`,
    });
    this.user.addManagedPolicy(policy);

    // 설정값: 이 stage 접두어의 SSM 파라미터만
    policy.addStatements(
      new iam.PolicyStatement({
        sid: 'SsmStageParams',
        actions: [
          'ssm:GetParameter',
          'ssm:GetParameters',
          'ssm:GetParametersByPath',
          'ssm:PutParameter',
          'ssm:DeleteParameter',
          'ssm:GetParameterHistory',
          'ssm:AddTagsToResource',
        ],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${prefix.ssm}/*`],
      }),
      // DescribeParameters는 리소스 범위 지정이 안 됨 — 이름 목록만 보인다(값은 위 정책 범위에서만).
      new iam.PolicyStatement({ sid: 'SsmDescribe', actions: ['ssm:DescribeParameters'], resources: ['*'] })
    );

    // 시크릿: 이 stage 접두어의 시크릿만 (생성 포함)
    policy.addStatements(
      new iam.PolicyStatement({
        sid: 'SecretsStage',
        actions: [
          'secretsmanager:CreateSecret',
          'secretsmanager:PutSecretValue',
          'secretsmanager:UpdateSecret',
          'secretsmanager:GetSecretValue',
          'secretsmanager:DescribeSecret',
          'secretsmanager:TagResource',
        ],
        resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:${prefix.secrets}/*`],
      }),
      new iam.PolicyStatement({ sid: 'SecretsList', actions: ['secretsmanager:ListSecrets'], resources: ['*'] })
    );

    // Lambda: 이 stage의 함수만 — 호출, 조회, 설정 변경(환경변수 → SSM 캐시 리셋용), 로그
    const fnArns = functions.map((f) => f.functionArn);
    policy.addStatements(
      new iam.PolicyStatement({
        sid: 'LambdaStageFunctions',
        actions: [
          'lambda:InvokeFunction',
          'lambda:GetFunction',
          'lambda:GetFunctionConfiguration',
          'lambda:UpdateFunctionConfiguration',
          'lambda:ListTags',
        ],
        resources: fnArns,
      }),
      new iam.PolicyStatement({ sid: 'LambdaList', actions: ['lambda:ListFunctions'], resources: ['*'] }),
      new iam.PolicyStatement({
        sid: 'LogsStageFunctions',
        actions: ['logs:DescribeLogStreams', 'logs:GetLogEvents', 'logs:FilterLogEvents', 'logs:StartQuery', 'logs:GetQueryResults', 'logs:StopQuery'],
        resources: functions.flatMap((f) => [
          `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/lambda/${f.functionName}`,
          `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/lambda/${f.functionName}:*`,
        ]),
      }),
      new iam.PolicyStatement({ sid: 'LogsDescribe', actions: ['logs:DescribeLogGroups'], resources: ['*'] })
    );

    // Step Functions: 이 stage의 상태머신 실행/조회
    policy.addStatements(
      new iam.PolicyStatement({
        sid: 'SfnStage',
        actions: ['states:StartExecution', 'states:DescribeStateMachine', 'states:ListExecutions'],
        resources: [stateMachine.stateMachineArn],
      }),
      new iam.PolicyStatement({
        sid: 'SfnStageExecutions',
        actions: ['states:DescribeExecution', 'states:GetExecutionHistory', 'states:StopExecution'],
        resources: [
          cdk.Stack.of(this).formatArn({
            service: 'states',
            resource: 'execution',
            arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
            resourceName: `${stateMachine.stateMachineName}:*`,
          }),
        ],
      })
    );

    // 데이터: seed / add-source / 상태 확인용. 테이블 삭제는 불가.
    for (const t of tables) t.grantReadWriteData(this.user);
    rawBucket.grantRead(this.user);

    // 스택 Outputs(테이블·함수 이름) 조회 — 이 stage 스택만
    policy.addStatements(
      new iam.PolicyStatement({
        sid: 'CfnStageOutputs',
        actions: ['cloudformation:DescribeStacks', 'cloudformation:ListStackResources', 'cloudformation:DescribeStackResources'],
        resources: [`arn:aws:cloudformation:${this.region}:${this.account}:stack/${stacks}*/*`],
      }),
      // Bedrock 모델 ID 확인용 (목록만, 호출 불가)
      new iam.PolicyStatement({
        sid: 'BedrockList',
        actions: ['bedrock:ListFoundationModels', 'bedrock:ListInferenceProfiles', 'bedrock:GetFoundationModel', 'bedrock:GetInferenceProfile'],
        resources: ['*'],
      })
    );

    if (props.allowDeploy) {
      // CDK v2 배포: bootstrap 역할 assume + CDK가 쓰는 조회. 사실상 계정 전체 배포 권한.
      policy.addStatements(
        new iam.PolicyStatement({
          sid: 'CdkBootstrapRoles',
          actions: ['sts:AssumeRole'],
          resources: [`arn:aws:iam::${this.account}:role/cdk-*`],
        }),
        new iam.PolicyStatement({
          sid: 'CdkBootstrapVersion',
          actions: ['ssm:GetParameter'],
          resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/cdk-bootstrap/*`],
        })
      );
    }

    new cdk.CfnOutput(this, 'OperatorUserName', { value: this.user.userName });
    new cdk.CfnOutput(this, 'OperatorPolicyArn', { value: policy.managedPolicyArn });
    new cdk.CfnOutput(this, 'AllowDeploy', { value: String(Boolean(props.allowDeploy)) });
  }
}
