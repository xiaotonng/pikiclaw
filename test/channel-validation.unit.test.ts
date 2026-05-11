/**
 * Unit tests for the new channel credential validators (Slack / Discord /
 * DingTalk / WeChat Work). Each test stubs global fetch with a deterministic
 * response and asserts the resulting ChannelSetupState.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  validateDingtalkConfig,
  validateDiscordConfig,
  validateSlackConfig,
  validateWecomConfig,
} from '../src/core/config/validation.ts';

interface FetchStub {
  url: string;
  response: () => any;
  status?: number;
}

let stubs: FetchStub[] = [];

function setFetchStubs(next: FetchStub[]) {
  stubs = next;
  global.fetch = vi.fn(async (input: any) => {
    const url = String(input);
    const stub = stubs.find(s => url.includes(s.url));
    if (!stub) {
      return new Response(JSON.stringify({}), { status: 404 });
    }
    return new Response(JSON.stringify(stub.response()), { status: stub.status ?? 200 });
  }) as any;
}

beforeEach(() => {
  stubs = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('validateSlackConfig', () => {
  it('reports missing when neither token is set', async () => {
    const r = await validateSlackConfig('', '');
    expect(r.state.status).toBe('missing');
  });

  it('reports invalid when only one token is set', async () => {
    const r = await validateSlackConfig('xoxb-only', '');
    expect(r.state.status).toBe('invalid');
  });

  it('reports invalid when bot token format is wrong', async () => {
    const r = await validateSlackConfig('not-xoxb', 'xapp-foo');
    expect(r.state.status).toBe('invalid');
    expect(r.state.detail).toMatch(/xoxb-/);
  });

  it('reports ready when slack auth.test returns ok', async () => {
    setFetchStubs([{ url: 'slack.com/api/auth.test', response: () => ({ ok: true, user_id: 'U1', user: 'pikiclaw', team: 'TestTeam' }) }]);
    const r = await validateSlackConfig('xoxb-test', 'xapp-test');
    expect(r.state.status).toBe('ready');
    expect(r.bot?.userId).toBe('U1');
  });

  it('reports invalid when slack auth.test returns ok=false', async () => {
    setFetchStubs([{ url: 'slack.com/api/auth.test', response: () => ({ ok: false, error: 'invalid_auth' }) }]);
    const r = await validateSlackConfig('xoxb-test', 'xapp-test');
    expect(r.state.status).toBe('invalid');
    expect(r.state.detail).toMatch(/invalid_auth/);
  });
});

describe('validateDiscordConfig', () => {
  it('reports missing when token absent', async () => {
    const r = await validateDiscordConfig('');
    expect(r.state.status).toBe('missing');
  });

  it('reports ready when discord users/@me returns 200', async () => {
    setFetchStubs([{
      url: 'discord.com/api/v10/users/@me',
      response: () => ({ id: '1234567890', username: 'pikiclaw', application_id: 'APP1' }),
    }]);
    const r = await validateDiscordConfig('Bot-Token');
    expect(r.state.status).toBe('ready');
    expect(r.bot?.username).toBe('pikiclaw');
  });

  it('reports invalid on unauthorized', async () => {
    setFetchStubs([{
      url: 'discord.com/api/v10/users/@me',
      status: 401,
      response: () => ({ message: '401: Unauthorized' }),
    }]);
    const r = await validateDiscordConfig('Bot-Token');
    expect(r.state.status).toBe('invalid');
    expect(r.state.detail).toMatch(/401/);
  });
});

describe('validateDingtalkConfig', () => {
  it('reports missing when nothing set', async () => {
    const r = await validateDingtalkConfig('', '');
    expect(r.state.status).toBe('missing');
  });

  it('reports invalid when one of two is missing', async () => {
    const r = await validateDingtalkConfig('appkey-only', '');
    expect(r.state.status).toBe('invalid');
  });

  it('reports ready when gettoken returns access_token', async () => {
    setFetchStubs([{ url: 'oapi.dingtalk.com/gettoken', response: () => ({ errcode: 0, access_token: 'tok-abc', expires_in: 7200 }) }]);
    const r = await validateDingtalkConfig('appkey', 'appsecret');
    expect(r.state.status).toBe('ready');
    expect(r.app?.clientId).toBe('appkey');
  });

  it('reports invalid when gettoken errors', async () => {
    setFetchStubs([{ url: 'oapi.dingtalk.com/gettoken', response: () => ({ errcode: 40001, errmsg: 'invalid credentials' }) }]);
    const r = await validateDingtalkConfig('appkey', 'badsecret');
    expect(r.state.status).toBe('invalid');
    expect(r.state.detail).toMatch(/invalid credentials/);
  });
});

describe('validateWecomConfig', () => {
  it('reports missing when neither field set', async () => {
    const r = await validateWecomConfig('', '');
    expect(r.state.status).toBe('missing');
  });

  it('reports invalid when only one field set', async () => {
    const r = await validateWecomConfig('only-bot-id', '');
    expect(r.state.status).toBe('invalid');
  });

  it('reports ready when both fields are present (real auth happens at WS subscribe)', async () => {
    const r = await validateWecomConfig('bot-id', 'bot-secret');
    expect(r.state.status).toBe('ready');
    expect(r.bot?.botId).toBe('bot-id');
  });
});
