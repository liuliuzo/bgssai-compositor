import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const hash = (value) => createHash("sha256").update(value).digest("hex");

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

export function createAccountStore(dataDirectory) {
  const accountsDir = path.join(dataDirectory, "accounts");
  const bindingsDir = path.join(dataDirectory, "identity-bindings");
  const localUsersDir = path.join(dataDirectory, "local-users");
  const authRecordsDir = path.join(dataDirectory, "auth-records");

  async function ensure() {
    await mkdir(accountsDir, { recursive: true, mode: 0o700 });
    await mkdir(bindingsDir, { recursive: true, mode: 0o700 });
    await mkdir(authRecordsDir, { recursive: true, mode: 0o700 });
  }

  async function writeJson(file, value, { exclusive = false } = {}) {
    await writeFile(file, JSON.stringify(value), {
      flag: exclusive ? "wx" : "w",
      mode: 0o600,
      flush: true,
    });
  }

  async function readJson(file) {
    return JSON.parse(await readFile(file, "utf8"));
  }

  function accountPath(accountId) {
    return path.join(accountsDir, `${hash(accountId)}.json`);
  }

  function bindingPath(provider, providerUid) {
    return path.join(bindingsDir, `${hash(`${provider}\0${providerUid}`)}.json`);
  }

  async function loadAccount(accountId) {
    try {
      return await readJson(accountPath(accountId));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw fail(503, "账号存储暂不可用");
    }
  }

  async function saveAccount(account) {
    await ensure();
    await writeJson(accountPath(account.account_id), account);
    return account;
  }

  async function getBinding(provider, providerUid) {
    try {
      return await readJson(bindingPath(provider, providerUid));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw fail(503, "账号绑定存储暂不可用");
    }
  }

  async function putBinding(binding, { exclusive = false } = {}) {
    await ensure();
    try {
      await writeJson(bindingPath(binding.provider, binding.provider_uid), binding, {
        exclusive,
      });
    } catch (error) {
      if (error.code === "EEXIST") throw fail(409, "该登录方式已绑定其他账号");
      throw fail(503, "账号绑定存储暂不可用");
    }
  }

  async function removeBinding(provider, providerUid) {
    try {
      await unlink(bindingPath(provider, providerUid));
    } catch (error) {
      if (error.code !== "ENOENT") throw fail(503, "账号绑定存储暂不可用");
    }
  }

  async function listBindings(accountId) {
    await ensure();
    const files = await readdir(bindingsDir).catch(() => []);
    const bindings = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const binding = await readJson(path.join(bindingsDir, file));
        if (binding.account_id === accountId && !binding.deleted) bindings.push(binding);
      } catch {
        /* skip corrupt binding; do not fail the whole list */
      }
    }
    return bindings.sort((a, b) => String(a.provider).localeCompare(String(b.provider)));
  }

  function newAccount({ name, primarySub }) {
    const accountId = `acct_${randomBytes(12).toString("hex")}`;
    return {
      account_id: accountId,
      name: String(name ?? primarySub).slice(0, 200),
      primary_sub: primarySub,
      created_at: Date.now(),
      deleted_at: null,
      anonymized: false,
    };
  }

  async function createLocalPasswordAccount({ identifier, password, name }) {
    await ensure();
    await mkdir(localUsersDir, { recursive: true, mode: 0o700 });
    const cleanId = identifier.trim().toLowerCase();
    if (!cleanId || cleanId.length > 160) throw fail(400, "账号标识无效");
    if (password.length < 6 || password.length > 200) throw fail(400, "密码长度须为 6 至 200 位");
    const existing = await getBinding("password", cleanId);
    if (existing) throw fail(409, "账号已注册");
    const salt = randomBytes(16).toString("hex");
    const passwordHash = scryptSync(password, salt, 32).toString("hex");
    const sub = `local:${cleanId}`;
    const account = newAccount({ name: name ?? cleanId, primarySub: sub });
    const legacy = {
      identifier: cleanId,
      sub,
      name: account.name,
      salt,
      passwordHash,
      createdAt: account.created_at,
      account_id: account.account_id,
    };
    try {
      await writeJson(path.join(localUsersDir, `${hash(cleanId)}.json`), legacy, {
        exclusive: true,
      });
    } catch (error) {
      if (error.code === "EEXIST") throw fail(409, "账号已注册");
      throw fail(503, "账号存储暂不可用");
    }
    await saveAccount(account);
    await putBinding(
      {
        provider: "password",
        provider_uid: cleanId,
        account_id: account.account_id,
        sub,
        created_at: Date.now(),
      },
      { exclusive: true },
    );
    return { account, sub, legacy };
  }

  async function verifyLocalPassword(identifier, password) {
    const cleanId = identifier.trim().toLowerCase();
    let user;
    try {
      user = await readJson(path.join(localUsersDir, `${hash(cleanId)}.json`));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw fail(503, "账号存储暂不可用");
    }
    if (
      !user ||
      user.identifier !== cleanId ||
      !/^[a-f0-9]{32}$/.test(user.salt) ||
      !/^[a-f0-9]{64}$/.test(user.passwordHash)
    ) {
      return null;
    }
    const candidateHash = scryptSync(password, user.salt, 32).toString("hex");
    if (
      !timingSafeEqual(Buffer.from(candidateHash, "hex"), Buffer.from(user.passwordHash, "hex"))
    ) {
      return null;
    }
    let accountId = user.account_id;
    if (!accountId) {
      const binding = await getBinding("password", cleanId);
      accountId = binding?.account_id;
    }
    if (!accountId) {
      const account = newAccount({ name: user.name, primarySub: user.sub });
      user.account_id = account.account_id;
      await writeJson(path.join(localUsersDir, `${hash(cleanId)}.json`), user);
      await saveAccount(account);
      await putBinding({
        provider: "password",
        provider_uid: cleanId,
        account_id: account.account_id,
        sub: user.sub,
        created_at: Date.now(),
      });
      accountId = account.account_id;
    }
    const account = await loadAccount(accountId);
    if (account?.deleted_at) throw fail(403, "账号已注销，无法登录");
    return { user, account, sub: user.sub };
  }

  async function ensureChatAccount({ sub, name }) {
    const binding = await getBinding("chat", sub);
    if (binding) {
      const account = await loadAccount(binding.account_id);
      if (account?.deleted_at) throw fail(403, "账号已注销，无法登录");
      return { account, binding };
    }
    const account = newAccount({ name, primarySub: sub });
    await saveAccount(account);
    await putBinding(
      {
        provider: "chat",
        provider_uid: sub,
        account_id: account.account_id,
        sub,
        created_at: Date.now(),
      },
      { exclusive: true },
    );
    return { account, binding: { provider: "chat", provider_uid: sub, account_id: account.account_id } };
  }

  async function ensureOtpAccount({ channel, target, name }) {
    const provider = channel === "phone" ? "phone" : "email";
    const providerUid = target.trim().toLowerCase();
    const binding = await getBinding(provider, providerUid);
    if (binding) {
      const account = await loadAccount(binding.account_id);
      if (account?.deleted_at) throw fail(403, "账号已注销，无法登录");
      return { account, sub: binding.sub ?? `${provider}:${providerUid}` };
    }
    const sub = `${provider}:${providerUid}`;
    const account = newAccount({ name: name ?? providerUid, primarySub: sub });
    await saveAccount(account);
    await putBinding(
      {
        provider,
        provider_uid: providerUid,
        account_id: account.account_id,
        sub,
        created_at: Date.now(),
      },
      { exclusive: true },
    );
    return { account, sub };
  }

  async function bindIdentity(accountId, { provider, provider_uid, sub }, { reauthOk }) {
    if (!reauthOk) throw fail(401, "敏感变更需重新验证身份");
    const account = await loadAccount(accountId);
    if (!account || account.deleted_at) throw fail(403, "账号不可用");
    const uid = String(provider_uid).trim().toLowerCase();
    if (!provider || !uid) throw fail(400, "绑定参数无效");
    const existing = await getBinding(provider, uid);
    if (existing && existing.account_id !== accountId) {
      throw fail(409, "该登录方式已绑定其他账号");
    }
    if (existing && existing.account_id === accountId) return existing;
    const binding = {
      provider,
      provider_uid: uid,
      account_id: accountId,
      sub: sub ?? `${provider}:${uid}`,
      created_at: Date.now(),
    };
    await putBinding(binding, { exclusive: true });
    return binding;
  }

  async function unbindIdentity(accountId, provider, providerUid, { reauthOk }) {
    if (!reauthOk) throw fail(401, "敏感变更需重新验证身份");
    const bindings = await listBindings(accountId);
    if (bindings.length <= 1) throw fail(400, "至少保留一种可用的登录方式");
    const uid = String(providerUid).trim().toLowerCase();
    const target = bindings.find((b) => b.provider === provider && b.provider_uid === uid);
    if (!target) throw fail(404, "未找到该登录方式绑定");
    await removeBinding(provider, uid);
    if (provider === "password") {
      try {
        await unlink(path.join(localUsersDir, `${hash(uid)}.json`));
      } catch {
        /* ignore */
      }
    }
    return true;
  }

  async function recordAuthGrant({ accountId, provider, subject }) {
    await ensure();
    const record = {
      grant_id: `grant_${randomBytes(8).toString("hex")}`,
      account_id: accountId,
      provider,
      subject,
      product_code: "compositor",
      created_at: Date.now(),
      revoked_at: null,
    };
    await writeJson(path.join(authRecordsDir, `${record.grant_id}.json`), record);
    return record;
  }

  async function deleteAccount(accountId, { verified, blockers }) {
    if (!verified) throw fail(401, "未完成身份验证，不能注销");
    if (Array.isArray(blockers) && blockers.length) {
      throw fail(409, `存在未结事项：${blockers.join("；")}`);
    }
    const account = await loadAccount(accountId);
    if (!account) throw fail(404, "账号不存在");
    if (account.deleted_at) return account;
    const bindings = await listBindings(accountId);
    account.deleted_at = Date.now();
    account.anonymized = true;
    account.name = "已注销用户";
    account.primary_sub = `deleted:${account.account_id}`;
    await saveAccount(account);
    for (const binding of bindings) {
      await removeBinding(binding.provider, binding.provider_uid);
      if (binding.provider === "password") {
        try {
          await unlink(path.join(localUsersDir, `${hash(binding.provider_uid)}.json`));
        } catch {
          /* ignore */
        }
      }
    }
    return account;
  }

  async function resolveAccountIdForSub(sub) {
    await ensure();
    const files = await readdir(bindingsDir).catch(() => []);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const binding = await readJson(path.join(bindingsDir, file));
        if (binding.sub === sub || binding.provider_uid === sub) return binding.account_id;
      } catch {
        /* skip */
      }
    }
    if (String(sub).startsWith("local:")) {
      const identifier = String(sub).slice("local:".length);
      try {
        const user = await readJson(path.join(localUsersDir, `${hash(identifier)}.json`));
        return user.account_id ?? null;
      } catch {
        return null;
      }
    }
    return null;
  }

  return {
    createLocalPasswordAccount,
    verifyLocalPassword,
    ensureChatAccount,
    ensureOtpAccount,
    bindIdentity,
    unbindIdentity,
    listBindings,
    loadAccount,
    deleteAccount,
    recordAuthGrant,
    resolveAccountIdForSub,
    getBinding,
  };
}
