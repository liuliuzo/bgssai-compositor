import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { Filesystem, Directory, Encoding } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { Browser } from "@capacitor/browser";

declare const __APP_CONFIG__: Record<string, string>;
export const native = Capacitor.isNativePlatform();
export const platformName = window.desktop
  ? navigator.platform
  : native
    ? Capacitor.getPlatform()
    : "Web";
export const routes = new Set([
  "auth/begin",
  "auth/poll",
  "auth/cancel",
  "session",
  "grants",
  "project",
  "bot/token",
  "ai/text",
]);
export async function getConfig() {
  return window.desktop ? window.desktop.getConnections() : __APP_CONFIG__;
}
export async function request(
  route: string,
  method: string,
  body?: unknown,
  token?: string,
  etag?: string,
) {
  if (!routes.has(route) || !["GET", "POST", "PUT", "DELETE"].includes(method))
    throw new Error("无效的连接请求");
  if (window.desktop)
    return window.desktop.requestConnection({
      route,
      method,
      body,
      token,
      etag,
    });
  const config = await getConfig();
  if (!config["ecosystem.url"])
    throw new Error("尚未配置在线服务，离线编辑仍可使用。");
  const base = new URL(config["ecosystem.url"]);
  if (
    base.protocol !== "https:" ||
    base.pathname !== "/" ||
    base.username ||
    base.password
  )
    throw new Error("在线服务必须使用 HTTPS 根地址");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (etag) headers["If-Match"] = etag;
  if (native) {
    const response = await CapacitorHttp.request({
      url: `${base.origin}/api/${route}`,
      method,
      headers,
      data: body,
      connectTimeout: 15000,
      readTimeout: 30000,
      disableRedirects: true,
    });
    if (response.status < 200 || response.status >= 300)
      throw new Error(
        response.status === 412
          ? "云端版本已变化，请先下载云端版本，避免覆盖。"
          : `连接失败（${response.status}）`,
      );
    return response.data;
  }
  const response = await fetch(`${base.origin}/api/${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(30000),
    credentials: "omit",
  });
  if (!response.ok)
    throw new Error(
      response.status === 412
        ? "云端版本已变化，请先下载云端版本，避免覆盖。"
        : `连接失败（${response.status}）`,
    );
  return response.json();
}
export async function openExternal(url: string) {
  if (window.desktop) return window.desktop.openExternal(url);
  const config = await getConfig();
  const origins = [
    config["chat.issuer"],
    config["support.url"],
    config["downloads.url"],
    config["bot.url"],
  ]
    .filter(Boolean)
    .map((value) => new URL(value).origin);
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    !origins.includes(parsed.origin) ||
    parsed.username ||
    parsed.password
  )
    throw new Error("链接不在已配置的服务范围内");
  if (native) await Browser.open({ url });
  else window.open(url, "_blank", "noopener,noreferrer");
}
export async function saveNative(
  name: string,
  content: string,
  format: "bgcomp" | "png" | "jpeg",
) {
  const filename = `${name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 100) || "未命名"}-${crypto.randomUUID().slice(0, 8)}.${format === "jpeg" ? "jpg" : format}`;
  const result = await Filesystem.writeFile({
    path: filename,
    directory: Directory.Documents,
    data: format === "bgcomp" ? content : content.split(",")[1],
    ...(format === "bgcomp" ? { encoding: Encoding.UTF8 } : {}),
  });
  await Share.share({ title: filename, files: [result.uri] }).catch(() => {});
  return { name: filename, path: result.uri };
}
