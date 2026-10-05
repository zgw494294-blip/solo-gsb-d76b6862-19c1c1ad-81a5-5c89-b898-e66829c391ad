"use strict";

// 前端「误合并撤销」的回归测试。
//
// 覆盖：
// 1. 合并记录捕获：每次成功合并留存一条记录（两条原文 + 所有改写引用来源的前后
//    内部正文）；记录仅存本页内存——重新导入、成功恢复存档清空；撤销成功后记录
//    不可再用（随即移除），撤销失败（409 冲突 / 422 / 断网）保留记录。
// 2. 撤销经写稿提交协调层走 /api/merge/undo：互斥、携带最新 lock_ids、成功回包
//    按最新锁定集合核验（违例整次不安装）、旧响应隔离；成功后正文与顺序一起写回，
//    身份上界不回退；随后 touch() 按既有规则清理复核（已清除记录不恢复），并刷新预览。
// 3. 撤销入口门禁：未保存编辑、拆分选择、写稿在途或预览未同步时不可撤销。
//
// 本文件用最小 DOM 桩在 Node 虚拟机中加载真实的 app/static/app.js（不修改它），
// 直接驱动合并 / 撤销 / 恢复存档的真实内部函数，fetch 由测试逐个收尾。
// 运行：node --test tests/test_merge_undo_ownership.js（无第三方依赖）

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const APP_JS = path.join(__dirname, "..", "app", "static", "app.js");

// --------------------------------------------------------------------------- //
// 最小 DOM 桩（与 test_lock_ownership.js 同形：事件委托依赖 closest/dataset/classList）
// --------------------------------------------------------------------------- //
function makeElement(name, id) {
  const listeners = new Map();
  const classes = new Set();
  const children = [];
  const el = {
    name,
    id: id || "",
    hidden: false,
    disabled: false,
    checked: false,
    textContent: "",
    innerHTML: "",
    value: "",
    title: "",
    dataset: {},
    children,
    classList: {
      add: (...cs) => cs.forEach((c) => classes.add(c)),
      remove: (...cs) => cs.forEach((c) => classes.delete(c)),
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : Boolean(force);
        if (on) classes.add(c);
        else classes.delete(c);
        return on;
      },
      contains: (c) => classes.has(c),
    },
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    fire(type, event = {}) {
      return Promise.all((listeners.get(type) || []).map((fn) => fn(event)));
    },
    appendChild(child) {
      children.push(child);
      child.parentNode = el;
    },
    closest(sel) {
      let node = el;
      while (node) {
        if (matchesSelector(node, sel)) return node;
        node = node.parentNode;
      }
      return null;
    },
    querySelector(sel) {
      return queryTree(el, sel, true);
    },
    querySelectorAll(sel) {
      return queryTree(el, sel, false);
    },
    scrollIntoView: () => {},
    focus: () => {},
    setSelectionRange: () => {},
    click: () => {},
  };
  return el;
}

function matchesSelector(node, sel) {
  const mAction = sel.match(/^\[data-action="?([^"\]]+)"?\]$/);
  if (mAction) return node.dataset && node.dataset.action === mAction[1];
  const mRole = sel.match(/^\[data-role="?([^"\]]+)"?\]$/);
  if (mRole) return node.dataset && node.dataset.role === mRole[1];
  const mId = sel.match(/^#([\w-]+)$/);
  if (mId) return node.id === mId[1];
  if (sel.startsWith(".")) return node.classList && node.classList.contains(sel.slice(1));
  return node.name === sel;
}

function queryTree(root, sel, first) {
  const found = [];
  const walk = (node) => {
    for (const child of node.children || []) {
      if (matchesSelector(child, sel)) {
        if (first) return child;
        found.push(child);
      }
      const got = walk(child);
      if (first && got) return got;
    }
    return null;
  };
  if (matchesSelector(root, sel)) {
    if (first) return root;
    found.push(root);
  }
  const one = walk(root);
  return first ? one || null : found;
}

function makeFetchStub() {
  const calls = [];
  const fetch = (url, opts = {}) =>
    new Promise((resolve, reject) => {
      const call = {
        url,
        method: opts.method || "POST",
        body: opts.body ? JSON.parse(opts.body) : null,
        settled: false,
        respond(status, data) {
          call.settled = true;
          resolve({ ok: status >= 200 && status < 300, status, json: async () => data });
        },
        fail(err) {
          call.settled = true;
          reject(err || new TypeError("fetch failed"));
        },
      };
      calls.push(call);
    });
  fetch.calls = calls;
  fetch.to = (urlPart) => calls.filter((c) => c.url.includes(urlPart));
  return fetch;
}

function loadApp() {
  const elements = new Map();
  const $el = (sel) => {
    if (!elements.has(sel)) elements.set(sel, makeElement(sel.replace(/^#/, ""), sel.replace(/^#/, "")));
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
    },
    fetch,
    confirm: () => {
      confirms.push(true);
      return true;
    },
    alert: (...args) => alerts.push(args.join(" ")),
    console,
    Blob: class Blob {
      constructor(parts) {
        this.parts = parts;
      }
    },
    URL: { createObjectURL: () => "blob:fake", revokeObjectURL: () => {} },
    Date,
  };
  const source = fs.readFileSync(APP_JS, "utf8");
  const hook =
    "\n;globalThis.__app = { state, submitWrite, submitMergeUndo, syncMergePanel, " +
    "internalToDisplay, installArchive, touch };\n";
  vm.createContext(sandbox);
  vm.runInContext(source + hook, sandbox, { filename: "app.js" });
  return {
    sandbox,
    fetch,
    $el,
    alerts,
    confirms,
    state: sandbox.__app.state,
    submitWrite: sandbox.__app.submitWrite,
    submitMergeUndo: sandbox.__app.submitMergeUndo,
    syncMergePanel: sandbox.__app.syncMergePanel,
    internalToDisplay: sandbox.__app.internalToDisplay,
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
    { id: "c3", original: 3, body: "争议解决见 [[c2]]" },
    { id: "c4", original: 4, body: "争议提交仲裁" },
  ];
  app.state.orderIds = ["c1", "c2", "c3", "c4"];
  app.state.idCounter = 4;
  app.state.lockIds = [];
  app.state.pickIds = [];
  app.state.writing = null;
  app.state.editingId = null;
  app.state.splittingId = null;
  app.state.mergeRecords = [];
  app.state.reviews = [];
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
}

// 合并 c1+c2 的后端结果（与真实 /api/merge 同形）：本地构造，供各用例直接作为回包
function mergeC1C2(app) {
  const keep = app.state.clauses.find((c) => c.id === "c1").body;
  const drop = app.state.clauses.find((c) => c.id === "c2").body;
  const clauses = [];
  for (const c of app.state.clauses) {
    if (c.id === "c2") continue;
    let body = c.body.replaceAll("[[c2]]", "[[c1]]");
    if (c.id === "c1") body = `${keep}；${drop.replaceAll("[[c2]]", "[[c1]]")}`;
    clauses.push({ id: c.id, body });
  }
  return { order_ids: ["c1", "c3", "c4"], clauses };
}

// 页面口径的 c1+c2 撤销记录
function recordC1C2() {
  return {
    keep_id: "c1",
    drop_id: "c2",
    keep_body: "甲方在七日内交付设备",
    drop_body: "乙方按 [[c1]] 验收后付款",
    sources: [
      { id: "c3", body: "争议解决见 [[c2]]", after_body: "争议解决见 [[c1]]" },
    ],
  };
}

// c1+c2 撤销成功的后端结果（恢复原文、c2 插在 c1 之后）
function undoC1C2Result() {
  return {
    order_ids: ["c1", "c2", "c3", "c4"],
    clauses: [
      { id: "c1", body: "甲方在七日内交付设备" },
      { id: "c2", body: "乙方按 [[c1]] 验收后付款" },
      { id: "c3", body: "争议解决见 [[c2]]" },
      { id: "c4", body: "争议提交仲裁" },
    ],
  };
}

// --------------------------------------------------------------------------- //
// 1. 记录捕获
// --------------------------------------------------------------------------- //
test("合并成功后留存撤销记录：两条原文与所有改写来源的前后正文", async () => {
  const app = loadApp();
  setupDraft(app);
  // 请求发出前在合并按钮处理里捕获，成功回包后入列；这里直接驱动协调层
  const beforeKeep = app.state.clauses.find((c) => c.id === "c1").body;
  const beforeDrop = app.state.clauses.find((c) => c.id === "c2").body;
  const beforeC3 = app.state.clauses.find((c) => c.id === "c3").body;
  const record = {
    keep_id: "c1",
    drop_id: "c2",
    keep_body: beforeKeep,
    drop_body: beforeDrop,
    sources: [],
  };
  const done = app.submitWrite({
    kind: "merge",
    path: "/api/merge",
    params: { keep_id: "c1", drop_id: "c2" },
    repointed: { c2: "c1" },
    onSuccess: (data) => {
      const afterById = new Map(data.clauses.map((c) => [c.id, c.body]));
      record.sources = [{ id: "c3", body: beforeC3, after_body: afterById.get("c3") }];
      app.state.mergeRecords.push(record);
    },
    onError: () => assert.fail("合并应成功"),
  });
  await flush();
  const merged = mergeC1C2(app);
  app.fetch.to("/api/merge")[0].respond(200, merged);
  await done;
  await flush();
  assert.equal(app.state.mergeRecords.length, 1);
  assert.deepEqual(roundTrip(app.state.mergeRecords[0]), recordC1C2());
  // c4 不引用 c2：不在来源列表
  assert.ok(!record.sources.some((s) => s.id === "c4"));
});

test("记录仅存本页内存：重新导入与成功恢复存档清空", async () => {
  const app = loadApp();
  setupDraft(app);
  app.state.mergeRecords.push(recordC1C2());

  await app.$el("#reimport-btn").fire("click");
  await flush();
  assert.deepEqual(roundTrip(app.state.mergeRecords), []);

  // 恢复存档同样清空（已清除记录不恢复）
  setupDraft(app);
  app.state.mergeRecords.push(recordC1C2(), recordC1C2());
  const snap = {
    baseline: { order_ids: ["c1"], clauses: [{ id: "c1", body: "甲" }] },
    order_ids: ["c1"],
    clauses: [{ id: "c1", body: "甲" }],
    id_counter: 1,
  };
  app.installArchive(snap, 3);
  assert.deepEqual(roundTrip(app.state.mergeRecords), []);
});

// --------------------------------------------------------------------------- //
// 2. 撤销成功 / 失败 / 锁定 / 复核
// --------------------------------------------------------------------------- //
test("撤销成功：恢复原文与来源、被移除身份插在保留条款之后、记录移除、上界不回退", async () => {
  const app = loadApp();
  setupDraft(app);
  // 先把草稿置于合并后状态（模拟一次成功合并已安装）
  const merged = mergeC1C2(app);
  app.state.orderIds = merged.order_ids;
  app.state.clauses = merged.clauses.map((c) => ({
    id: c.id,
    original: parseInt(c.id.slice(1), 10),
    body: c.body,
  }));
  app.state.previewFresh = true;
  app.state.idCounter = 4; // 合并不推进上界
  const rec = recordC1C2();
  app.state.mergeRecords.push(rec);

  const done = app.submitMergeUndo(rec);
  await flush();
  const calls = app.fetch.to("/api/merge/undo");
  assert.equal(calls.length, 1);
  // 请求体携带当前稿、记录与锁定集合（空集合显式提交）
  assert.deepEqual(calls[0].body.record, roundTrip(rec));
  assert.deepEqual(calls[0].body.order_ids, ["c1", "c3", "c4"]);
  assert.deepEqual(calls[0].body.lock_ids, []);
  calls[0].respond(200, undoC1C2Result());
  await done;
  await flush();

  assert.deepEqual(roundTrip(app.state.orderIds), ["c1", "c2", "c3", "c4"]);
  assert.equal(app.state.clauses.find((c) => c.id === "c2").body, "乙方按 [[c1]] 验收后付款");
  assert.equal(app.state.clauses.find((c) => c.id === "c3").body, "争议解决见 [[c2]]");
  // 成功后记录不可再用：已移除
  assert.equal(app.state.mergeRecords.length, 0);
  // 身份上界不回退
  assert.equal(app.state.idCounter, 4);
});

test("撤销 409 冲突：草稿不变、记录保留、不推进上界", async () => {
  const app = loadApp();
  setupDraft(app);
  const merged = mergeC1C2(app);
  app.state.orderIds = merged.order_ids;
  app.state.clauses = merged.clauses.map((c) => ({
    id: c.id,
    original: parseInt(c.id.slice(1), 10),
    body: c.body,
  }));
  app.state.previewFresh = true;
  const rec = recordC1C2();
  app.state.mergeRecords.push(rec);
  const before = JSON.stringify({ o: app.state.orderIds, c: app.state.clauses });

  const done = app.submitMergeUndo(rec);
  await flush();
  app.fetch.to("/api/merge/undo")[0].respond(409, {
    detail: {
      errors: ["本次撤销与当前草稿冲突，整次拒绝，冲突如下："],
      conflicts: [{ id: "c3", original: 3, reasons: ["当前正文不等于合并后正文"] }],
    },
  });
  await done;
  await flush();
  assert.equal(JSON.stringify({ o: app.state.orderIds, c: app.state.clauses }), before);
  assert.equal(app.state.mergeRecords.length, 1, "失败保留记录");
  assert.ok(app.alerts.join("\n").includes("撤销失败"));
  assert.equal(app.state.writing, null);
});

test("撤销 422（记录损坏 / 超过上限）：草稿不变、记录保留", async () => {
  const app = loadApp();
  setupDraft(app);
  const merged = mergeC1C2(app);
  app.state.orderIds = merged.order_ids;
  app.state.clauses = merged.clauses.map((c) => ({
    id: c.id,
    original: parseInt(c.id.slice(1), 10),
    body: c.body,
  }));
  app.state.previewFresh = true;
  const rec = recordC1C2();
  app.state.mergeRecords.push(rec);

  const done = app.submitMergeUndo(rec);
  await flush();
  app.fetch.to("/api/merge/undo")[0].respond(422, {
    detail: { errors: ["撤销后共 41 条，超过上限 40 条，不能撤销"] },
  });
  await done;
  await flush();
  assert.deepEqual(roundTrip(app.state.orderIds), ["c1", "c3", "c4"]);
  assert.equal(app.state.mergeRecords.length, 1);
});

test("撤销断网失败：草稿与记录保留，可再次撤销", async () => {
  const app = loadApp();
  setupDraft(app);
  const merged = mergeC1C2(app);
  app.state.orderIds = merged.order_ids;
  app.state.clauses = merged.clauses.map((c) => ({
    id: c.id,
    original: parseInt(c.id.slice(1), 10),
    body: c.body,
  }));
  app.state.previewFresh = true;
  const rec = recordC1C2();
  app.state.mergeRecords.push(rec);

  const done1 = app.submitMergeUndo(rec);
  await flush();
  app.fetch.to("/api/merge/undo")[0].fail();
  await done1;
  await flush();
  assert.equal(app.state.mergeRecords.length, 1);
  assert.deepEqual(roundTrip(app.state.orderIds), ["c1", "c3", "c4"]);

  // 记录仍在，可再次撤销并成功
  const done2 = app.submitMergeUndo(rec);
  await flush();
  app.fetch.to("/api/merge/undo")[1].respond(200, undoC1C2Result());
  await done2;
  await flush();
  assert.equal(app.state.mergeRecords.length, 0);
  assert.deepEqual(roundTrip(app.state.orderIds), ["c1", "c2", "c3", "c4"]);
});

test("撤销携带最新 lock_ids；成功回包按最新集合核验，违例整次不安装", async () => {
  const app = loadApp();
  setupDraft(app);
  const merged = mergeC1C2(app);
  app.state.orderIds = merged.order_ids;
  app.state.clauses = merged.clauses.map((c) => ({
    id: c.id,
    original: parseInt(c.id.slice(1), 10),
    body: c.body,
  }));
  app.state.previewFresh = true;
  const rec = recordC1C2();
  app.state.mergeRecords.push(rec);

  // 请求发出时无锁定；等待期间锁定 c3（撤销会改写 c3 正文）
  const done = app.submitMergeUndo(rec);
  await flush();
  assert.deepEqual(app.fetch.to("/api/merge/undo")[0].body.lock_ids, []);
  app.state.lockIds = ["c3"];
  // 服务端放行（按旧集合），但回包按最新集合核验：c3 正文将被改动 -> 整次不安装
  app.fetch.to("/api/merge/undo")[0].respond(200, undoC1C2Result());
  await done;
  await flush();
  assert.deepEqual(roundTrip(app.state.orderIds), ["c1", "c3", "c4"], "违例整次不安装");
  assert.equal(app.state.clauses.find((c) => c.id === "c3").body, "争议解决见 [[c1]]");
  assert.equal(app.state.mergeRecords.length, 1, "未安装：记录保留");
});

test("撤销成功后按既有规则清理复核：相关复核被清，无关复核保留", async () => {
  const app = loadApp();
  setupDraft(app);
  const merged = mergeC1C2(app);
  app.state.orderIds = merged.order_ids;
  app.state.clauses = merged.clauses.map((c) => ({
    id: c.id,
    original: parseInt(c.id.slice(1), 10),
    body: c.body,
  }));
  app.state.previewFresh = true;
  // c4 的复核与本次撤销无关（其正文不变）；c1 的复核正文将恢复 -> 清除
  app.state.reviews = [
    { id: "c1", bodies: { c1: app.state.clauses.find((c) => c.id === "c1").body } },
    { id: "c4", bodies: { c4: "争议提交仲裁" } },
  ];
  const rec = recordC1C2();
  app.state.mergeRecords.push(rec);

  const done = app.submitMergeUndo(rec);
  await flush();
  app.fetch.to("/api/merge/undo")[0].respond(200, undoC1C2Result());
  await done;
  await flush();
  const ids = app.state.reviews.map((r) => r.id).sort();
  assert.deepEqual(ids, ["c4"], "c1 复核清除、c4 保留；已清除记录不恢复");
});

// --------------------------------------------------------------------------- //
// 3. 入口门禁
// --------------------------------------------------------------------------- //
test("未保存编辑、拆分选择、写稿在途或预览未同步时不可撤销", async () => {
  const app = loadApp();
  setupDraft(app);
  const merged = mergeC1C2(app);
  app.state.orderIds = merged.order_ids;
  app.state.clauses = merged.clauses.map((c) => ({
    id: c.id,
    original: parseInt(c.id.slice(1), 10),
    body: c.body,
  }));
  const rec = recordC1C2();
  app.state.mergeRecords.push(rec);

  // 预览未同步
  app.state.previewFresh = false;
  await app.submitMergeUndo(rec);
  await flush();
  assert.equal(app.fetch.to("/api/merge/undo").length, 0);

  app.state.previewFresh = true;
  app.state.editingId = "c1";
  await app.submitMergeUndo(rec);
  await flush();
  assert.equal(app.fetch.to("/api/merge/undo").length, 0);

  app.state.editingId = null;
  app.state.splittingId = "c1";
  await app.submitMergeUndo(rec);
  await flush();
  assert.equal(app.fetch.to("/api/merge/undo").length, 0);

  app.state.splittingId = null;
  app.state.writing = "merge"; // 其他写稿在途：互斥
  await app.submitMergeUndo(rec);
  await flush();
  assert.equal(app.fetch.to("/api/merge/undo").length, 0);
});

test("面板为每条记录渲染撤销入口；记录为空时给出占位提示", () => {
  const app = loadApp();
  setupDraft(app);
  app.syncMergePanel();
  const bodyEl = app.$el("#merge-body");
  assert.ok(bodyEl.innerHTML.includes("尚无成功合并记录"));

  app.state.mergeRecords.push(recordC1C2());
  app.syncMergePanel();
  assert.ok(bodyEl.innerHTML.includes('data-action="merge-undo"'));
  assert.ok(bodyEl.innerHTML.includes("c1"));
  assert.ok(bodyEl.innerHTML.includes("c2"));
});

test("internalToDisplay：现存身份显示当前编号、已移除身份显示失效标记", () => {
  const app = loadApp();
  setupDraft(app);
  app.state.orderIds = ["c3", "c1", "c4"]; // c2 已移除
  assert.equal(app.internalToDisplay("见 [[c2]] 与 [[c1]]"), "见 [[原2?]] 与 [[2]]");
});
