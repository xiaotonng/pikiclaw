import axios from 'axios';
import http from 'node:http';
import https from 'node:https';
import { Agent as UndiciAgent } from 'undici';

const DIRECT_HTTP_AGENT = new http.Agent({ keepAlive: true });
const DIRECT_HTTPS_AGENT = new https.Agent({ keepAlive: true });
const DIRECT_UNDICI_AGENT = new UndiciAgent();

function envValue(name: string): string | null {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  return raw ? raw : null;
}

function envFlag(name: string): boolean | null {
  const raw = envValue(name);
  if (!raw) return null;
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true;
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
  return null;
}

export function feishuNoProxyEnabled(): boolean {
  const useProxy = envFlag('FEISHU_USE_PROXY');
  if (useProxy === true) return false;

  const noProxy = envFlag('FEISHU_NO_PROXY');
  if (noProxy !== null) return noProxy;

  return true;
}

export function feishuApiDomain(): string {
  return String(process.env.FEISHU_DOMAIN || 'https://open.feishu.cn').trim().replace(/\/+$/, '');
}

export function withFeishuDirectFetch(init: RequestInit): RequestInit {
  if (!feishuNoProxyEnabled()) return init;
  return { ...init, dispatcher: DIRECT_UNDICI_AGENT } as RequestInit;
}

export function createFeishuHttpInstance() {
  if (!feishuNoProxyEnabled()) return null;
  return axios.create({
    proxy: false,
    httpAgent: DIRECT_HTTP_AGENT,
    httpsAgent: DIRECT_HTTPS_AGENT,
  });
}

export function createFeishuWsAgent() {
  return feishuNoProxyEnabled() ? DIRECT_HTTPS_AGENT : undefined;
}
