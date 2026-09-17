import { DomainError } from "./domain.mjs";

// 极简路由：method + 路径段匹配（:name 为参数），统一 JSON 解析与错误格式。
export function createRouter() {
  const routes = [];
  const add = (method, pattern, handler) => {
    routes.push({ method, parts: pattern.split("/").filter(Boolean), handler });
  };
  const match = (method, pathname) => {
    const segments = pathname.split("/").filter(Boolean);
    for (const route of routes) {
      if (route.method !== method || route.parts.length !== segments.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < route.parts.length; i += 1) {
        const part = route.parts[i];
        if (part.startsWith(":")) params[part.slice(1)] = decodeURIComponent(segments[i]);
        else if (part !== segments[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return { handler: route.handler, params };
    }
    return null;
  };

  const handle = async (request, response) => {
    const send = (status, body) => {
      response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(body));
    };
    const url = new URL(request.url, "http://localhost");
    const matched = match(request.method, url.pathname);
    if (!matched) {
      send(404, { error: { code: "not_found", message: "资源不存在" } });
      return;
    }
    let body = {};
    if (["POST", "PATCH", "PUT"].includes(request.method)) {
      const raw = await readBody(request);
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          send(400, { error: { code: "invalid_json", message: "请求体不是合法 JSON" } });
          return;
        }
      }
    }
    const actor = {
      id: request.headers["x-actor-id"] ?? "anonymous",
      role: request.headers["x-actor-role"] ?? "visitor",
    };
    try {
      const result = await matched.handler({ params: matched.params, query: url.searchParams, body, actor });
      send(result.status ?? 200, result.body);
    } catch (error) {
      if (error instanceof DomainError) {
        send(error.status, {
          error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
        });
      } else {
        send(500, { error: { code: "internal", message: "服务内部错误" } });
      }
    }
  };
  return { add, handle };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}
