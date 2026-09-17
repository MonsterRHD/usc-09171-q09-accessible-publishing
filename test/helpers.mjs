import { createServer } from "../src/app.mjs";

// 启动一个使用可控时钟的测试实例
export async function startApp(options = {}) {
  let now = options.now ?? "2026-09-12T10:00:00+08:00";
  const server = createServer({ now: () => now });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const request = async (method, path, { role, id, body } = {}) => {
    const headers = { "content-type": "application/json" };
    if (role) headers["x-actor-role"] = role;
    if (id) headers["x-actor-id"] = id;
    const response = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  return {
    request,
    state: server.state,
    setNow: (value) => {
      now = value;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// 常用搭建动作
export async function setupObject(app, { kind = "original", name = "兽面纹鼎", replica_of } = {}) {
  const res = await app.request("POST", "/objects", {
    role: "curator",
    id: "curator-1",
    body: { kind, name, ...(replica_of ? { replica_of } : {}) },
  });
  return res;
}

export async function confirm(app, assetId, version, domain, role) {
  return app.request("POST", `/assets/${assetId}/versions/${version}/confirmations`, {
    role,
    id: `${role}-1`,
    body: { domain },
  });
}

export async function publishAndDispatch(app, objectId, channels, kinds) {
  const pub = await app.request("POST", "/publications", {
    role: "editor",
    id: "editor-1",
    body: { object_id: objectId, channels, ...(kinds ? { kinds } : {}) },
  });
  if (pub.status !== 201) return { pub, deliveries: [] };
  const deliveries = [];
  for (const c of pub.body.channels) {
    const attempt = await app.request("POST", `/deliveries/${c.id}/attempts`, {
      role: "editor",
      id: "editor-1",
      body: { outcome: "sent" },
    });
    deliveries.push(attempt);
  }
  return { pub, deliveries };
}
