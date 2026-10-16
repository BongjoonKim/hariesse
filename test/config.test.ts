// SSM GetParameters는 1회 최대 10개 — 설정 키가 늘어도 나눠 조회하는지 검증.
const send = jest.fn(async (cmd: { input: { Names: string[] } }) => {
  const names = cmd.input.Names;
  if (names.length > 10) throw new Error(`ValidationException: ${names.length} names`);
  return { Parameters: names.map((Name) => ({ Name, Value: Name.endsWith('/telegram-chat-id') ? '123' : undefined })) };
});

jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({ send })),
  GetParametersCommand: jest.fn((input) => ({ input })),
}));
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: jest.fn() })),
  GetSecretValueCommand: jest.fn(),
}));

describe('getConfig', () => {
  beforeAll(() => {
    process.env.SOURCES_TABLE = 's';
    process.env.ARTICLES_TABLE = 'a';
    process.env.PROFILE_TABLE = 'p';
    process.env.RAW_BUCKET = 'b';
  });

  it('SSM 이름이 10개를 넘으면 나눠서 조회한다', async () => {
    const { getConfig } = await import('../src/lib/config');
    const cfg = await getConfig();
    expect(cfg.telegramChatId).toBe('123');
    expect(send.mock.calls.length).toBeGreaterThan(1);
    for (const [cmd] of send.mock.calls) expect(cmd.input.Names.length).toBeLessThanOrEqual(10);
  });
});
