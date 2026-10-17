import { useEffect, useRef, useState } from "react";
import {
  request,
  getConfig,
  openExternal,
  formatServiceError,
} from "./platform";
import { parseProject } from "./project";
import type { Editor } from "./engine";
import {
  priceLabel,
  usageLabel,
  tokenSpanProps,
  type ModelPrice,
  type UsageReceipt,
} from "./usage";
import { formatCompactTokens, formatExactTokens } from "./tokens";

export type Grants = { sync: boolean; ai: boolean; bot: boolean };
export type Session = {
  token: string;
  name: string;
  user_id?: string;
  auth_channel?: string;
  account_id?: string;
  grants: Grants;
};
export type ModelItem = {
  id: string;
  model_id: string;
  display_name: string;
  region: string;
};

// Session stays in memory; no service credential enters a project,
// localStorage, recovery record, or native installation package.
let session: Session | null = null;
let cloudETag: string | null = null;
let pending: string | null = null;

export function getActiveSession(): Session | null {
  return session;
}

export function Connections({
  editor,
  adopt,
  close,
  message,
  openSupport,
}: {
  editor: Editor;
  adopt: (content: string) => Promise<boolean>;
  close: () => void;
  message: (value: string, error?: boolean) => void;
  openSupport?: () => void;
}) {
  const [config, setConfig] = useState<Record<string, string>>({});
  const [current, setCurrent] = useState(session);
  const [waiting, setWaiting] = useState(!!pending);
  const [busy, setBusy] = useState(false);
  const [channels, setChannels] = useState<string[]>(["local", "chat"]);
  const [unavailable, setUnavailable] = useState<Array<{ channel: string; reason: string }>>([
    { channel: "verification_code", reason: "真实短信或邮件通道尚未配置，暂未启用" },
    { channel: "wechat", reason: "真实发送或第三方身份校验尚未接入，暂未启用" },
    { channel: "alipay", reason: "真实发送或第三方身份校验尚未接入，暂未启用" },
    { channel: "douyin", reason: "真实发送或第三方身份校验尚未接入，暂未启用" },
    { channel: "baidu", reason: "真实发送或第三方身份校验尚未接入，暂未启用" },
  ]);
  const [authChannel, setAuthChannel] = useState<
    | "chat"
    | "local"
    | "verification_code"
    | "wechat"
    | "alipay"
    | "douyin"
    | "baidu"
  >("chat");
  const [otpChannel, setOtpChannel] = useState<"email" | "phone">("email");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [prompt, setPrompt] = useState("");
  const [answer, setAnswer] = useState("");
  const [botToken, setBotToken] = useState("");
  const [models, setModels] = useState<(ModelItem & ModelPrice)[]>([]);
  const [usage, setUsage] = useState<UsageReceipt[]>([]);
  const [bindings, setBindings] = useState<Array<{ provider: string; provider_uid: string }>>([]);
  const [balance, setBalance] = useState<{
    remaining_tokens: number;
    package_name: string;
    expires_at: number | null;
  } | null>(null);
  const [packages, setPackages] = useState<Array<{ package_id: string; name: string; tokens: number; kind: string }>>([]);
  const [ledger, setLedger] = useState<Array<{ entry_id: string; type: string; tokens: number; balance_after: number }>>([]);
  const [deletionNotice, setDeletionNotice] = useState<string[]>([]);
  const [ackDelete, setAckDelete] = useState(false);
  const [reauthToken, setReauthToken] = useState("");
  const aiRequest = useRef<{ prompt: string; model: string; id: string } | null>(null);
  const mounted = useRef(true);
  const operation = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (error) {
      message(formatServiceError((error as Error).message), true);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  useEffect(() => {
    mounted.current = true;
    void getConfig()
      .then((loaded) => {
        if (!mounted.current) return;
        setConfig(loaded);
      })
      .catch((e) => message(formatServiceError(e.message), true));
    void request("auth/channels", "GET")
      .then((result) => {
        if (!mounted.current) return;
        setChannels(result.channels ?? ["local", "chat"]);
        const nextUnavailable = Array.isArray(result.unavailable)
          ? result.unavailable
          : [];
        // Keep known offline-unavailable channels visible when the service omits them.
        const known = new Set(nextUnavailable.map((item: { channel: string }) => item.channel));
        const defaults = [
          "verification_code",
          "wechat",
          "alipay",
          "douyin",
          "baidu",
        ].filter((channel) => !(result.channels ?? []).includes(channel) && !known.has(channel));
        setUnavailable([
          ...nextUnavailable,
          ...defaults.map((channel) => ({
            channel,
            reason: "真实发送或第三方身份校验尚未接入，暂未启用",
          })),
        ]);
      })
      .catch(() => {});
    return () => {
      mounted.current = false;
    };
  }, [message]);
  useEffect(() => {
    if (!waiting) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await request("auth/poll", "POST", {
          requestId: pending,
          request_id: pending,
        });
        if (cancelled) return;
        if (result.session) {
          session = result.session;
          pending = null;
          cloudETag = null;
          setCurrent(session);
          setWaiting(false);
        } else timer = setTimeout(poll, 2000);
      } catch (error) {
        if (!cancelled) {
          setWaiting(false);
          message(formatServiceError((error as Error).message), true);
        }
      }
    };
    timer = setTimeout(poll, 1500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [waiting, message]);
  useEffect(() => {
    if (!current) {
      setModels([]);
      setUsage([]);
      setBindings([]);
      setBalance(null);
      setPackages([]);
      setLedger([]);
      return;
    }
    let cancelled = false;
    const load = async () => {
      const records = await request("ai/usage", "GET", undefined, current.token);
      if (!cancelled) setUsage(records.data);
      if (current.grants.ai) {
        const catalog = await request("ai/models", "GET", undefined, current.token);
        if (!cancelled) {
          setModels(catalog.models);
          setSelectedModel((selected) =>
            catalog.models.some((model: ModelItem) => model.model_id === selected)
              ? selected
              : catalog.default_model,
          );
        }
      }
      try {
        const bound = await request("account/bindings", "GET", undefined, current.token);
        if (!cancelled) setBindings(bound.bindings ?? []);
      } catch {
        /* bindings optional for legacy sessions */
      }
      try {
        const bal = await request("billing/balance", "GET", undefined, current.token);
        if (!cancelled) setBalance(bal);
        const pkgs = await request("billing/packages", "GET", undefined, current.token);
        if (!cancelled) setPackages(pkgs.packages ?? []);
        const led = await request("billing/ledger", "GET", undefined, current.token);
        if (!cancelled) setLedger(led.entries ?? []);
      } catch {
        /* billing may be unavailable for sessions without account_id */
      }
      try {
        const notice = await request("account/deletion-notice", "GET", undefined, current.token);
        if (!cancelled) setDeletionNotice(notice.consequences ?? []);
      } catch {
        /* ignore */
      }
    };
    void load().catch(() => {});
    const timer = setInterval(() => void load().catch(() => {}), 60000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [current]);
  const changeGrant = (key: keyof Grants, value: boolean) =>
    void operation(async () => {
      const grants = { ...session!.grants, [key]: value };
      await request("grants", "PUT", grants, session!.token);
      session = { ...session!, grants };
      setCurrent(session);
      if (!value && key === "bot") setBotToken("");
    });
  const adoptSession = (nextSession: Session) => {
    session = nextSession;
    pending = null;
    cloudETag = null;
    setCurrent(nextSession);
    setWaiting(false);
  };
  return (
    <div className="modal-backdrop">
      <section
        className="modal connections"
        role="dialog"
        aria-modal="true"
        aria-label="账户与连接"
      >
        <div className="modal-heading">
          <h2>账户与连接</h2>
          <button onClick={close} disabled={busy}>
            关闭
          </button>
        </div>
        <p>本地编辑和自动恢复始终可离线使用。在线功能由你逐项开启。</p>
        {!current ? (
          <>
            <label className="form-label">
              登录方式
              <select
                aria-label="登录方式"
                value={authChannel}
                disabled={busy || waiting}
                onChange={(e) =>
                  setAuthChannel(e.target.value as typeof authChannel)
                }
              >
                <option value="chat">Chat 授权登录 (PKCE)</option>
                <option value="local">本地账号密码登录 / 注册</option>
                <option
                  value="verification_code"
                  disabled={!channels.includes("verification_code")}
                >
                  {channels.includes("verification_code")
                    ? "手机 / 邮箱验证码登录"
                    : "未启用：手机 / 邮箱验证码登录"}
                </option>
                <option disabled value="wechat">未启用：微信登录 (wechat)</option>
                <option disabled value="alipay">未启用：支付宝登录 (alipay)</option>
                <option disabled value="douyin">未启用：抖音登录 (douyin)</option>
                <option disabled value="baidu">未启用：百度登录 (baidu)</option>
              </select>
            </label>
            {authChannel === "local" && (
              <>
                <label className="form-label">
                  账号（用户名 / 邮箱 / 手机号）
                  <input
                    aria-label="登录账号"
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                  />
                </label>
                <label className="form-label">
                  密码
                  <input
                    aria-label="登录密码"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </label>
                <div className="connection-actions">
                  <button
                    className="primary"
                    disabled={
                      busy ||
                      !config["ecosystem.url"] ||
                      !identifier.trim() ||
                      password.length < 6
                    }
                    onClick={() =>
                      void operation(async () => {
                        const result = await request("auth/login", "POST", {
                          username: identifier.trim(),
                          password,
                        });
                        adoptSession(result.session);
                        message("本地账号登录成功");
                      })
                    }
                  >
                    账号登录
                  </button>
                  <button
                    disabled={
                      busy ||
                      !config["ecosystem.url"] ||
                      !identifier.trim() ||
                      password.length < 6
                    }
                    onClick={() =>
                      void operation(async () => {
                        const result = await request("auth/register", "POST", {
                          username: identifier.trim(),
                          password,
                        });
                        adoptSession(result.session);
                        message("账号注册并登录成功");
                      })
                    }
                  >
                    注册新账号
                  </button>
                </div>
              </>
            )}
            {authChannel === "verification_code" && channels.includes("verification_code") && (
              <>
                <label className="form-label">
                  验证码渠道
                  <select
                    aria-label="验证码渠道"
                    value={otpChannel}
                    disabled={busy}
                    onChange={(e) => setOtpChannel(e.target.value as "email" | "phone")}
                  >
                    <option value="email">邮箱</option>
                    <option value="phone">手机</option>
                  </select>
                </label>
                <label className="form-label">
                  {otpChannel === "email" ? "邮箱" : "手机号"}
                  <input
                    aria-label={otpChannel === "email" ? "登录邮箱" : "登录手机号"}
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                  />
                </label>
                <div className="connection-actions">
                  <button
                    disabled={busy || !config["ecosystem.url"] || !identifier.trim()}
                    onClick={() =>
                      void operation(async () => {
                        const result = await request("auth/code/send", "POST", {
                          channel: otpChannel,
                          target: identifier.trim(),
                          purpose: "login",
                        });
                        setChallengeId(result.challenge_id);
                        setOtpCode("");
                        message(`验证码已发送至 ${result.target_masked}`);
                      })
                    }
                  >
                    发送验证码
                  </button>
                </div>
                <label className="form-label">
                  验证码
                  <input
                    aria-label="登录验证码"
                    value={otpCode}
                    inputMode="numeric"
                    maxLength={6}
                    onChange={(e) => setOtpCode(e.target.value)}
                  />
                </label>
                <button
                  className="primary"
                  disabled={
                    busy ||
                    !config["ecosystem.url"] ||
                    !challengeId ||
                    otpCode.trim().length !== 6
                  }
                  onClick={() =>
                    void operation(async () => {
                      const result = await request("auth/code/login", "POST", {
                        channel: otpChannel,
                        target: identifier.trim(),
                        challenge_id: challengeId,
                        code: otpCode.trim(),
                        purpose: "login",
                      });
                      adoptSession(result.session);
                      setChallengeId("");
                      setOtpCode("");
                      message("验证码登录成功");
                    })
                  }
                >
                  验证码登录
                </button>
              </>
            )}
            <p role="status">
              {unavailable.length
                ? `暂未启用：${unavailable.map((u) => u.channel).join("、")}。可用：${channels.join("、")}。`
                : `可用登录方式：${channels.join("、")}。`}
            </p>
            <button
              className="primary"
              disabled={busy || waiting || !config["ecosystem.url"]}
              onClick={() =>
                void operation(async () => {
                  const result = await request("auth/begin", "POST");
                  pending = result.requestId;
                  try {
                    await openExternal(result.authorizeUrl);
                    setWaiting(true);
                  } catch (e) {
                    await request("auth/cancel", "POST", {
                      requestId: pending,
                    });
                    pending = null;
                    throw e;
                  }
                })
              }
            >
              用 Chat 授权登录
            </button>
            {(waiting || pending) && (
              <button
                disabled={busy}
                onClick={() =>
                  void operation(async () => {
                    await request("auth/cancel", "POST", {
                      requestId: pending,
                    });
                    pending = null;
                    setWaiting(false);
                  })
                }
              >
                取消授权
              </button>
            )}
            {!config["ecosystem.url"] && <p>在线服务尚未开通。</p>}
          </>
        ) : (
          <>
            <p>已登录：{current.name}</p>
            {(["sync", "ai", "bot"] as const).map((key, i) => (
              <label className="grant" key={key}>
                <input
                  type="checkbox"
                  checked={current.grants[key]}
                  disabled={busy}
                  onChange={(event) => changeGrant(key, event.target.checked)}
                />
                {
                  [
                    "账户项目同步",
                    "AI 模型服务建议",
                    "Bot / MCP 项目操作与下载",
                  ][i]
                }
              </label>
            ))}
            <div className="connection-actions">
              <button
                disabled={busy || !current.grants.sync}
                onClick={() =>
                  void operation(async () => {
                    if (cloudETag === null) {
                      const remote = await request(
                        "project",
                        "GET",
                        undefined,
                        current.token,
                      );
                      if (remote.content)
                        throw new Error(
                          "账户已有项目，请先下载云端版本；下载前不会覆盖云端。",
                        );
                      cloudETag = remote.etag;
                    }
                    const result = await request(
                      "project",
                      "PUT",
                      { content: editor.serialize() },
                      current.token,
                      cloudETag!,
                    );
                    cloudETag = result.etag;
                    message("项目已同步到当前账户");
                  })
                }
              >
                上传当前项目
              </button>
              <button
                disabled={busy || !current.grants.sync}
                onClick={() =>
                  void operation(async () => {
                    const result = await request(
                      "project",
                      "GET",
                      undefined,
                      current.token,
                    );
                    if (!result.content) throw new Error("账户尚无同步项目");
                    parseProject(result.content);
                    if (await adopt(result.content)) cloudETag = result.etag;
                  })
                }
              >
                下载云端项目
              </button>
              <button
                disabled={busy || !current.grants.bot}
                onClick={() =>
                  void operation(async () => {
                    const result = await request(
                      "bot/token",
                      "POST",
                      undefined,
                      current.token,
                    );
                    setBotToken(result.token);
                  })
                }
              >
                生成 Bot 授权
              </button>
            </div>
            {botToken && (
              <label className="form-label">
                Bot / MCP 专用令牌（1 小时；关闭 Bot 权限立即撤销）
                <input
                  readOnly
                  value={botToken}
                  onFocus={(e) => e.currentTarget.select()}
                />
              </label>
            )}
            <p>
              Bot / MCP
              支持项目新建、列表、读取、资产导入导出、破坏性编辑预览确认和撤销回滚。撤销同步后云端项目会删除。
            </p>
            {current.grants.ai && <div aria-label="AI 模型价格">
              {models.length ? models.map((model) => <p key={model.id}>
                {priceLabel(model)}
                <br />输入 / 输出每百万 token：{model.input_fen_per_million == null ? "待配置" : model.input_fen_per_million / 100} / {model.output_fen_per_million == null ? "待配置" : model.output_fen_per_million / 100} {model.currency ?? ""}
              </p>) : <p>模型价格待确认</p>}
            </div>}
            <label className="form-label">
              AI 模型选择
              <select
                aria-label="AI 模型选择"
                value={selectedModel}
                disabled={busy || !current.grants.ai}
                onChange={(e) => setSelectedModel(e.target.value)}
              >
                {models.map((item) => (
                  <option
                    key={item.model_id ?? item.id}
                    value={item.model_id ?? item.id}
                  >
                    {item.display_name} ({item.region})
                  </option>
                ))}
              </select>
            </label>
            <label className="form-label">
              AI 建议（只发送输入文字与所选受控模型）
              <textarea
                value={prompt}
                maxLength={4000}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </label>
            <button
              disabled={busy || !current.grants.ai || !selectedModel || !prompt.trim()}
              onClick={() =>
                void operation(async () => {
                  if (aiRequest.current?.prompt !== prompt || aiRequest.current?.model !== selectedModel)
                    aiRequest.current = { prompt, model: selectedModel, id: crypto.randomUUID() };
                  try {
                    const result = await request("ai/text", "POST", { prompt, model: selectedModel, request_id: aiRequest.current.id }, current.token);
                    setAnswer(result.text);
                    aiRequest.current = null;
                  } finally {
                    const records = await request("ai/usage", "GET", undefined, current.token);
                    setUsage(records.data);
                  }
                })
              }
            >
              获取 AI 模型服务建议
            </button>
            <details>
              <summary>用量与实扣（{usage.length} 条）</summary>
              {usage.map((value) => {
                const billed = tokenSpanProps(value.billed_tokens);
                return (
                  <p key={`${value.hub}/${value.request_id}`}>
                    {value.model} · {usageLabel(value)}
                    <br />
                    实扣展示：{" "}
                    <span title={billed.title}>{billed.children}</span>
                    <br />
                    {value.hub} / {value.request_id}
                  </p>
                );
              })}
            </details>
            {answer && (
              <>
                <p className="ai-answer">{answer}</p>
                <button
                  disabled={busy}
                  onClick={() => {
                    try {
                      editor.addText({ x: 40, y: 40 }, answer.slice(0, 10000));
                      message("AI 文字已添加为可撤销图层");
                    } catch (e) {
                      message((e as Error).message, true);
                    }
                  }}
                >
                  添加为文字图层
                </button>
              </>
            )}
            <details open>
              <summary>额度套餐（token）</summary>
              {balance ? (
                <p>
                  当前套餐：{balance.package_name}
                  <br />
                  剩余额度：{" "}
                  <span title={formatExactTokens(balance.remaining_tokens)}>
                    {formatCompactTokens(balance.remaining_tokens)}
                  </span>
                  {balance.expires_at
                    ? ` · 到期 ${new Date(balance.expires_at).toLocaleString()}`
                    : ""}
                </p>
              ) : (
                <p>尚未开通套餐</p>
              )}
              <div className="connection-actions">
                {packages.map((pkg) => (
                  <button
                    key={pkg.package_id}
                    disabled={busy}
                    onClick={() =>
                      void operation(async () => {
                        const order = await request(
                          "billing/orders",
                          "POST",
                          { package_id: pkg.package_id, channel: "mock" },
                          current.token,
                        );
                        message(
                          `已创建订单 ${order.order.out_trade_no}（${pkg.name}）。额度仅在支付回调成功后入账，前端跳转不算入账。`,
                        );
                      })
                    }
                  >
                    {pkg.kind === "topup" ? "加量" : "开通/续费"} {pkg.name}（
                    <span title={formatExactTokens(pkg.tokens)}>
                      {formatCompactTokens(pkg.tokens)}
                    </span>
                    ）
                  </button>
                ))}
              </div>
              <details>
                <summary>额度流水（接口为精确整数）</summary>
                {ledger.length ? (
                  ledger.map((entry) => (
                    <p key={entry.entry_id}>
                      {entry.type} ·{" "}
                      <span title={formatExactTokens(entry.tokens)}>
                        {formatCompactTokens(entry.tokens)}
                      </span>
                      → 余额{" "}
                      <span title={formatExactTokens(entry.balance_after)}>
                        {formatCompactTokens(entry.balance_after)}
                      </span>
                    </p>
                  ))
                ) : (
                  <p>暂无流水</p>
                )}
              </details>
            </details>
            <details>
              <summary>登录方式绑定（{bindings.length}）</summary>
              {bindings.length ? (
                bindings.map((b) => (
                  <p key={`${b.provider}:${b.provider_uid}`}>
                    {b.provider} · {b.provider_uid}{" "}
                    <button
                      disabled={busy || bindings.length <= 1}
                      onClick={() =>
                        void operation(async () => {
                          if (!reauthToken) {
                            throw new Error("请先完成敏感操作身份验证（发送并校验验证码，用途 reauth）");
                          }
                          await request(
                            "account/bindings",
                            "DELETE",
                            {
                              provider: b.provider,
                              provider_uid: b.provider_uid,
                              reauth_token: reauthToken,
                            },
                            current.token,
                          );
                          setReauthToken("");
                          const bound = await request(
                            "account/bindings",
                            "GET",
                            undefined,
                            current.token,
                          );
                          setBindings(bound.bindings ?? []);
                          message("已解绑该登录方式");
                        })
                      }
                    >
                      解绑
                    </button>
                  </p>
                ))
              ) : (
                <p>暂无绑定记录</p>
              )}
              <p>绑定/解绑需重新验证身份。最后一种登录方式不可解绑。</p>
              <label className="form-label">
                重新验证令牌（reauth_token）
                <input
                  aria-label="重新验证令牌"
                  value={reauthToken}
                  onChange={(e) => setReauthToken(e.target.value)}
                />
              </label>
            </details>
            <details>
              <summary>账号注销</summary>
              <p>注销后无法再用任何方式登录原账号；个人数据按下列规则处理：</p>
              <ul>
                {deletionNotice.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <label className="grant">
                <input
                  type="checkbox"
                  checked={ackDelete}
                  onChange={(e) => setAckDelete(e.target.checked)}
                />
                我已阅读并确认注销后果
              </label>
              <button
                disabled={busy || !ackDelete}
                onClick={() =>
                  void operation(async () => {
                    if (!reauthToken) {
                      throw new Error("注销前须完成身份验证并填入 reauth_token");
                    }
                    await request(
                      "account/delete",
                      "POST",
                      {
                        acknowledge_consequences: true,
                        reauth_token: reauthToken,
                        verified: true,
                      },
                      current.token,
                    );
                    session = null;
                    cloudETag = null;
                    setCurrent(null);
                    setBotToken("");
                    setAnswer("");
                    setAckDelete(false);
                    setReauthToken("");
                    aiRequest.current = null;
                    message("账号已注销，所有凭证已失效");
                  })
                }
              >
                确认注销账号
              </button>
            </details>
            <button
              disabled={busy}
              onClick={() =>
                void operation(async () => {
                  const result = await request(
                    "session",
                    "DELETE",
                    undefined,
                    current.token,
                  );
                  session = null;
                  cloudETag = null;
                  setCurrent(null);
                  setBotToken("");
                  setAnswer("");
                  aiRequest.current = null;
                  message(
                    result.chatRevoked === false
                      ? "本应用会话及在线权限已撤销。Chat 暂未确认撤销，请到账户中心查看。"
                      : "账户会话及在线权限已撤销",
                  );
                })
              }
            >
              退出并撤销全部在线权限
            </button>
          </>
        )}
        <div className="connection-actions">
          {(["support.url", "downloads.url", "bot.url"] as const).map(
            (key, i) => (
              <button
                key={key}
                disabled={!config[key]}
                onClick={() =>
                  void operation(async () => {
                    await openExternal(config[key]);
                  })
                }
              >
                {["统一支持", "五端下载", "打开 Bot"][i]}
              </button>
            ),
          )}
        </div>
      </section>
    </div>
  );
}
