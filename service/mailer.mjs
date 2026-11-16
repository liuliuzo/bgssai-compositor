import nodemailer from "nodemailer";
import { isUsableValue } from "./sms.mjs";

function fail(status, message, code) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

export function maskEmail(addr) {
  const s = String(addr ?? "").trim();
  const at = s.indexOf("@");
  if (at < 1) return "***";
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  const head = local.slice(0, Math.min(2, local.length));
  return `${head}***@${domain}`;
}

export function isSmtpReady(smtpConfig) {
  if (!smtpConfig || !smtpConfig.enabled) return false;
  return Boolean(
    String(smtpConfig.host ?? "").trim() &&
      String(smtpConfig.username ?? "").trim() &&
      isUsableValue(smtpConfig.password),
  );
}

/**
 * Real SMTP email delivery via nodemailer. Never logs plaintext OTP code or SMTP password.
 */
export async function sendSmtpEmail({
  to,
  code,
  expireMinutes = 5,
  smtpConfig,
  createTransport,
}) {
  if (!isSmtpReady(smtpConfig)) {
    throw fail(503, "邮箱验证码真实邮件通道尚未配置，暂未启用", "EMAIL_UNCONFIGURED");
  }
  const safeCode = String(code ?? "").replace(/[\r\n]/g, "").trim();
  const minutes = Math.max(1, Math.ceil(Number(expireMinutes) || 5));
  const port = Number(smtpConfig.port) || 465;
  const secure =
    smtpConfig.secure !== undefined ? Boolean(smtpConfig.secure) : port === 465;
  const user = String(smtpConfig.username).trim();
  const pass = String(smtpConfig.password).trim();
  const from =
    String(smtpConfig.from_address ?? "").trim() || user;
  const factory = createTransport ?? nodemailer.createTransport;
  const transporter = factory({
    host: String(smtpConfig.host).trim(),
    port,
    secure,
    auth: { user, pass },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });

  try {
    await transporter.sendMail({
      from,
      to: String(to ?? "").trim(),
      subject: "BGSSAI Compositor 登录验证码",
      text: `您的验证码是 ${safeCode}，${minutes} 分钟内有效。请勿转发给他人。`,
    });
    return { delivered: true, adapter: "smtp" };
  } catch (cause) {
    console.warn("[otp-email] send failed", {
      to: maskEmail(to),
      code: cause?.code ?? "unknown",
    });
    throw fail(502, "邮件发送失败，请稍后重试", "EMAIL_SEND_FAILED");
  } finally {
    transporter.close?.();
  }
}
