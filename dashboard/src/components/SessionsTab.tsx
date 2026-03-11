import { useEffect } from 'react';
import { useStore } from '../store';
import { createT } from '../i18n';
import { SectionLabel, Dot, Badge } from './ui';
import { fmtTime } from '../utils';
import type { AgentInfo, SessionInfo } from '../types';

const agentMeta: Record<string, { label: string; color: string; bg: string; letter: string; border: string; glow: string }> = {
  claude: { label: 'Claude Code', color: '#818cf8', bg: 'rgba(129,140,248,0.08)', letter: 'C', border: 'rgba(129,140,248,0.12)', glow: 'rgba(129,140,248,0.06)' },
  codex: { label: 'Codex', color: '#34d399', bg: 'rgba(52,211,153,0.08)', letter: 'O', border: 'rgba(52,211,153,0.12)', glow: 'rgba(52,211,153,0.06)' },
  gemini: { label: 'Gemini CLI', color: '#a78bfa', bg: 'rgba(167,139,250,0.08)', letter: 'G', border: 'rgba(167,139,250,0.12)', glow: 'rgba(167,139,250,0.06)' },
};

function SessionCard({ session, onOpen }: { session: SessionInfo; onOpen: () => void }) {
  const sid = session.localSessionId || session.sessionId || '';
  const title = session.title || sid.slice(0, 16) || 'Session';
  const truncTitle = title.length > 28 ? title.slice(0, 28) + '...' : title;

  return (
    <div
      onClick={onOpen}
      className="p-3 px-3.5 rounded-xl bg-panel-alt border border-edge cursor-pointer transition-all duration-200 mb-1.5 last:mb-0 backdrop-blur-lg hover:border-indigo-500/20 hover:bg-panel hover:shadow-[0_4px_16px_var(--th-glow-b)] hover:-translate-y-px"
      title={title}
    >
      <div className="flex items-center gap-2 mb-1">
        <div className="text-xs font-medium text-fg-2 truncate flex-1">{truncTitle}</div>
        {session.running ? <Dot variant="ok" pulse /> : <Dot />}
      </div>
      <div className="flex items-center gap-3 text-[10px] text-fg-5">
        <span>{fmtTime(session.createdAt)}</span>
        {session.model && <span className="font-mono">{session.model}</span>}
        {session.running && <Badge variant="ok" className="!text-[9px] !py-0 !px-1.5">LIVE</Badge>}
      </div>
      <div className="text-[10px] font-mono text-fg-6 mt-1 truncate">{sid}</div>
    </div>
  );
}

function SwimLanes({ onOpenSession }: { onOpenSession: (agent: string, sid: string, ses: SessionInfo) => void }) {
  const { state, allSessions, locale } = useStore();
  const t = createT(locale);
  const agents = (state?.setupState?.agents || []).filter((a: AgentInfo) => a.installed);

  if (!agents.length) return <div className="text-[13px] text-fg-5 py-8">{t('sessions.noAgent')}</div>;

  return (
    <div className="flex gap-4 overflow-x-auto pb-2" style={{ minHeight: 200 }}>
      {agents.map((a: AgentInfo) => {
        const m = agentMeta[a.agent] || { label: a.agent, color: '#888', bg: 'rgba(128,128,128,0.08)', letter: '?', border: 'var(--th-edge)', glow: 'var(--th-glow-b)' };
        const sessions = ((allSessions[a.agent] as { sessions?: SessionInfo[] })?.sessions || []) as SessionInfo[];
        return (
          <div key={a.agent} className="flex-1 min-w-[260px] max-w-[340px] flex flex-col">
            <div className="flex items-center gap-2 px-3.5 py-3 rounded-t-[14px] bg-panel border border-b-0 backdrop-blur-lg text-[13px] font-semibold text-fg-2" style={{ borderColor: m.border }}>
              <div className="w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold" style={{ background: m.bg, color: m.color, boxShadow: `0 0 10px ${m.glow}` }}>{m.letter}</div>
              <span>{m.label}</span>
              <Badge variant="muted" className="ml-auto !text-[10px]">{sessions.length}</Badge>
            </div>
            <div className="flex-1 border border-t-0 rounded-b-[14px] bg-panel-alt p-2 overflow-y-auto max-h-[60vh] backdrop-blur-lg" style={{ borderColor: m.border }}>
              {sessions.length === 0
                ? <div className="text-xs text-fg-5 text-center py-6">{t('sessions.noSessions')}</div>
                : sessions.map((s: SessionInfo) => (
                    <SessionCard
                      key={s.sessionId || s.localSessionId}
                      session={s}
                      onOpen={() => onOpenSession(a.agent, s.localSessionId || s.sessionId || '', s)}
                    />
                  ))
              }
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function SessionsTab({ onOpenSession }: { onOpenSession: (agent: string, sid: string, ses: SessionInfo) => void }) {
  const { loadSessions, locale } = useStore();
  const t = createT(locale);

  useEffect(() => { loadSessions(); }, [loadSessions]);

  return (
    <div className="animate-in space-y-6">
      <section>
        <SectionLabel>{t('sessions.agentSessions')}</SectionLabel>
        <SwimLanes onOpenSession={onOpenSession} />
      </section>
    </div>
  );
}
