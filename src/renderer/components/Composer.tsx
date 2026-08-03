import React, { useState } from "react";

export function Composer(props: {
  disabled: boolean;
  onSend(body: string): Promise<void>;
}): React.JSX.Element {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cannotSend = props.disabled || sending || body.trim().length === 0;

  async function send(): Promise<void> {
    if (cannotSend) return;
    const submittedBody = body;
    setSending(true);
    setError(null);
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
      <textarea
        id="message-input"
        data-testid="message-input"
        value={body}
        disabled={props.disabled}
        onChange={(event) => setBody(event.currentTarget.value)}
        placeholder={props.disabled ? "選擇一個已連線的房間後即可輸入" : "輸入訊息，或用 @Claude、@Codex 建立任務"}
        rows={3}
      />
      <div className="composer-actions">
        {error ? <p className="form-error" role="alert">{error}</p> : <span />}
        <button type="submit" data-testid="send-message" disabled={cannotSend}>
          {sending ? "傳送中…" : "傳送訊息"}
        </button>
      </div>
    </form>
  );
}
