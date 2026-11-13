import { randomBytes } from "node:crypto";

import { AdminConfigStore } from "../bootstrap/admin-config-store";
import { withDestinationHints } from "../bootstrap/notification-destination-hints";
import type { NotificationPlatformTargetConfiguration } from "../bootstrap/notification-platform";
import type { NotificationIngressConfig } from "../domains/notification/notification-ingress-contract";
import type { NotificationTargetRef } from "../domains/notification/notification-target-policy";
import { HttpError, json, readJson } from "./http-boundary";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
type Patch = Parameters<AdminConfigStore["update"]>[1];

export async function handleAdminManagementRoutes(input: {
  request: Request; url: URL; store: AdminConfigStore;
  targets: NotificationPlatformTargetConfiguration;
  listTargets: () => Promise<NotificationTargetRef[]>;
  update: (revision: string, change: Patch) => Promise<void>;
}): Promise<Response | undefined> {
  const { request, url, store } = input;
  if (url.pathname === "/admin/api/config" && request.method === "GET") {
    return json(await publicConfig(store, input.targets, input.listTargets));
  }
  if (url.pathname === "/admin/api/bark" && request.method === "POST") {
    const raw = record(await readJson(request, 5_000), ["revision", "id", "label", "device_key", "server_url", "domains", "enabled", "authorization"]);
    const id = targetId(raw.id);
    if (typeof raw.device_key !== "string") throw new HttpError(400, "New Bark target requires a device key");
    await input.update(revision(raw), (config) => {
      if (config.bark?.some((item) => item.id === id)) throw new HttpError(409, "Bark target already exists");
      return { bark: [...config.bark ?? [], barkInput(raw, id)] };
    });
    return json(await publicConfig(store, input.targets, input.listTargets), 201);
  }
  const bark = url.pathname.match(/^\/admin\/api\/bark\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/);
  if (bark && request.method === "PUT") {
    const raw = record(await readJson(request, 5_000), ["revision", "label", "device_key", "server_url", "domains", "enabled", "authorization"]);
    await input.update(revision(raw), (config) => {
      const old = config.bark?.find((item) => item.id === bark[1]);
      if (!old) throw new HttpError(404, "Bark target not found");
      const changed = barkInput(raw, old.id, old);
      if ((!changed.enabled || !changed.domains.includes("ops"))
        && config.rules.some((rule) => rule.targets.includes(`bark:${old.id}`))) {
        throw new HttpError(409, "Remove routing rules before disabling an ops target");
      }
      return { bark: config.bark!.map((item) => item.id === old.id ? changed : item) };
    });
    return json(await publicConfig(store, input.targets, input.listTargets));
  }
  if (url.pathname === "/admin/api/email" && request.method === "PUT") {
    const raw = record(await readJson(request, 5_000), ["revision", "smtp", "target"]);
    const target = record(raw.target, ["id", "address", "enabled"]);
    const id = targetId(target.id);
    const smtp = raw.smtp === undefined ? undefined : record(raw.smtp, ["host", "port", "secure", "user", "password", "from"]);
    await input.update(revision(raw), (config) => {
      const previous = config.email.find((item) => item.id === id);
      const address = target.address === undefined || target.address === "" ? previous?.address : target.address;
      if (typeof address !== "string") throw new HttpError(400, "New email target requires an address");
      const enabled = target.enabled === undefined ? (previous?.enabled ?? true) : target.enabled;
      if (typeof enabled !== "boolean") throw new HttpError(400, "enabled must be boolean");
      if (!enabled && config.rules.some((rule) => rule.targets.includes(`email:${id}`))) {
        throw new HttpError(409, "Remove routing rules before disabling an email target");
      }
      const email = [...config.email.filter((item) => item.id !== id), { id, address, enabled }];
      let nextSmtp = config.smtp;
      if (smtp) {
        const password = smtp.password === undefined || smtp.password === "" ? config.smtp?.password : smtp.password;
        nextSmtp = { ...config.smtp, ...smtp, password } as typeof config.smtp;
      }
      if (!nextSmtp) throw new HttpError(400, "SMTP settings are required");
      return { email, smtp: nextSmtp };
    });
    return json(await publicConfig(store, input.targets, input.listTargets));
  }
  if (url.pathname === "/admin/api/sources" && request.method === "POST") {
    const raw = record(await readJson(request, 1_000), ["revision", "id"]);
    const id = targetId(raw.id);
    const token = randomBytes(32).toString("hex");
    await input.update(revision(raw), (config) => {
      if (config.sources.some((item) => item.id === id)) throw new HttpError(409, "Source already exists");
      return { sources: [...config.sources, { id, token }] };
    });
    return json({ ...(await publicConfig(store, input.targets, input.listTargets)), source_token: token }, 201);
  }
  const source = url.pathname.match(/^\/admin\/api\/sources\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/);
  if (source && request.method === "DELETE") {
    const raw = record(await readJson(request, 1_000), ["revision"]);
    await input.update(revision(raw), (config) => {
      if (!config.sources.some((item) => item.id === source[1])) throw new HttpError(404, "Source not found");
      if (config.rules.some((rule) => rule.source === source[1])) {
        throw new HttpError(409, "Remove this source's routing rules first");
      }
      return { sources: config.sources.filter((item) => item.id !== source[1]) };
    });
    return json(await publicConfig(store, input.targets, input.listTargets));
  }
  if (url.pathname === "/admin/api/rules" && request.method === "PUT") {
    const raw = record(await readJson(request, 16_384), ["revision", "rules"]);
    if (!Array.isArray(raw.rules)) throw new HttpError(400, "rules must be an array");
    const rules = raw.rules as unknown[];
    await input.update(revision(raw), (config) => {
      const available = new Set((config.bark ?? []).filter((item) => item.enabled && item.domains.includes("ops"))
        .map((item) => `bark:${item.id}`));
      config.email.filter((item) => item.enabled).forEach((item) => available.add(`email:${item.id}`));
      input.targets.ntfyTargets.filter((item) => item.enabled && item.domains.includes("ops"))
        .forEach((item) => available.add(`ntfy:${item.id}`));
      input.targets.telegramTargets.filter((item) => item.enabled && item.domains.includes("ops"))
        .forEach((item) => available.add(`telegram:${item.id}`));
      if (rules.some((entry) => entry && typeof entry === "object" && !Array.isArray(entry)
        && Array.isArray((entry as { targets?: unknown }).targets)
        && (entry as { targets: unknown[] }).targets.some((target) => !available.has(String(target))))) {
        throw new HttpError(400, "Rule target must be enabled and accept ops events");
      }
      return { rules: rules as NotificationIngressConfig["rules"] };
    });
    return json(await publicConfig(store, input.targets, input.listTargets));
  }
  return undefined;
}

async function publicConfig(store: AdminConfigStore, configured: NotificationPlatformTargetConfiguration,
  listTargets: () => Promise<NotificationTargetRef[]>) {
  const config = store.config;
  const targets = withDestinationHints(await listTargets(), config, configured).map((item) => ({
    ...item,
    ...(item.channel === "bark" ? {
      server_url: config.bark?.find((row) => row.id === item.id)?.server_url,
      device_key_suffix: config.bark?.find((row) => row.id === item.id)?.device_key.slice(-4),
      authorization_configured: Boolean(config.bark?.find((row) => row.id === item.id)?.authorization),
    } : {}),
    ...(item.channel === "email" ? {
      address_hint: maskAddress(config.email.find((row) => row.id === item.id)?.address),
    } : {}),
  }));
  return { revision: store.revision, targets, sources: config.sources.map(({ id }) => ({ id })),
    rules: config.rules, smtp: config.smtp ? { host: config.smtp.host, port: config.smtp.port,
      secure: config.smtp.secure, user: config.smtp.user, from: config.smtp.from, password_configured: true } : null };
}

function barkInput(raw: Record<string, unknown>, id: string,
  old?: NonNullable<NotificationIngressConfig["bark"]>[number]): NonNullable<NotificationIngressConfig["bark"]>[number] {
  if (typeof raw.label !== "string" || typeof raw.server_url !== "string"
    || !Array.isArray(raw.domains) || typeof raw.enabled !== "boolean") {
    throw new HttpError(400, "Bark target requires label, server_url, domains and enabled");
  }
  if (raw.device_key !== undefined && typeof raw.device_key !== "string") throw new HttpError(400, "Invalid device key");
  if (raw.authorization !== undefined && typeof raw.authorization !== "string") throw new HttpError(400, "Invalid authorization");
  return { id, label: raw.label, device_key: raw.device_key || old?.device_key || "",
    server_url: raw.server_url, domains: raw.domains as NonNullable<NotificationIngressConfig["bark"]>[number]["domains"],
    enabled: raw.enabled, ...(raw.authorization ? { authorization: raw.authorization }
      : old?.authorization ? { authorization: old.authorization } : {}) };
}

function maskAddress(address?: string): string | undefined {
  if (!address) return undefined;
  const [local, domain] = address.split("@");
  return `${local?.[0] ?? "*"}***@${domain}`;
}

function record(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !fields.includes(key))) throw new HttpError(400, "Invalid admin request");
  return value as Record<string, unknown>;
}

function targetId(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) throw new HttpError(400, "Invalid ID");
  return value;
}

function revision(value: Record<string, unknown>): string {
  if (typeof value.revision !== "string" || value.revision.length > 80) throw new HttpError(400, "revision is required");
  return value.revision;
}
