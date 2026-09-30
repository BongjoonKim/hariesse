/**
 * 학습 트랙 커리큘럼 (데이터만, 네트워크 없음).
 *
 * 범위는 cloud / backend / frontend / cicd 로 한정한다.
 * 레슨 본문은 hariesse(Bedrock)가 매번 쓰지만, **목차·핵심 포인트·참고 링크는 여기서 고정**한다.
 * - 목차를 고정해야 난이도가 순서대로 쌓인다 (LLM에 맡기면 매번 1강만 반복한다).
 * - 참고 링크를 LLM이 만들게 하면 없는 URL을 지어낸다. 공식 문서만, 2026-09-30 생존 확인.
 *
 * 레슨 id는 Telegram callback_data에 들어가므로 짧게 유지하고, **한 번 배포한 id는 바꾸지 말 것**
 * (진도·완료 기록이 id로 저장된다). 레슨 추가는 트랙 끝에 붙인다.
 */

export type LearningArea = 'cloud' | 'backend' | 'frontend' | 'cicd';

export const AREA_LABEL: Record<LearningArea, string> = {
  cloud: '클라우드',
  backend: '백엔드',
  frontend: '프론트엔드',
  cicd: 'CI/CD',
};

export interface Lesson {
  id: string;
  title: string;
  /** 이번 레슨에서 반드시 다룰 포인트 — 프롬프트에 그대로 들어간다 */
  points: string[];
  /** 공식 문서 링크 (첫 번째가 대표 링크) */
  refs: string[];
}

export interface Track {
  id: string;
  name: string;
  area: LearningArea;
  emoji: string;
  /** 수집된 글 중 이 트랙과 관련된 글을 고를 때 쓰는 키워드 (소문자 비교) */
  keywords: string[];
  lessons: Lesson[];
}

export const CURRICULUM: Track[] = [
  {
    id: 'k8s',
    name: 'Kubernetes',
    area: 'cloud',
    emoji: '☸️',
    keywords: ['kubernetes', 'k8s', 'kubectl', 'helm', 'eks', '쿠버네티스', 'container', '컨테이너', 'docker'],
    lessons: [
      {
        id: 'k8s-01',
        title: '컨테이너와 쿠버네티스가 푸는 문제',
        points: ['VM vs 컨테이너', '이미지와 컨테이너의 관계', '컨테이너가 많아지면 생기는 문제(배치·복구·확장)', '쿠버네티스 = 선언형 오케스트레이터'],
        refs: ['https://kubernetes.io/docs/concepts/overview/'],
      },
      {
        id: 'k8s-02',
        title: '클러스터 구조: 컨트롤 플레인, 노드, kubectl',
        points: ['API 서버·etcd·스케줄러·컨트롤러 매니저', 'kubelet과 컨테이너 런타임', 'kubectl이 API 서버와 대화하는 방식', '원하는 상태(desired) vs 현재 상태(actual) 조정 루프'],
        refs: ['https://kubernetes.io/docs/concepts/architecture/'],
      },
      {
        id: 'k8s-03',
        title: 'Pod: 가장 작은 배포 단위',
        points: ['Pod와 컨테이너의 차이', '같은 Pod 안 컨테이너가 공유하는 것(네트워크·볼륨)', 'Pod는 일회용이다 — 직접 만들지 않는 이유', 'kubectl get/describe/logs'],
        refs: ['https://kubernetes.io/docs/concepts/workloads/pods/'],
      },
      {
        id: 'k8s-04',
        title: 'Deployment: 롤링 업데이트와 롤백',
        points: ['Deployment → ReplicaSet → Pod 계층', 'replicas와 자가 복구', '롤링 업데이트 전략(maxSurge/maxUnavailable)', 'kubectl rollout status/undo'],
        refs: ['https://kubernetes.io/docs/concepts/workloads/controllers/deployment/'],
      },
      {
        id: 'k8s-05',
        title: 'Service와 Ingress: 트래픽을 Pod로 보내기',
        points: ['Pod IP가 바뀌는 문제와 Service', 'ClusterIP / NodePort / LoadBalancer', '라벨 셀렉터로 대상 찾기', 'Ingress로 도메인·경로 라우팅'],
        refs: [
          'https://kubernetes.io/docs/concepts/services-networking/service/',
          'https://kubernetes.io/docs/concepts/services-networking/ingress/',
        ],
      },
      {
        id: 'k8s-06',
        title: 'ConfigMap과 Secret: 설정을 이미지에서 분리',
        points: ['12-factor 설정 원칙', '환경변수 주입 vs 볼륨 마운트', 'Secret은 암호화가 아니라 base64라는 점', '외부 시크릿 저장소 연동의 필요성'],
        refs: [
          'https://kubernetes.io/docs/concepts/configuration/configmap/',
          'https://kubernetes.io/docs/concepts/configuration/secret/',
        ],
      },
      {
        id: 'k8s-07',
        title: '리소스 requests/limits와 오토스케일링(HPA)',
        points: ['requests는 스케줄링, limits는 상한', 'OOMKilled와 CPU 스로틀링', 'HPA가 메트릭을 보고 replicas를 조정하는 방식', '적정값을 정하는 요령'],
        refs: [
          'https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/',
          'https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/',
        ],
      },
      {
        id: 'k8s-08',
        title: '헬스체크(Probe)와 트러블슈팅',
        points: ['liveness / readiness / startup probe 차이', 'CrashLoopBackOff, ImagePullBackOff 읽는 법', 'describe → events → logs 순서로 좁히기', 'AI에게 장애 로그를 줄 때 같이 줘야 할 정보'],
        refs: [
          'https://kubernetes.io/docs/concepts/workloads/pods/probes/',
          'https://kubernetes.io/docs/tasks/debug/',
        ],
      },
      {
        id: 'k8s-09',
        title: 'Helm과 관리형 쿠버네티스(EKS)',
        points: ['매니페스트 반복을 줄이는 Helm 차트', 'values.yaml로 환경별 설정', 'EKS가 대신 관리해주는 것과 내가 관리할 것', '서버리스(Lambda)와 쿠버네티스를 고르는 기준'],
        refs: [
          'https://helm.sh/docs/intro/quickstart/',
          'https://docs.aws.amazon.com/eks/latest/userguide/what-is-eks.html',
        ],
      },
    ],
  },
  {
    id: 'jenkins',
    name: 'Jenkins',
    area: 'cicd',
    emoji: '🤵',
    keywords: ['jenkins', 'jenkinsfile', 'ci/cd', 'cicd', 'pipeline', '파이프라인', 'github actions', 'devops'],
    lessons: [
      {
        id: 'jk-01',
        title: 'CI/CD의 목적과 Jenkins의 위치',
        points: ['CI(통합)와 CD(전달/배포)의 차이', '빌드→테스트→배포 자동화가 주는 것', 'Jenkins가 오래 쓰이는 이유(플러그인·자체호스팅)', '파이프라인을 코드로 관리한다는 개념'],
        refs: ['https://www.jenkins.io/doc/book/pipeline/'],
      },
      {
        id: 'jk-02',
        title: 'Jenkins 구조: 컨트롤러, 에이전트, 잡, 플러그인',
        points: ['컨트롤러는 조율, 에이전트는 실행', '실행기(executor)와 라벨', '플러그인 의존성 관리의 함정', '컨트롤러에서 빌드를 돌리면 안 되는 이유'],
        refs: ['https://www.jenkins.io/doc/book/managing/nodes/'],
      },
      {
        id: 'jk-03',
        title: 'Jenkinsfile 기초: Declarative Pipeline',
        points: ['pipeline / agent / stages / stage / steps 구조', 'Declarative vs Scripted 차이', 'environment와 parameters', '리포 루트에 Jenkinsfile을 두는 이유'],
        refs: ['https://www.jenkins.io/doc/book/pipeline/syntax/'],
      },
      {
        id: 'jk-04',
        title: '빌드·테스트·알림: stage 설계와 post',
        points: ['stage를 나누는 기준', 'post { always / success / failure }', '테스트 리포트·아티팩트 보관', '실패를 빨리 드러내는 순서(fail fast)'],
        refs: ['https://www.jenkins.io/doc/book/pipeline/jenkinsfile/'],
      },
      {
        id: 'jk-05',
        title: 'Credentials: 시크릿을 코드에 두지 않기',
        points: ['Credentials 종류(secret text, username/password, SSH key)', 'withCredentials와 credentials() 헬퍼', '로그 마스킹의 한계', 'AWS 권한은 장기 키 대신 역할로'],
        refs: ['https://www.jenkins.io/doc/book/using/using-credentials/'],
      },
      {
        id: 'jk-06',
        title: 'Multibranch Pipeline과 웹훅',
        points: ['브랜치·PR마다 파이프라인 자동 생성', 'GitHub 웹훅으로 트리거', 'when { branch } 로 배포 단계 제한', 'PR 검증과 main 배포 분리'],
        refs: ['https://www.jenkins.io/doc/book/pipeline/multibranch/'],
      },
      {
        id: 'jk-07',
        title: 'Docker 에이전트로 빌드 환경 고정',
        points: ['"내 PC에선 되는데" 문제', 'agent { docker { image ... } }', '캐시와 빌드 속도', '이미지 빌드·푸시 단계 구성'],
        refs: ['https://www.jenkins.io/doc/book/pipeline/docker/'],
      },
      {
        id: 'jk-08',
        title: 'Shared Library: 파이프라인 재사용',
        points: ['여러 리포의 Jenkinsfile 중복 문제', 'vars/ 와 src/ 구조', '버전 고정(@Library 태그)', '공통화할 것과 리포에 남길 것'],
        refs: ['https://www.jenkins.io/doc/book/pipeline/shared-libraries/'],
      },
      {
        id: 'jk-09',
        title: 'Jenkins vs GitHub Actions: 언제 무엇을',
        points: ['자체호스팅 vs 관리형', '개념 대응표(Jenkinsfile↔workflow, agent↔runner, stage↔job)', '마이그레이션 시 주의점', '개인 프로젝트에 맞는 선택'],
        refs: [
          'https://docs.github.com/en/actions/get-started/understand-github-actions',
          'https://docs.github.com/en/actions/tutorials/migrate-to-github-actions/manual-migrations/migrate-from-jenkins',
        ],
      },
    ],
  },
  {
    id: 'node',
    name: 'Node.js',
    area: 'backend',
    emoji: '🟩',
    keywords: ['node.js', 'nodejs', 'node', 'npm', 'express', 'fastify', 'typescript', 'javascript', 'backend', '백엔드'],
    lessons: [
      {
        id: 'nd-01',
        title: 'Node.js 런타임과 이벤트 루프',
        points: ['V8 + libuv 구조', '싱글 스레드인데 동시 처리가 되는 이유', '이벤트 루프 단계와 마이크로태스크', 'CPU 바운드 작업이 서버를 멈추는 이유'],
        refs: ['https://nodejs.org/learn/asynchronous-work/event-loop-timers-and-nexttick'],
      },
      {
        id: 'nd-02',
        title: '비동기: 콜백 → Promise → async/await',
        points: ['콜백 지옥과 에러 전파', 'Promise 상태와 체이닝', 'async/await와 try/catch', 'Promise.all / allSettled로 병렬 처리'],
        refs: ['https://nodejs.org/learn/asynchronous-work/javascript-asynchronous-programming-and-callbacks'],
      },
      {
        id: 'nd-03',
        title: '모듈 시스템과 package.json',
        points: ['CommonJS vs ESM', '"type": "module"과 확장자', 'dependencies vs devDependencies, lock 파일', 'npm scripts 활용'],
        refs: ['https://nodejs.org/api/esm.html', 'https://docs.npmjs.com/cli/configuring-npm/package-json/'],
      },
      {
        id: 'nd-04',
        title: 'HTTP 서버: 라우팅과 미들웨어',
        points: ['node:http로 서버 만들기', 'Express 라우팅', '미들웨어 체인의 순서', '요청 검증과 응답 코드 설계'],
        refs: ['https://expressjs.com/en/guide/routing/', 'https://expressjs.com/en/guide/using-middleware/'],
      },
      {
        id: 'nd-05',
        title: '에러 처리와 로깅',
        points: ['동기/비동기 에러의 차이', 'unhandledRejection과 프로세스 종료', '에러를 삼키지 않고 격리하기', '구조화 로그(JSON)와 요청 ID'],
        refs: ['https://nodejs.org/api/errors.html'],
      },
      {
        id: 'nd-06',
        title: '스트림과 버퍼: 큰 데이터를 다루는 법',
        points: ['Buffer와 인코딩', 'Readable / Writable / Transform', 'pipeline()과 backpressure', '파일·S3 업로드에 스트림을 쓰는 이유'],
        refs: ['https://nodejs.org/api/stream.html'],
      },
      {
        id: 'nd-07',
        title: '설정·환경변수·보안 기본',
        points: ['process.env와 --env-file', '시크릿을 코드/리포에 두지 않기', '입력 검증과 의존성 취약점(npm audit)', '최소 권한 원칙'],
        refs: ['https://nodejs.org/learn/command-line/how-to-read-environment-variables-from-nodejs'],
      },
      {
        id: 'nd-08',
        title: '테스트: node:test와 순수함수 분리',
        points: ['내장 테스트 러너 node:test', '네트워크와 로직을 분리해야 테스트가 쉬워지는 이유', '목(mock)은 경계에서만', 'AI가 만든 코드를 테스트로 검증하기'],
        refs: ['https://nodejs.org/api/test.html'],
      },
      {
        id: 'nd-09',
        title: '서버리스(Lambda) 위의 Node.js',
        points: ['핸들러 모델과 콜드스타트', '핸들러 밖 초기화·캐시(재사용 컨텍스트)', '타임아웃·동시성 제한', '번들링(esbuild)과 네이티브 모듈 주의점'],
        refs: ['https://docs.aws.amazon.com/lambda/latest/dg/lambda-nodejs.html'],
      },
    ],
  },
  {
    id: 'langflow',
    name: 'Langflow',
    area: 'backend',
    emoji: '🔗',
    keywords: ['langflow', 'langchain', 'rag', 'agent', '에이전트', 'llm', 'vector', '벡터', 'embedding'],
    lessons: [
      {
        id: 'lf-01',
        title: 'Langflow란: 비주얼 LLM 워크플로 빌더',
        points: ['노드(컴포넌트)를 연결해 LLM 앱을 만드는 방식', '코드로 짜는 것과 비교한 장단점', '플로우 / 컴포넌트 / 플레이그라운드 개념', '어떤 문제에 적합한가'],
        refs: ['https://docs.langflow.org/concepts-overview'],
      },
      {
        id: 'lf-02',
        title: '설치와 첫 플로우',
        points: ['설치 방법(Desktop / pip / Docker)', '템플릿으로 첫 챗봇 만들기', '모델 API 키 설정', '플레이그라운드에서 테스트하기'],
        refs: ['https://docs.langflow.org/get-started-installation', 'https://docs.langflow.org/get-started-quickstart'],
      },
      {
        id: 'lf-03',
        title: '컴포넌트와 데이터 흐름',
        points: ['입력 → 프롬프트 → 모델 → 출력', '포트와 데이터 타입', '컴포넌트 설정값과 전역 변수', '플로우를 작게 나눠 디버깅하기'],
        refs: ['https://docs.langflow.org/concepts-components'],
      },
      {
        id: 'lf-04',
        title: '프롬프트 템플릿과 변수',
        points: ['{변수}로 입력 주입', '시스템 프롬프트와 사용자 입력 분리', '출력 형식(JSON) 강제하기', '프롬프트 버전 관리'],
        refs: ['https://docs.langflow.org/components-prompts'],
      },
      {
        id: 'lf-05',
        title: 'RAG: 내 문서로 답하게 하기',
        points: ['문서 로드 → 분할 → 임베딩 → 벡터스토어', '검색 결과를 프롬프트에 넣는 구조', '청크 크기와 검색 개수의 트레이드오프', '환각을 줄이는 요령'],
        refs: ['https://docs.langflow.org/chat-with-rag'],
      },
      {
        id: 'lf-06',
        title: '에이전트와 도구(Tool) 연결',
        points: ['에이전트가 도구를 고르는 방식', '컴포넌트를 도구로 노출하기', '도구 설명이 성능을 좌우하는 이유', '무한 루프·비용 폭주 막기'],
        refs: ['https://docs.langflow.org/agents', 'https://docs.langflow.org/agents-tools'],
      },
      {
        id: 'lf-07',
        title: 'API로 플로우 호출: 앱에 붙이기',
        points: ['플로우 실행 API와 엔드포인트', 'API 키 인증', 'tweaks로 실행 시 설정 바꾸기', '백엔드(Node/Lambda)에서 호출하는 구조'],
        refs: ['https://docs.langflow.org/concepts-publish', 'https://docs.langflow.org/api-flows-run'],
      },
      {
        id: 'lf-08',
        title: '커스텀 컴포넌트(Python)',
        points: ['기본 컴포넌트로 안 될 때', 'Component 클래스·입력·출력 정의', '외부 API 감싸기', '테스트와 재사용'],
        refs: ['https://docs.langflow.org/components-custom-components'],
      },
      {
        id: 'lf-09',
        title: '배포와 운영: Docker에서 쿠버네티스까지',
        points: ['Docker로 띄우기', '외부 DB(PostgreSQL) 연결', '쿠버네티스 배포 구성', '운영 시 보안·비용 체크리스트'],
        refs: ['https://docs.langflow.org/deployment-docker', 'https://docs.langflow.org/deployment-kubernetes-prod'],
      },
    ],
  },
  {
    id: 'react',
    name: 'React · 프론트엔드',
    area: 'frontend',
    emoji: '⚛️',
    keywords: ['react', 'frontend', '프론트엔드', 'next.js', 'nextjs', 'vite', 'css', 'browser', '브라우저', 'web'],
    lessons: [
      {
        id: 'fe-01',
        title: '브라우저는 페이지를 어떻게 그리나',
        points: ['HTML → DOM, CSS → CSSOM, 렌더 트리', '레이아웃과 페인트', 'JS가 렌더링을 막는 경우', 'SPA가 등장한 이유'],
        refs: ['https://developer.mozilla.org/en-US/docs/Web/Performance/Guides/How_browsers_work'],
      },
      {
        id: 'fe-02',
        title: '컴포넌트와 JSX',
        points: ['UI를 컴포넌트로 쪼개는 기준', 'JSX 규칙', '조건부 렌더링과 리스트(key)', '컴포넌트는 순수 함수처럼'],
        refs: ['https://react.dev/learn/your-first-component', 'https://react.dev/learn/rendering-lists'],
      },
      {
        id: 'fe-03',
        title: 'props와 state',
        points: ['props는 읽기 전용 입력', 'useState와 리렌더링', 'state 업데이트는 비동기·스냅샷', '불변성 유지(객체·배열 복사)'],
        refs: ['https://react.dev/learn/passing-props-to-a-component', 'https://react.dev/learn/state-a-components-memory'],
      },
      {
        id: 'fe-04',
        title: '이벤트와 폼',
        points: ['이벤트 핸들러 전달', '제어 컴포넌트(controlled input)', '폼 제출과 검증', '이벤트 전파'],
        refs: ['https://react.dev/learn/responding-to-events', 'https://react.dev/reference/react-dom/components/input'],
      },
      {
        id: 'fe-05',
        title: 'useEffect와 데이터 페칭',
        points: ['Effect는 외부 시스템과의 동기화', '의존성 배열', '정리(cleanup) 함수', 'Effect가 필요 없는 경우'],
        refs: ['https://react.dev/learn/synchronizing-with-effects', 'https://react.dev/learn/you-might-not-need-an-effect'],
      },
      {
        id: 'fe-06',
        title: '상태 구조화와 공유',
        points: ['중복·파생 state 줄이기', '상태 끌어올리기', 'Context로 깊게 전달하기', '서버 상태와 클라이언트 상태 구분'],
        refs: ['https://react.dev/learn/choosing-the-state-structure', 'https://react.dev/learn/sharing-state-between-components'],
      },
      {
        id: 'fe-07',
        title: 'TypeScript로 React 쓰기',
        points: ['props 타입 정의', 'useState 제네릭', '이벤트 타입', 'API 응답 타입을 경계에서 검증하기'],
        refs: ['https://react.dev/learn/typescript'],
      },
      {
        id: 'fe-08',
        title: '빌드 도구와 프레임워크: Vite, Next.js',
        points: ['번들러가 하는 일', 'Vite 개발 서버와 빌드', 'CSR / SSR / SSG 차이', 'Next.js App Router 개념'],
        refs: ['https://vite.dev/guide/', 'https://nextjs.org/docs'],
      },
      {
        id: 'fe-09',
        title: '프론트엔드 배포: S3 + CloudFront',
        points: ['정적 빌드 결과물 배포', 'CloudFront 캐시와 무효화', 'SPA 라우팅 404 처리', 'CI/CD로 배포 자동화 연결'],
        refs: ['https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/GettingStarted.SimpleDistribution.html'],
      },
    ],
  },
];
