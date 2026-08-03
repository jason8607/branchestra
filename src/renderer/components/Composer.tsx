import React, { useLayoutEffect, useRef, useState } from "react";

type AgentId = "claude" | "codex";

interface AgentOption {
  id: AgentId;
  label: "Claude" | "Codex";
  description: string;
}

interface MentionQuery {
  start: number;
  end: number;
  query: string;
}

const AGENTS: AgentOption[] = [
  { id: "claude", label: "Claude", description: "規劃、實作與修訂" },
  { id: "codex", label: "Codex", description: "程式審查與驗證" }
];

function findMentionQuery(value: string, caret: number): MentionQuery | null {
  const beforeCaret = value.slice(0, caret);
  const match = beforeCaret.match(/(?:^|[\s([{])[@＠]([\p{L}\p{N}_-]*)$/u);
  if (!match) return null;
  const tokenLength = match[1]!.length + 1;
  return {
    start: beforeCaret.length - tokenLength,
    end: caret,
    query: match[1]!.toLowerCase()
  };
}

function MentionHighlights(props: { body: string }): React.JSX.Element {
  const parts: React.ReactNode[] = [];
  const mentions = props.body.matchAll(/[@＠](Claude|Codex)\b/giu);
  let cursor = 0;

  for (const mention of mentions) {
    const index = mention.index;
    if (index > cursor) parts.push(props.body.slice(cursor, index));
    const label = mention[1]!;
    const agent = label.toLowerCase() as AgentId;
    parts.push(
      <span
        className={`mention-token mention-token--${agent}`}
        data-testid={`mention-${agent}`}
        key={`${index}-${agent}`}
      >
        @{label}
      </span>
    );
    cursor = index + mention[0].length;
  }

  if (cursor < props.body.length) parts.push(props.body.slice(cursor));
  return <>{parts}</>;
}

export function Composer(props: {
  disabled: boolean;
  onSend(body: string): Promise<void>;
}): React.JSX.Element {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mentionQuery, setMentionQuery] = useState<MentionQuery | null>(null);
  const [activeAgentIndex, setActiveAgentIndex] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const highlightsRef = useRef<HTMLDivElement>(null);
  const pendingCaretRef = useRef<number | null>(null);
  const cannotSend = props.disabled || sending || body.trim().length === 0;
  const matchingAgents = mentionQuery
    ? AGENTS.filter((agent) => agent.label.toLowerCase().startsWith(mentionQuery.query))
    : [];
  const mentionMenuOpen = matchingAgents.length > 0;

  useLayoutEffect(() => {
    if (pendingCaretRef.current === null) return;
    const nextCaret = pendingCaretRef.current;
    pendingCaretRef.current = null;
    inputRef.current?.focus();
    inputRef.current?.setSelectionRange(nextCaret, nextCaret);
  }, [body]);

  function updateMentionQuery(value: string, caret: number): void {
    setMentionQuery(findMentionQuery(value, caret));
    setActiveAgentIndex(0);
  }

  function selectAgent(agent: AgentOption): void {
    if (!mentionQuery) return;
    const replacement = `@${agent.label} `;
    const nextBody = body.slice(0, mentionQuery.start) + replacement + body.slice(mentionQuery.end);
    const nextCaret = mentionQuery.start + replacement.length;
    pendingCaretRef.current = nextCaret;
    setBody(nextBody);
    setMentionQuery(null);
  }

  function syncHighlightScroll(textarea: HTMLTextAreaElement): void {
    if (!highlightsRef.current) return;
    highlightsRef.current.scrollTop = textarea.scrollTop;
    highlightsRef.current.scrollLeft = textarea.scrollLeft;
  }

  async function send(): Promise<void> {
    if (cannotSend) return;
    const submittedBody = body;
    setSending(true);
    setError(null);
    setMentionQuery(null);
    try {
      await props.onSend(submittedBody);
      setBody((currentBody) => currentBody === submittedBody ? "" : currentBody);
    } catch {
      setError("訊息未送出，請再試一次。");
    } finally {
      setSending(false);
    }
  }

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <label htmlFor="message-input">訊息</label>
      <div className="composer-editor">
        <div ref={highlightsRef} className="composer-highlights" aria-hidden="true">
          <MentionHighlights body={body} />
        </div>
        <textarea
          ref={inputRef}
          id="message-input"
          data-testid="message-input"
          value={body}
          disabled={props.disabled}
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-controls={mentionMenuOpen ? "agent-mention-menu" : undefined}
          aria-expanded={mentionMenuOpen}
          aria-activedescendant={mentionMenuOpen ? `agent-mention-${matchingAgents[activeAgentIndex]!.id}` : undefined}
          onChange={(event) => {
            const textarea = event.currentTarget;
            setBody(textarea.value);
            updateMentionQuery(textarea.value, textarea.selectionStart);
          }}
          onClick={(event) => updateMentionQuery(event.currentTarget.value, event.currentTarget.selectionStart)}
          onBlur={() => setMentionQuery(null)}
          onKeyDown={(event) => {
            if (!mentionMenuOpen) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const direction = event.key === "ArrowDown" ? 1 : -1;
              setActiveAgentIndex((current) => (
                current + direction + matchingAgents.length
              ) % matchingAgents.length);
              return;
            }
            if (event.key === "Enter" || event.key === "Tab") {
              event.preventDefault();
              selectAgent(matchingAgents[activeAgentIndex]!);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setMentionQuery(null);
            }
          }}
          onScroll={(event) => syncHighlightScroll(event.currentTarget)}
          placeholder={props.disabled ? "選擇一個已連線的房間後即可輸入" : "輸入 @，選擇 Claude 或 Codex"}
          rows={3}
        />
        {mentionMenuOpen ? (
          <div id="agent-mention-menu" className="mention-menu" role="listbox" aria-label="選擇代理">
            <p className="mention-menu__label">指派代理</p>
            {matchingAgents.map((agent, index) => (
              <button
                id={`agent-mention-${agent.id}`}
                className={`mention-option mention-option--${agent.id}`}
                type="button"
                role="option"
                aria-selected={index === activeAgentIndex}
                key={agent.id}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => selectAgent(agent)}
              >
                <span className="mention-option__mark" aria-hidden="true">@</span>
                <span className="mention-option__copy">
                  <strong>{agent.label}</strong>
                  <small>{agent.description}</small>
                </span>
                <span className="mention-option__enter" aria-hidden="true">↵</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div className="composer-actions">
        {error ? <p className="form-error" role="alert">{error}</p> : <span />}
        <button type="submit" data-testid="send-message" disabled={cannotSend}>
          {sending ? "傳送中…" : "傳送訊息"}
        </button>
      </div>
    </form>
  );
}
