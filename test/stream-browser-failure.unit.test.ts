import { describe, expect, it } from 'vitest';
import { _detectBrowserMcpFailure } from '../src/agent/stream.ts';

describe('_detectBrowserMcpFailure', () => {
  it('flags playwright Frame detached errors', () => {
    const line = '{"type":"user","message":{"content":[{"type":"tool_result","content":"### Error\\nError: browserBackend.callTool: Frame has been detached.\\n"}]}}';
    expect(_detectBrowserMcpFailure(line)).toBe('playwright Frame detached');
  });

  it('flags pikiclaw-browser MCP stdio close', () => {
    const line = '{"type":"user","message":{"content":[{"type":"tool_result","content":"mcp__pikiclaw-browser__browser_navigate: http://x failed: MCP error -32000: Connection closed"}]}}';
    expect(_detectBrowserMcpFailure(line)).toBe('pikiclaw-browser MCP stdio closed');
  });

  it('does not fire on Connection closed from unrelated MCP servers', () => {
    const line = '{"type":"user","message":{"content":[{"type":"tool_result","content":"mcp__atlassian__search failed: MCP error -32000: Connection closed"}]}}';
    expect(_detectBrowserMcpFailure(line)).toBeNull();
  });

  it('does not fire on benign stream chunks', () => {
    expect(_detectBrowserMcpFailure('{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}')).toBeNull();
    expect(_detectBrowserMcpFailure('')).toBeNull();
  });
});
