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
      setError("Message was not sent. Try again.");
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
      <label htmlFor="message-input">Message</label>
      <textarea
        id="message-input"
        data-testid="message-input"
        value={body}
        disabled={props.disabled}
        onChange={(event) => setBody(event.currentTarget.value)}
        placeholder={props.disabled ? "Select a connected room to write" : "Write a local message"}
        rows={3}
      />
      <div className="composer-actions">
        {error ? <p className="form-error" role="alert">{error}</p> : <span />}
        <button type="submit" data-testid="send-message" disabled={cannotSend}>
          {sending ? "Sending…" : "Send message"}
        </button>
      </div>
    </form>
  );
}
