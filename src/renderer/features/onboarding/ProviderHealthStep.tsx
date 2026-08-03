import React from "react";
import type { ProviderHealth, ProviderId } from "../../../shared/contracts/provider";
import { ProviderHealthCard } from "./ProviderHealthCard";

export function ProviderHealthStep(props: {
  health: readonly ProviderHealth[];
  onPick(provider: ProviderId): void;
  onRefresh(): void;
}): React.JSX.Element {
  return <section className="onboarding" aria-labelledby="provider-health-title">
    <header className="onboarding-intro">
      <p className="onboarding-eyebrow"><span aria-hidden="true">●</span> 本機優先</p>
      <h2 id="provider-health-title">連接你的程式代理</h2>
      <p className="onboarding-lede">所有歷程與 Git 結果都留在這台 Mac。你保有程式碼、分支與每一次核准的控制權。</p>
      <div className="privacy-note">
        <span className="privacy-icon" aria-hidden="true">⌂</span>
        <p>代理執行時，只會把執行所需的內容送給你選擇的服務。Branchestra 不會儲存或顯示登入憑證。</p>
      </div>
    </header>
    {props.health.length > 0 ? (
      <div className="provider-grid">{props.health.map((item) => (
        <ProviderHealthCard key={item.provider} health={item} onPick={props.onPick} />
      ))}</div>
    ) : (
      <div className="provider-pending" role="status">
        <span aria-hidden="true">↻</span>
        <div><strong>正在檢查本機代理</strong><p>確認官方 CLI 與訂閱登入狀態。</p></div>
      </div>
    )}
    <footer className="onboarding-footer">
      <p>CLI 需另外安裝，Branchestra 不會內附代理執行檔。</p>
      <button className="quiet-button" type="button" onClick={props.onRefresh}>重新檢查</button>
    </footer>
  </section>;
}
