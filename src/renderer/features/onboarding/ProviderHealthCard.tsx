import React from "react";
import type { ProviderHealth, ProviderId } from "../../../shared/contracts/provider";
import { PROVIDER_STATE_LABEL, providerGuidance } from "../../locale/zh-TW";

export function ProviderHealthCard(props: { health: ProviderHealth; onPick(provider: ProviderId): void }): React.JSX.Element {
  const name = props.health.provider === "claude" ? "Claude" : "Codex";
  const guidance = providerGuidance(props.health);
  return <section className="provider-card" aria-label={`${name} 狀態`}>
    <header>
      <span className={`provider-monogram provider-${props.health.provider}`} aria-hidden="true">
        {props.health.provider === "claude" ? "C" : "X"}
      </span>
      <div><h3>{name}</h3><p>僅限訂閱帳號</p></div>
      <span className={`status-pill status-${props.health.state}`}>{PROVIDER_STATE_LABEL[props.health.state]}</span>
    </header>
    <dl className="provider-facts">
      <div><dt>CLI</dt><dd className="path-value">{props.health.executableRealpath ?? "尚未找到"}</dd></div>
      <div><dt>版本</dt><dd>{props.health.cliVersion ?? "無法取得"}</dd></div>
    </dl>
    {guidance ? <p className="provider-guidance" role="status">{guidance}</p> : null}
    {props.health.state === "ready"
      ? <p className="provider-guidance" role="status">已自動連接，不需手動選擇。</p>
      : <button type="button" onClick={() => props.onPick(props.health.provider)}>選擇 {name} CLI</button>}
  </section>;
}
