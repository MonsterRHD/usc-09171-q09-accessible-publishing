import http from "node:http";
import { DomainError } from "./domain/errors.mjs";
import { EventStore, createClock } from "./domain/store.mjs";
import { PublishingService } from "./domain/service.mjs";

// 路由声明：[method, pattern, handler]，pattern 中的 :name 提取为路径参数。
export function createServer({ store, clock } = {}) {
  const eventStore = store ?? new EventStore({ clock: clock ?? createClock() });
  const service = new PublishingService(eventStore);

  return http.createServer((request, response) => {
    handle(request, response, service).catch((error) => {
      const body = {
        error: error instanceof DomainError ? error.code : "internal-error",
        message: error.message,
      };
      if (error instanceof DomainError && error.details !== undefined) body.details = error.details;
      const status = error instanceof DomainError ? error.status : 500;
      sendJson(response, status, body);
    });
  });
}

async function handle(request, response, service) {
  const url = new URL(request.url, "http://localhost");
  const path = url.pathname;
  const method = request.method;

  if (method === "GET" && path === "/health") {
    sendJson(response, 200, { status: "ok", service: "accessible-publishing" });
    return;
  }

  const actor = readActor(request);
  const body = ["GET", "HEAD"].includes(method) ? null : await readJson(request);
  const route = matchRoute(method, path);

  if (!route) {
    sendJson(response, 404, { error: "not-found", message: `未找到 ${method} ${path}` });
    return;
  }

  const { handler, params } = route;
  const result = await handler(service, { body, params, query: url.searchParams, actor });
  sendJson(response, 200, result ?? { ok: true });
}

// 每条路由对应服务中的一个用例；接口命名与领域动作保持一致。
const ROUTES = [
  ["POST", "/objects", (s, { body, actor }) => s.registerObject(actor, body)],
  ["POST", "/objects/:id/facts", (s, { body, params, actor }) =>
    s.recordFact(actor, { objectId: params.id, ...body })],
  ["POST", "/objects/:id/facts/:version/retract", (s, { body, params, actor }) =>
    s.retractFact(actor, { objectId: params.id, version: params.version, reason: body?.reason })],

  ["POST", "/objects/:id/components", (s, { body, params, actor }) =>
    s.draftComponent(actor, { objectId: params.id, ...body })],
  ["POST", "/objects/:id/components/:type/:version/confirm", (s, { params, actor }) =>
    s.confirmComponent(actor, { objectId: params.id, componentType: params.type, version: params.version })],

  ["POST", "/objects/:id/images/grant", (s, { body, params, actor }) =>
    s.grantImageLicense(actor, { objectId: params.id, ...body })],
  ["POST", "/objects/:id/images/:imageId/withdraw", (s, { body, params, actor }) =>
    s.withdrawImageLicense(actor, { objectId: params.id, imageId: params.imageId, reason: body?.reason })],

  ["POST", "/objects/:id/packages", (s, { body, params, actor }) =>
    s.buildPackage(actor, { objectId: params.id, imageIds: body?.imageIds })],
  ["POST", "/objects/:id/dispatches", (s, { body, params, actor }) =>
    s.dispatchPackage(actor, { objectId: params.id, channels: body?.channels, digest: body?.digest })],
  ["POST", "/dispatches/:id/retry", (s, { params, actor }) =>
    s.retryDelivery(actor, { dispatchId: params.id })],

  // 渠道回执 webhook：不要求内部身份，字段沿用既有样例的下划线命名。
  ["POST", "/receipts", (s, { body }) => s.recordReceipt(null, body)],

  ["POST", "/objects/:id/emergency-pull", (s, { body, params, actor }) =>
    s.emergencyPull(actor, {
      objectId: params.id,
      channels: body?.channels,
      harmfulDescription: body?.harmfulDescription,
      correctionId: body?.correctionId,
    })],

  // 观众入口：无需内部身份，只收集处理所需信息。
  ["POST", "/corrections", (s, { body }) => s.fileCorrection(null, body)],
  ["GET", "/corrections", (s, { actor }) => ({ corrections: s.listCorrections(actor) })],
  ["GET", "/corrections/:id/contact", (s, { params, actor }) =>
    s.readCorrectionContact(actor, { correctionId: params.id })],
  ["POST", "/corrections/:id/resolve", (s, { body, params, actor }) =>
    s.resolveCorrection(actor, { correctionId: params.id, ...body })],

  ["GET", "/objects/:id/resend-scope", (s, { params, actor }) =>
    s.resendScope(actor, { objectId: params.id })],
  ["GET", "/objects/:id/dispatches", (s, { params, actor }) =>
    ({ dispatches: s.listDispatches(actor, { objectId: params.id }) })],
  ["GET", "/objects/:id/audit", (s, { params, actor }) =>
    ({ events: s.objectAuditTrail(actor, { objectId: params.id }) })],

  ["GET", "/channels/:channel/timeline", (s, { params, actor }) =>
    ({ timeline: s.channelTimeline(actor, { channel: params.channel }) })],
  ["GET", "/channels/:channel/display-at", (s, { params, query, actor }) =>
    s.displayAt(actor, { channel: params.channel, at: query.get("at") })],
];

function matchRoute(method, path) {
  for (const [routeMethod, pattern, handler] of ROUTES) {
    if (routeMethod !== method) continue;
    const patternParts = pattern.split("/").filter(Boolean);
    const pathParts = path.split("/").filter(Boolean);
    if (patternParts.length !== pathParts.length) continue;
    const params = {};
    let matched = true;
    for (let i = 0; i < patternParts.length; i += 1) {
      if (patternParts[i].startsWith(":")) {
        params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
      } else if (patternParts[i] !== pathParts[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return { handler, params };
  }
  return null;
}

function readActor(request) {
  const id = request.headers["x-actor-id"];
  const role = request.headers["x-actor-role"];
  if (id && role) return { id, role };
  return null;
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new DomainError(400, "bad-request", "请求体不是合法 JSON"));
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}
