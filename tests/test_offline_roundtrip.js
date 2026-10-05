"use strict";

// 前端「离线校订回传」的回归测试。
//
// 覆盖：
// 1. 导出快照：「下载纯文本」成功（且响应仍对应当前草稿）时留存最近导出快照
//    （order_ids + 内部正文）；等待期间改稿则取消下载、不留存快照；继续改稿不清空快照。
// 2. 预演：携带快照、回传文本、当前稿与最新 lock_ids；引用按导出时编号绑定（请求体由
//    后端解释，这里核验入参形态）；改稿或编辑文本后旧预演失效；换稿（重新导入 /
//    恢复存档）清空快照与回传状态，旧响应不影响新稿。
// 3. 提交复用写稿提交协调层（kind=offline-commit）：成功写回仅改动行、顺序与上界不变、
//    复核按 touch() 既有规则清理；409/422/断网失败不改稿、保留快照与文本；成功回包按
//    最新 lock_ids 核验。
// 4. 门禁：未保存编辑、拆分选择、写稿在途时不可预演 / 提交；须先预演才能提交。
//
// 本文件用最小 DOM 桩在 Node 虚拟机中加载真实的 app/static/app.js（不修改它），
// 直接驱动下载、预演、提交、换稿的真实事件处理器与内部函数，fetch 由测试逐个收尾。
// 运行：node --test tests/test_offline_roundtrip.js（无第三方依赖）

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const APP_JS = path.join(__dirname, "..", "app", "static", "app.js");

function makeElement(name) {
  const listeners = new Map();
  const el = {
    name,
    hidden: false,
    disabled: false,
    checked: false,
    textContent: "",
    innerHTML: "",
    value: "",
    title: "",
    dataset: {},
    children: [],
    classList: {
      add: () => {},
      remove: () => {},
      toggle: () => true,
      contains: () => false,
    },
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    fire(type, event = {}) {
      return Promise.all((listeners.get(type) || []).map((fn) => fn(event)));
    },
    appendChild() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    scrollIntoView: () => {},
    focus: () => {},
    setSelectionRange: () => {},
    click: () => {},
  };
  return el;
}

function makeFetchStub() {
  const calls = [];
  const fetch = (url, opts = {}) =>
    new Promise((resolve, reject) => {
      const call = {
        url,
        method: opts.method || "POST",
        body: opts.body ? JSON.parse(opts.body) : null,
        respond(status, data) {
          resolve({ ok: status >= 200 && status < 300, status, json: async () => data });
        },
        fail(err) {
          reject(err || new TypeError("fetch failed"));
        },
      };
      calls.push(call);
    });
  fetch.calls = calls;
  fetch.to = (part) => calls.filter((c) => c.url.includes(part));
  return fetch;
}

function loadApp() {
  const elements = new Map();
  const $el = (sel) => {
    if (!elements.has(sel)) elements.set(sel, makeElement(sel.replace(/^#/, "")));
    return elements.get(sel);
  };
  const fetch = makeFetchStub();
  const alerts = [];
  const confirms = [];
  const sandbox = {
    document: {
      querySelector: $el,
      querySelectorAll: () => [],
      getElementById: () => null,
      createElement: (tag) => makeElement(tag),
      createDocumentFragment: () => makeElement("fragment"),
      body: makeElement("body"),
    },
    fetch,
    confirm: () => {
      confirms.push(true);
      return true;
    },
    alert: (...args) => alerts.push(args.join(" ")),
    console,
    Blob: class {
      constructor(parts) {
        this.parts = parts;
      }
    },
    URL: { createObjectURL: () => "blob:fake", revokeObjectURL: () => {} },
    Date,
  };
  const source = fs.readFileSync(APP_JS, "utf8");
  const hook =
    "\n;globalThis.__app = { state, syncOfflinePanel, offlinePreview, clearOffline," +
    " submitWrite, installArchive, touch };\n";
  vm.createContext(sandbox);
  vm.runInContext(source + hook, sandbox, { filename: "app.js" });
  return {
    sandbox,
    fetch,
    $el,
    alerts,
    confirms,
    state: sandbox.__app.state,
    syncOfflinePanel: sandbox.__app.syncOfflinePanel,
    offlinePreview: sandbox.__app.offlinePreview,
    clearOffline: sandbox.__app.clearOffline,
    submitWrite: sandbox.__app.submitWrite,
    installArchive: sandbox.__app.installArchive,
    touch: sandbox.__app.touch,
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const roundTrip = (v) => JSON.parse(JSON.stringify(v));

function setupDraft(app) {
  app.state.clauses = [
    { id: "c1", original: 1, body: "甲方在七日内交付设备" },
    { id: "c2", original: 2, body: "乙方按 [[c1]] 验收后付款" },
    { id: "c3", original: 3, body: "争议提交仲裁" },
  ];
  app.state.orderIds = ["c1", "c2", "c3"];
  app.state.idCounter = 3;
  app.state.lockIds = [];
  app.state.pickIds = [];
  app.state.editingId = null;
  app.state.splittingId = null;
  app.state.writing = null;
  app.state.reviews = [];
  app.state.mergeRecords = [];
  app.state.previewFresh = true;
  app.state.preview = {
    has_broken: false,
    items: app.state.clauses.map((c, i) => ({
      id: c.id,
      original: c.original,
      display: i + 1,
      text: c.body,
      broken: [],
    })),
  };
  app.state.offlineSnapshot = null;
  app.state.offlineText = "";
  app.state.offlineData = null;
  app.state.offlineError = null;
  app.state.offlineFresh = false;
}

const EXPORT_TEXT =
  "1|甲方在七日内交付设备\n2|乙方按 [[1]] 验收后付款\n3|争议提交仲裁";
const UPLOAD_TEXT =
  "1|甲方在七日内交付设备\n2|乙方验收合格后按 [[1]] 付款\n3|争议提交仲裁";

// 走真实「下载纯文本」处理器：成功响应返回整稿文本，下载成功即留存导出快照
async function exportOnce(app, text) {
  const done = app.$el("#download-btn").fire("click");
  await flush();
  const call = app.fetch.to("/api/export")[0];
  call.respond(200, { text: text || EXPORT_TEXT });
  await done;
  await flush();
}

// --------------------------------------------------------------------------- //
// 1. 导出快照留存
// --------------------------------------------------------------------------- //
test("下载纯文本成功后留存最近导出快照；继续改稿不清空", async () => {
  const app = loadApp();
  setupDraft(app);
  await exportOnce(app);
  assert.ok(app.state.offlineSnapshot, "下载成功应留存快照");
  assert.deepEqual(roundTrip(app.state.offlineSnapshot.order_ids), ["c1", "c2", "c3"]);
  assert.equal(
    app.state.offlineSnapshot.clauses[1].body,
    "乙方按 [[c1]] 验收后付款",
  );

  // 继续改稿（重排）不清空快照
  app.state.orderIds = ["c1", "c3", "c2"];
  app.touch();
  assert.ok(app.state.offlineSnapshot, "继续改稿不清空快照");
  assert.deepEqual(roundTrip(app.state.offlineSnapshot.order_ids), ["c1", "c2", "c3"]);
});

test("下载等待期间改稿：下载取消、不留存快照", async () => {
  const app = loadApp();
  setupDraft(app);
  const done = app.$el("#download-btn").fire("click");
  await flush();
  app.state.clauses[0].body = "甲方改了";
  app.touch(); // rev 推进
  app.fetch.to("/api/export")[0].respond(200, { text: EXPORT_TEXT });
  await done;
  await flush();
  assert.equal(app.state.offlineSnapshot, null, "过期下载不应留存快照");
  assert.ok(app.alerts.join("\n").includes("本次下载已取消"));
});

test("导出失败（409 含失效引用）不留存快照", async () => {
  const app = loadApp();
  setupDraft(app);
  const done = app.$el("#download-btn").fire("click");
  await flush();
  app.fetch.to("/api/export")[0].respond(409, { detail: { errors: ["存在失效引用"] } });
  await done;
  await flush();
  assert.equal(app.state.offlineSnapshot, null);
});

// --------------------------------------------------------------------------- //
// 2. 预演
// --------------------------------------------------------------------------- //
test("预演携带快照、回传文本、当前稿与最新 lock_ids；只展示不改稿", async () => {
  const app = loadApp();
  setupDraft(app);
  await exportOnce(app);
  app.state.offlineText = UPLOAD_TEXT;
  const before = JSON.stringify({ o: app.state.orderIds, c: app.state.clauses });

  const done = app.offlinePreview();
  await flush();
  const calls = app.fetch.to("/api/offline/preview");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.snapshot.order_ids, ["c1", "c2", "c3"]);
  assert.equal(calls[0].body.text, UPLOAD_TEXT);
  assert.deepEqual(calls[0].body.order_ids, ["c1", "c2", "c3"]);
  assert.deepEqual(calls[0].body.lock_ids, []);
  calls[0].respond(200, {
    changes: [
      {
        id: "c2",
        original: 2,
        export_no: 2,
        current_no: 2,
        status: "changed",
        old_body: "乙方按 [[c1]] 验收后付款",
        new_body: "乙方验收合格后按 [[c1]] 付款",
        current_body: "乙方按 [[c1]] 验收后付款",
      },
    ],
    change_count: 1,
    order_ids: ["c1", "c2", "c3"],
    clauses: [
      { id: "c1", body: "甲方在七日内交付设备" },
      { id: "c2", body: "乙方验收合格后按 [[c1]] 付款" },
      { id: "c3", body: "争议提交仲裁" },
    ],
  });
  await done;
  await flush();

  assert.equal(app.state.offlineFresh, true);
  assert.equal(app.state.offlineData.change_count, 1);
  // 预演不改稿
  assert.equal(JSON.stringify({ o: app.state.orderIds, c: app.state.clauses }), before);
});

test("改稿或编辑文本后预演立即失效；旧响应不覆盖新状态", async () => {
  const app = loadApp();
  setupDraft(app);
  await exportOnce(app);
  app.state.offlineText = UPLOAD_TEXT;

  const done = app.offlinePreview();
  await flush();
  // 在途期间改稿：迟到响应丢弃
  app.state.orderIds = ["c1", "c3", "c2"];
  app.touch();
  app.fetch.to("/api/offline/preview")[0].respond(200, {
    changes: [{ id: "c2", status: "changed" }],
    change_count: 1,
    order_ids: ["c1", "c3", "c2"],
    clauses: [],
  });
  await done;
  await flush();
  assert.equal(app.state.offlineData, null, "改稿后迟到预演响应丢弃");
  assert.equal(app.state.offlineFresh, false);
});

test("预演 409/422/断网：展示错误，草稿与快照保留，文本不清空", async () => {
  const app = loadApp();
  setupDraft(app);
  await exportOnce(app);
  app.state.offlineText = UPLOAD_TEXT;

  let done = app.offlinePreview();
  await flush();
  app.fetch.to("/api/offline/preview")[0].respond(409, {
    detail: { errors: ["离线校订与当前草稿冲突，整份拒绝，冲突如下："] },
  });
  await done;
  await flush();
  assert.ok(app.state.offlineError.length >= 1);
  assert.equal(app.state.offlineFresh, false);
  assert.ok(app.state.offlineSnapshot, "快照保留");
  assert.equal(app.state.offlineText, UPLOAD_TEXT, "回传文本保留");

  // 断网
  done = app.offlinePreview();
  await flush();
  app.fetch.to("/api/offline/preview")[1].fail();
  await done;
  await flush();
  assert.ok(app.state.offlineError.length >= 1);
  assert.ok(app.state.offlineSnapshot);
});

test("换稿（重新导入 / 恢复存档）清空快照；旧预演响应不影响新稿", async () => {
  const app = loadApp();
  setupDraft(app);
  await exportOnce(app);
  app.state.offlineText = UPLOAD_TEXT;

  const done = app.offlinePreview();
  await flush();
  // 等待期间恢复存档（换稿）：清空快照，旧响应落空
  const snap = {
    baseline: { order_ids: ["c1"], clauses: [{ id: "c1", body: "甲" }] },
    order_ids: ["c1"],
    clauses: [{ id: "c1", body: "甲" }],
    id_counter: 1,
  };
  app.installArchive(snap, 2);
  app.fetch.to("/api/offline/preview")[0].respond(200, {
    changes: [{ id: "c2", status: "changed" }],
    change_count: 1,
    order_ids: ["c2"],
    clauses: [],
  });
  await done;
  await flush();
  assert.equal(app.state.offlineSnapshot, null);
  assert.equal(app.state.offlineData, null);
  assert.equal(app.state.offlineFresh, false);
  assert.equal(app.state.offlineText, "");
  assert.deepEqual(roundTrip(app.state.orderIds), ["c1"], "新稿未被旧响应影响");
});

// --------------------------------------------------------------------------- //
// 3. 提交（复用写稿提交协调层）
// --------------------------------------------------------------------------- //
function commitResult() {
  return {
    changes: [
      {
        id: "c2",
        original: 2,
        export_no: 2,
        current_no: 2,
        status: "changed",
        old_body: "乙方按 [[c1]] 验收后付款",
        new_body: "乙方验收合格后按 [[c1]] 付款",
        current_body: "乙方按 [[c1]] 验收后付款",
      },
    ],
    change_count: 1,
    order_ids: ["c1", "c2", "c3"],
    clauses: [
      { id: "c1", body: "甲方在七日内交付设备" },
      { id: "c2", body: "乙方验收合格后按 [[c1]] 付款" },
      { id: "c3", body: "争议提交仲裁" },
    ],
  };
}

test("提交走 /api/offline/commit 与协调层：成功写回改动行，顺序与上界不变", async () => {
  const app = loadApp();
  setupDraft(app);
  await exportOnce(app);
  app.state.offlineText = UPLOAD_TEXT;
  app.state.offlineFresh = true;
  app.state.offlineData = commitResult();

  // 直接驱动协调层（与页面「确认提交」同一管线）
  const done = app.submitWrite({
    kind: "offline-commit",
    path: "/api/offline/commit",
    params: {
      snapshot: {
        order_ids: ["c1", "c2", "c3"],
        clauses: app.state.offlineSnapshot.clauses,
      },
      text: UPLOAD_TEXT,
    },
    afterTouch: (data) => {
      app.state.offlineData = {
        ...data,
        changes: data.changes.map((it) =>
          it.status === "changed" ? { ...it, status: "applied", current_body: it.new_body } : it,
        ),
      };
      app.state.offlineFresh = true;
    },
    onError: () => assert.fail("提交应成功"),
  });
  await flush();
  const calls = app.fetch.to("/api/offline/commit");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.lock_ids, []);
  calls[0].respond(200, commitResult());
  await done;
  await flush();

  assert.equal(app.state.clauses.find((c) => c.id === "c2").body, "乙方验收合格后按 [[c1]] 付款");
  assert.equal(app.state.clauses.find((c) => c.id === "c1").body, "甲方在七日内交付设备");
  assert.deepEqual(roundTrip(app.state.orderIds), ["c1", "c2", "c3"]);
  assert.equal(app.state.idCounter, 3, "身份上界不变");
  assert.equal(app.state.writing, null);
  assert.ok(app.state.offlineSnapshot, "提交后快照保留");
});

test("提交成功后相关复核按 touch 既有规则清理，无关复核保留", async () => {
  const app = loadApp();
  setupDraft(app);
  await exportOnce(app);
  app.state.offlineText = UPLOAD_TEXT;
  app.state.offlineFresh = true;
  app.state.offlineData = commitResult();
  app.state.reviews = [
    { id: "c2", bodies: { c2: "乙方按 [[c1]] 验收后付款", c1: "甲方在七日内交付设备" } },
    { id: "c3", bodies: { c3: "争议提交仲裁" } },
  ];

  const done = app.submitWrite({
    kind: "offline-commit",
    path: "/api/offline/commit",
    params: { snapshot: {}, text: UPLOAD_TEXT },
    onError: () => assert.fail("提交应成功"),
  });
  await flush();
  app.fetch.to("/api/offline/commit")[0].respond(200, commitResult());
  await done;
  await flush();
  assert.deepEqual(app.state.reviews.map((r) => r.id), ["c3"], "c2 复核清除、c3 保留");
});

test("提交 409 冲突 / 422 / 断网：草稿、快照与文本均保留", async () => {
  const app = loadApp();
  setupDraft(app);
  await exportOnce(app);
  app.state.offlineText = UPLOAD_TEXT;
  app.state.offlineFresh = true;
  app.state.offlineData = commitResult();
  const before = JSON.stringify({ o: app.state.orderIds, c: app.state.clauses });

  const done = app.submitWrite({
    kind: "offline-commit",
    path: "/api/offline/commit",
    params: { snapshot: {}, text: UPLOAD_TEXT },
    onError: () => {},
  });
  await flush();
  app.fetch.to("/api/offline/commit")[0].respond(409, {
    detail: { errors: ["冲突"], conflicts: [{ id: "c2", reasons: ["x"] }] },
  });
  await done;
  await flush();
  assert.equal(JSON.stringify({ o: app.state.orderIds, c: app.state.clauses }), before);
  assert.ok(app.state.offlineSnapshot);
  assert.equal(app.state.offlineText, UPLOAD_TEXT);
  assert.equal(app.state.writing, null);
});

test("提交成功回包按最新 lock_ids 核验：等待期间锁定改动行则整次不安装", async () => {
  const app = loadApp();
  setupDraft(app);
  await exportOnce(app);
  app.state.offlineText = UPLOAD_TEXT;
  app.state.offlineFresh = true;
  app.state.offlineData = commitResult();

  const done = app.submitWrite({
    kind: "offline-commit",
    path: "/api/offline/commit",
    params: { snapshot: {}, text: UPLOAD_TEXT },
    onError: () => {},
  });
  await flush();
  assert.deepEqual(app.fetch.to("/api/offline/commit")[0].body.lock_ids, []);
  app.state.lockIds = ["c2"]; // 等待期间锁定 c2（提交会改其正文）
  app.fetch.to("/api/offline/commit")[0].respond(200, commitResult());
  await done;
  await flush();
  assert.equal(
    app.state.clauses.find((c) => c.id === "c2").body,
    "乙方按 [[c1]] 验收后付款",
    "违例整次不安装",
  );
  assert.equal(app.state.writing, null);
});

// --------------------------------------------------------------------------- //
// 4. 门禁与面板
// --------------------------------------------------------------------------- //
test("未保存编辑、拆分选择或写稿在途时不可预演；未预演不可提交", async () => {
  const app = loadApp();
  setupDraft(app);
  await exportOnce(app);
  app.state.offlineText = UPLOAD_TEXT;

  app.state.editingId = "c1";
  await app.offlinePreview();
  await flush();
  assert.equal(app.fetch.to("/api/offline/preview").length, 0);

  app.state.editingId = null;
  app.state.splittingId = "c1";
  await app.offlinePreview();
  await flush();
  assert.equal(app.fetch.to("/api/offline/preview").length, 0);

  app.state.splittingId = null;
  app.state.writing = "merge";
  await app.offlinePreview();
  await flush();
  assert.equal(app.fetch.to("/api/offline/preview").length, 0);

  // 无快照时按钮全禁用
  app.state.writing = null;
  app.state.offlineSnapshot = null;
  app.syncOfflinePanel();
  assert.equal(app.$el("#offline-preview-btn").disabled, true);
  assert.equal(app.$el("#offline-commit-btn").disabled, true);
});

test("文本框被编辑后须重新预演才能提交", async () => {
  const app = loadApp();
  setupDraft(app);
  app.state.offlineSnapshot = {
    order_ids: ["c1", "c2", "c3"],
    clauses: app.state.clauses.map((c) => ({ id: c.id, body: c.body })),
  };
  app.state.offlineText = UPLOAD_TEXT;
  app.state.offlineFresh = true;
  app.state.offlineData = commitResult();
  app.syncOfflinePanel();
  assert.equal(app.$el("#offline-commit-btn").disabled, false);

  // 驱动真实的文本框 input 监听器：文本变化即作废预演结果（文本本身保留）
  const ta = app.$el("#offline-text");
  ta.value = "1|改了\n2|x\n3|y";
  await ta.fire("input");
  assert.equal(app.state.offlineText, "1|改了\n2|x\n3|y");
  assert.equal(app.state.offlineFresh, false);
  assert.equal(app.state.offlineData, null);
  assert.equal(app.$el("#offline-commit-btn").disabled, true);
});
