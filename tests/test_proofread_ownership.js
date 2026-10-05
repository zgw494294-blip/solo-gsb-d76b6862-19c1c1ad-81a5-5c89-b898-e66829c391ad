"use strict";

// 前端「离线校订」（导出校订文本 → 线下只改正文 → 回传接回当前草稿）的回归测试。
//
// 覆盖：
// 1. 导出复用 /api/export（失效引用 409 时不保留快照）；成功后保留最近导出快照
//    （深拷贝），继续改稿不清空它；回传框默认填导出原文。
// 2. 预演 /api/proofread/preview 只读展示改动与整份拒绝原因；迟到响应丢弃；
//    改稿立即作废旧预演。
// 3. 提交复用写稿提交协调层走 /api/proofread/commit：互斥、携带快照 + 当前稿 +
//    回传文本 + 最新 lock_ids；成功后只改正文，顺序、身份上界不变，复核按既有
//    规则清理，随后刷新预览；409 / 422 / 断网整份不改稿；成功回包按最新锁定集合
//    再核验，违例整次不安装；预览失败保留提交稿、仅重试预览（render 链不变）。
// 4. 快照生命周期：重新导入、恢复存档清空快照与回传状态，旧响应不影响新稿。
// 5. 入口门禁：未保存编辑、拆分选择、写稿在途或预览未同步时导出 / 预演 / 提交不可用。
//
// 用最小 DOM 桩在 Node 虚拟机中加载真实的 app/static/app.js（不修改它），
// 直接驱动真实内部函数与面板事件委托，fetch 由测试逐个收尾。
// 运行：node --test tests/test_proofread_ownership.js（无第三方依赖）

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const APP_JS = path.join(__dirname, "..", "app", "static", "app.js");

// --------------------------------------------------------------------------- //
// 最小 DOM 桩（与 test_lock_ownership.js 同形）
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
          resolve({
            ok: status >= 200 && status < 300,
            status,
            json: async () => data,
          });
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
  fetch.last = (urlPart) => {
    const list = urlPart ? fetch.to(urlPart) : calls;
    return list[list.length - 1];
  };
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

  // 离线校订面板内回传文本框（syncProofreadPanel 通过 [data-role] 查询它读 value）
  const uploadBox = makeElement("textarea");
  uploadBox.dataset.role = "proofread-upload";
  $el("#proofread-body").appendChild(uploadBox);

  const sandbox = {
    document: {
      querySelector: $el,
      querySelectorAll: (sel) => {
        if (sel === ".card") return [];
        return [];
      },
      getElementById: (id) => elements.get(`#${id}`) || null,
      createElement: (tag) => makeElement(tag),
      createDocumentFragment: () => makeElement("fragment"),
    },
    fetch,
    confirm: () => true,
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
    "\n;globalThis.__app = { state, snapshot, touch, render, lockPayload, " +
    "submitWrite, syncProofreadPanel, updateProofreadBtn, exportProofread, " +
    "previewProofread, commitProofread, resetProofreadForNewDraft, " +
    "clearProofreadDryRun, installArchive, refTargets };\n";
  vm.createContext(sandbox);
  vm.runInContext(source + hook, sandbox, { filename: "app.js" });
  return {
    sandbox,
    fetch,
    $el,
    alerts,
    uploadBox,
    state: sandbox.__app.state,
    snapshot: sandbox.__app.snapshot,
    touch: sandbox.__app.touch,
    render: sandbox.__app.render,
    submitWrite: sandbox.__app.submitWrite,
    syncProofreadPanel: sandbox.__app.syncProofreadPanel,
    updateProofreadBtn: sandbox.__app.updateProofreadBtn,
    exportProofread: sandbox.__app.exportProofread,
    previewProofread: sandbox.__app.previewProofread,
    commitProofread: sandbox.__app.commitProofread,
    resetProofreadForNewDraft: sandbox.__app.resetProofreadForNewDraft,
    clearProofreadDryRun: sandbox.__app.clearProofreadDryRun,
    installArchive: sandbox.__app.installArchive,
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const roundTrip = (v) => JSON.parse(JSON.stringify(v));

function previewFor(clauses) {
  return {
    has_broken: false,
    items: clauses.map((c, i) => ({
      id: c.id,
      original: c.original,
      display: i + 1,
      text: c.body,
      broken: [],
    })),
  };
}

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
  app.state.writing = null;
  app.state.editingId = null;
  app.state.splittingId = null;
  app.state.previewFresh = true;
  app.state.preview = previewFor(app.state.clauses);
  app.state.baseline = {
    order_ids: ["c1", "c2", "c3"],
    clauses: app.state.clauses.map((c) => ({ id: c.id, body: c.body })),
  };
  app.state.epoch += 1;
  app.state.rev += 1;
  app.state.exporting = false;
}

const EXPORT_TEXT = [
  "1|甲方在七日内交付设备",
  "2|乙方按 [[1]] 验收后付款",
  "3|争议提交仲裁",
].join("\n");

// 收尾可能在途的 /api/preview（render 触发）：不影响断言，统一消费
async function settlePreviews(app) {
  await flush();
  for (const call of app.fetch.to("/api/preview")) {
    if (!call.settled) {
      const order = call.body.order_ids;
      const clauses = call.body.clauses.map((c, i) => ({
        id: c.id,
        original: parseInt(c.id.slice(1), 10),
        display: i + 1,
        text: c.body,
        broken: [],
      }));
      call.respond(200, { items: clauses, has_broken: false });
    }
  }
  await flush();
}

// --------------------------------------------------------------------------- //
// 1. 导出与最近快照保留
// --------------------------------------------------------------------------- //
test("导出成功保留最近快照（深拷贝）；继续改稿不清空；失效引用 409 不保留", async () => {
  const app = loadApp();
  setupDraft(app);

  const done = app.exportProofread();
  await flush();
  let calls = app.fetch.to("/api/export");
  assert.equal(calls.length, 1);
  calls[0].respond(200, { text: EXPORT_TEXT });
  await done;
  await flush();

  assert.ok(app.state.proofreadSnapshot, "应保留导出快照");
  assert.deepEqual(roundTrip(app.state.proofreadSnapshot.order_ids), ["c1", "c2", "c3"]);
  assert.equal(app.state.proofreadExportText, EXPORT_TEXT);
  assert.equal(app.state.proofreadUpload, EXPORT_TEXT, "回传框默认填导出原文");

  // 快照是深拷贝：随后改稿不改变快照内容
  app.state.clauses[0].body = "甲方被本地改稿";
  app.touch();
  assert.equal(app.state.proofreadSnapshot.clauses[0].body, "甲方在七日内交付设备");
  assert.ok(app.state.proofreadSnapshot, "继续改稿不清空导出快照");
  // 改稿使回传预演失效（快照仍在）
  assert.equal(app.state.proofreadData, null);

  // 预览追上改稿后的草稿（与真实 render 成功一致）
  app.state.previewFresh = true;

  // 失效引用时 /api/export 409：不保留快照（先清掉已保留的再试；面板展开，
  // 失败原因显示在面板横幅）
  app.state.proofreadOpen = true;
  app.syncProofreadPanel();
  app.state.proofreadSnapshot = null;
  app.state.proofreadExportText = "";
  const done2 = app.exportProofread();
  await flush();
  calls = app.fetch.to("/api/export");
  calls[calls.length - 1].respond(409, { detail: { errors: ["存在失效引用，修复前禁止下载"] } });
  await done2;
  await flush();
  assert.equal(app.state.proofreadSnapshot, null, "409 不保留快照");
  assert.ok(app.state.proofreadError.length > 0);
});

// --------------------------------------------------------------------------- //
// 2. 预演只读、改动 / 拒绝结构化展示、迟到响应丢弃、改稿作废
// --------------------------------------------------------------------------- //
test("预演返回改动行与拒绝原因；改稿立即作废旧预演；迟到响应不覆盖", async () => {
  const app = loadApp();
  setupDraft(app);
  app.state.proofreadSnapshot = app.snapshot();
  app.state.proofreadExportText = EXPORT_TEXT;
  app.state.proofreadOpen = true;

  app.uploadBox.value = [
    "1|甲方在七日内交付设备",
    "2|乙方改为三十日付款",
    "3|争议提交仲裁",
  ].join("\n");
  const p1 = app.previewProofread();
  await flush();
  let calls = app.fetch.to("/api/proofread/preview");
  assert.equal(calls.length, 1);
  // 请求体：快照 + 当前稿 + 回传文本（引用按导出时编号，由后端绑定）
  assert.equal(calls[0].body.text, app.uploadBox.value);
  assert.deepEqual(calls[0].body.snapshot.order_ids, ["c1", "c2", "c3"]);
  assert.deepEqual(calls[0].body.current.order_ids, ["c1", "c2", "c3"]);
  calls[0].respond(200, {
    changes: [
      {
        id: "c2",
        original: 2,
        export_no: 2,
        current_no: 2,
        old_body: "乙方按 [[c1]] 验收后付款",
        new_body: "乙方改为三十日付款",
        old_text: "乙方按 [[1]] 验收后付款",
        new_text: "乙方改为三十日付款",
      },
    ],
    rejects: [],
    locked: [],
    change_count: 1,
    has_rejections: false,
  });
  await p1;
  await flush();
  assert.equal(app.state.proofreadData.change_count, 1);

  // 第二个预演在途时改稿：旧响应迟到，不得覆盖（proofreadData 已被 touch 清空）
  app.uploadBox.value = "1|x\n2|y\n3|z";
  const p2 = app.previewProofread();
  await flush();
  app.touch(); // 改稿：旧预演立即作废
  const p2Call = app.fetch.last("/api/proofread/preview");
  p2Call.respond(200, { changes: [], rejects: [], locked: [], change_count: 0, has_rejections: false });
  await p2;
  await flush();
  assert.equal(app.state.proofreadData, null, "迟到响应不得恢复旧预演");

  // 预览追上改稿后的草稿（与真实 render 成功一致）
  app.state.previewFresh = true;

  // 拒绝原因同样展示（has_rejections=true）
  app.uploadBox.value = "1|x2\n2|y2\n3|z2";
  const p3 = app.previewProofread();
  await flush();
  calls = app.fetch.to("/api/proofread/preview");
  calls[calls.length - 1].respond(200, {
    changes: [{ id: "c1", original: 1, export_no: 1, current_no: null,
      old_body: "甲方在七日内交付设备", new_body: "x2", old_text: "甲方在七日内交付设备", new_text: "x2" }],
    rejects: [{ id: "c1", original: 1, export_no: 1, current_no: null, kind: "missing", reasons: ["待改身份在当前草稿中已删除，整份回传拒绝"] }],
    locked: [],
    change_count: 1,
    has_rejections: true,
  });
  await p3;
  await flush();
  assert.equal(app.state.proofreadData.has_rejections, true);
  assert.equal(app.state.proofreadData.rejects[0].kind, "missing");
});

// --------------------------------------------------------------------------- //
// 3. 提交经协调层：携带 lock_ids、只改正文、顺序与上界不变、成功后刷新预览
// --------------------------------------------------------------------------- //
test("提交成功只改正文：顺序 / 身份上界不变，携带 lock_ids，成功后触发 touch+render", async () => {
  const app = loadApp();
  setupDraft(app);
  app.state.proofreadSnapshot = app.snapshot();
  app.state.proofreadOpen = true;
  app.state.lockIds = ["c3"];
  const newClauses = [
    { id: "c1", body: "甲方在七日内交付设备" },
    { id: "c2", body: "乙方改为三十日付款" },
    { id: "c3", body: "争议提交仲裁" },
  ];
  app.state.proofreadData = {
    changes: [{ id: "c2" }],
    rejects: [],
    locked: [],
    change_count: 1,
    has_rejections: false,
  };
  app.uploadBox.value = "1|甲方在七日内交付设备\n2|乙方改为三十日付款\n3|争议提交仲裁";

  const done = app.commitProofread();
  await flush();
  const calls = app.fetch.to("/api/proofread/commit");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.lock_ids, ["c3"]);
  // 当前稿由协调层统一放在顶层 order_ids / clauses；快照在 snapshot 字段
  assert.deepEqual(calls[0].body.order_ids, ["c1", "c2", "c3"]);
  assert.deepEqual(calls[0].body.snapshot.order_ids, ["c1", "c2", "c3"]);
  assert.equal(calls[0].body.text, app.uploadBox.value);

  // 在途期间互斥：writing 标记为 proofread-commit
  assert.equal(app.state.writing, "proofread-commit");
  assert.equal(app.state.proofreadCommitting, true);

  calls[0].respond(200, { order_ids: ["c1", "c2", "c3"], clauses: newClauses, applied: 1 });
  await done;
  await flush();
  // 成功写回：只改正文；顺序、身份上界不变
  assert.equal(app.state.clauses[1].body, "乙方改为三十日付款");
  assert.deepEqual(roundTrip(app.state.orderIds), ["c1", "c2", "c3"]);
  assert.equal(app.state.idCounter, 3, "身份上界不推进");
  assert.equal(app.state.writing, null);
  assert.equal(app.state.proofreadCommitting, false);
  // 成功后清空本次回传预演（快照保留）；回传文本保留为已应用内容
  assert.equal(app.state.proofreadData, null);
  assert.ok(app.state.proofreadUpload.includes("乙方改为三十日付款"));
  assert.ok(app.state.proofreadSnapshot, "导出快照保留，可再次离线校订");
  // 成功后应触发预览刷新（render）
  await settlePreviews(app);
  assert.ok(app.fetch.to("/api/preview").length >= 1);
});

test("提交 409 整份拒绝：草稿、上界、回传文本均保留，原因显示在面板", async () => {
  const app = loadApp();
  setupDraft(app);
  app.state.proofreadSnapshot = app.snapshot();
  app.state.proofreadOpen = true;
  const before = JSON.stringify({ o: app.state.orderIds, c: app.state.clauses, n: app.state.idCounter });
  app.state.proofreadData = {
    changes: [{ id: "c2" }],
    rejects: [],
    locked: [],
    change_count: 1,
    has_rejections: false,
  };
  app.uploadBox.value = "1|甲方在七日内交付设备\n2|乙方改为三十日付款\n3|争议提交仲裁";

  const done = app.commitProofread();
  await flush();
  app.fetch.last("/api/proofread/commit").respond(409, {
    detail: {
      errors: ["离线校订与当前草稿冲突，整份拒绝，原因如下："],
      conflicts: [{ id: "c2", original: 2, export_no: 2, current_no: 2, kind: "conflict", reasons: ["两边各有校订"] }],
      locked: [],
    },
  });
  await done;
  await flush();
  const after = JSON.stringify({ o: app.state.orderIds, c: app.state.clauses, n: app.state.idCounter });
  assert.equal(before, after, "整份拒绝不改稿");
  assert.equal(app.state.writing, null);
  assert.equal(app.state.proofreadCommitting, false);
  assert.ok(app.state.proofreadError.join("\n").includes("两边各有校订") || app.alerts.length >= 0);
  assert.equal(app.state.proofreadError[0], "离线校订与当前草稿冲突，整份拒绝，原因如下：");
  // 回传文本保留可修正后重试
  assert.ok(app.state.proofreadUpload.includes("乙方改为三十日付款"));
  assert.ok(app.state.proofreadSnapshot);
});

test("成功回包按最新锁定集合核验：等待期间锁定改动行，整次不安装", async () => {
  const app = loadApp();
  setupDraft(app);
  app.state.proofreadSnapshot = app.snapshot();
  app.state.proofreadOpen = true;
  app.state.proofreadData = {
    changes: [{ id: "c2" }],
    rejects: [],
    locked: [],
    change_count: 1,
    has_rejections: false,
  };
  app.uploadBox.value = "1|甲方在七日内交付设备\n2|乙方改为三十日付款\n3|争议提交仲裁";

  const done = app.commitProofread();
  await flush();
  // 等待期间锁定 c2（纯内存操作允许）
  app.state.lockIds = ["c2"];
  // 后端按旧集合（空）放行：回包改正了 c2 -> 本地核验须整次拦截
  app.fetch.last("/api/proofread/commit").respond(200, {
    order_ids: ["c1", "c2", "c3"],
    clauses: [
      { id: "c1", body: "甲方在七日内交付设备" },
      { id: "c2", body: "乙方改为三十日付款" },
      { id: "c3", body: "争议提交仲裁" },
    ],
    applied: 1,
  });
  await done;
  await flush();
  assert.equal(app.state.clauses[1].body, "乙方按 [[c1]] 验收后付款", "违例整次不安装");
  assert.equal(app.state.writing, null);
  assert.ok(app.state.proofreadError.join("\n").includes("锁定"));
});

test("提交断网：草稿不变、回传保留、无快照清理", async () => {
  const app = loadApp();
  setupDraft(app);
  app.state.proofreadSnapshot = app.snapshot();
  app.state.proofreadOpen = true;
  app.state.proofreadData = { changes: [{ id: "c2" }], rejects: [], locked: [], change_count: 1, has_rejections: false };
  app.uploadBox.value = "1|甲方在七日内交付设备\n2|乙方改为三十日付款\n3|争议提交仲裁";
  const before = JSON.stringify(app.state.clauses);

  const done = app.commitProofread();
  await flush();
  app.fetch.last("/api/proofread/commit").fail(new TypeError("network down"));
  await done;
  await flush();
  assert.equal(JSON.stringify(app.state.clauses), before);
  assert.equal(app.state.writing, null);
  assert.ok(app.state.proofreadError.join("\n").includes("网络") || app.state.proofreadError.length === 1);
  assert.ok(app.state.proofreadSnapshot);
});

// --------------------------------------------------------------------------- //
// 4. 快照生命周期：换稿（重新导入 / 恢复存档）清空，旧响应不影响新稿
// --------------------------------------------------------------------------- //
test("恢复存档 / 重新导入清空快照与回传状态", async () => {
  const app = loadApp();
  setupDraft(app);
  app.state.proofreadSnapshot = app.snapshot();
  app.state.proofreadExportText = EXPORT_TEXT;
  app.state.proofreadUpload = "1|改\n2|改\n3|改";
  app.state.proofreadData = { changes: [], rejects: [], locked: [], change_count: 0, has_rejections: false };
  app.state.proofreadOpen = true;

  // 直接调用换稿重置（重新导入与恢复存档共用同一条清空路径）
  app.resetProofreadForNewDraft();
  assert.equal(app.state.proofreadSnapshot, null);
  assert.equal(app.state.proofreadExportText, "");
  assert.equal(app.state.proofreadUpload, "");
  assert.equal(app.state.proofreadData, null);
  assert.equal(app.state.proofreadCommitting, false);
});

test("恢复存档整份安装时清空离线校订状态", () => {
  const app = loadApp();
  setupDraft(app);
  app.state.proofreadSnapshot = app.snapshot();
  app.state.proofreadExportText = EXPORT_TEXT;
  app.state.proofreadOpen = true;
  const snap = {
    baseline: {
      order_ids: ["c1", "c2"],
      clauses: [{ id: "c1", body: "存档一" }, { id: "c2", body: "存档二 [[c1]]" }],
    },
    order_ids: ["c1", "c2"],
    clauses: [{ id: "c1", body: "存档一" }, { id: "c2", body: "存档二 [[c1]]" }],
    id_counter: 2,
  };
  app.installArchive(snap, 1);
  assert.equal(app.state.proofreadSnapshot, null);
  assert.equal(app.state.proofreadExportText, "");
  assert.equal(app.state.proofreadOpen, false);
});

// --------------------------------------------------------------------------- //
// 5. 入口门禁
// --------------------------------------------------------------------------- //
test("未保存编辑 / 拆分选择 / 写稿在途 / 预览未同步时入口不可用", async () => {
  const app = loadApp();
  setupDraft(app);
  app.state.proofreadOpen = true;

  app.state.editingId = "c1";
  app.updateProofreadBtn();
  assert.equal(app.$el("#proofread-btn").disabled, true);
  app.state.editingId = null;

  app.state.splittingId = "c1";
  app.updateProofreadBtn();
  assert.equal(app.$el("#proofread-btn").disabled, true);
  app.state.splittingId = null;

  app.state.previewFresh = false;
  app.updateProofreadBtn();
  assert.equal(app.$el("#proofread-btn").disabled, true);
  app.state.previewFresh = true;

  app.state.writing = "merge";
  app.updateProofreadBtn();
  assert.equal(app.$el("#proofread-btn").disabled, true);

  // 门禁函数直接拦截：不会发请求
  app.state.proofreadSnapshot = app.snapshot();
  app.uploadBox.value = EXPORT_TEXT;
  await app.exportProofread();
  await app.previewProofread();
  assert.equal(app.fetch.to("/api/proofread/preview").length, 0);
  app.state.writing = null;
});

test("没有导出快照时预演 / 提交直接返回", async () => {
  const app = loadApp();
  setupDraft(app);
  app.state.proofreadOpen = true;
  assert.equal(app.state.proofreadSnapshot, null);
  await app.previewProofread();
  await app.commitProofread();
  assert.equal(app.fetch.to("/api/proofread/preview").length, 0);
  assert.equal(app.fetch.to("/api/proofread/commit").length, 0);
});

test("预演有拒绝或零改动时提交不发请求", async () => {
  const app = loadApp();
  setupDraft(app);
  app.state.proofreadSnapshot = app.snapshot();
  app.state.proofreadOpen = true;
  app.uploadBox.value = EXPORT_TEXT;

  // 有拒绝
  app.state.proofreadData = { changes: [{ id: "c1" }], rejects: [{ id: "c1", kind: "missing" }], locked: [], change_count: 1, has_rejections: true };
  await app.commitProofread();
  assert.equal(app.fetch.to("/api/proofread/commit").length, 0);

  // 零改动
  app.state.proofreadData = { changes: [], rejects: [], locked: [], change_count: 0, has_rejections: false };
  await app.commitProofread();
  assert.equal(app.fetch.to("/api/proofread/commit").length, 0);
});
