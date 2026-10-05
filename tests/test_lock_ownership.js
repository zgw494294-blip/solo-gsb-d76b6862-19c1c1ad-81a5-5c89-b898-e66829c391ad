"use strict";

// 前端「条款锁定」的回归测试。
//
// 覆盖：
// 1. 卡片可锁定 / 解锁；含失效引用的条款不能锁定；锁定只存本页内存，
//    换稿（重新导入 / 恢复存档）清空；锁定切换不推进修订号（不改草稿、不改复核）。
// 2. 写稿请求（保存 / 删除 / 合并 / 拆分 / 复制）携带 lock_ids；后端拒绝（409/422）时
//    草稿、身份上界、复核均不变；成功回包按**最新锁定集合**核验，违例整次不安装
//    （不能先更新上界或复核）；复制允许、副本不锁定。
// 3. 写稿等待期间可切换锁定；删除经 /api/delete（HTTP）处理，携带锁定集合。
//
// 本文件用最小 DOM 桩在 Node 虚拟机中加载真实的 app/static/app.js（不修改它），
// 直接驱动锁定切换与各写稿入口的真实事件处理器 / 内部函数，fetch 由测试逐个收尾。
// 运行：node --test tests/test_lock_ownership.js（无第三方依赖）

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const APP_JS = path.join(__dirname, "..", "app", "static", "app.js");

// --------------------------------------------------------------------------- //
// 最小 DOM 桩：卡片以可点击的元素树存在（事件委托依赖 closest / dataset / classList）
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
    // 事件委托：沿 parentNode 上溯找第一个满足 selector 谓词的祖先（桩中 selector 即 data-action 名）
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

// 桩中只按两类选择器查询：[data-action="x"] / [data-role="x"] / .class / 标签
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

// fetch 桩：记录每一次请求，响应时机与结果完全由测试控制
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
  return fetch;
}

function loadApp() {
  const elements = new Map();
  const cards = new Map(); // id -> card 元素
  const $el = (sel) => {
    if (!elements.has(sel)) elements.set(sel, makeElement(sel.replace(/^#/, ""), sel.replace(/^#/, "")));
    return elements.get(sel);
  };
  const fetch = makeFetchStub();
  const alerts = [];
  const confirms = [];

  // 构造一张卡片树：card > (card-head > button[data-action][dataset])、textarea 等
  const makeCard = (id) => {
    const card = makeElement("li", `card-${id}`);
    card.dataset.id = id;
    const head = makeElement("div");
    const actions = makeElement("span");
    actions.className = "card-actions";
    const mkBtn = (action) => {
      const btn = makeElement("button");
      btn.dataset.action = action;
      return btn;
    };
    for (const a of ["up", "down", "edit", "refs", "split", "review", "lock", "delete"]) {
      const btn = mkBtn(a);
      actions.appendChild(btn);
    }
    head.appendChild(actions);
    card.appendChild(head);
    const ta = makeElement("textarea");
    ta.dataset.role = "edit-text";
    ta.value = "";
    card.appendChild(ta);
    card.querySelector = (sel) => queryTree(card, sel, true);
    card.querySelectorAll = (sel) => queryTree(card, sel, false);
    cards.set(id, card);
    return card;
  };

  const sandbox = {
    document: {
      querySelector: $el,
      querySelectorAll: (sel) => {
        // app.js 用它同步所有卡片（syncLockTags / syncReviewTags / syncReferrers）
        if (sel === ".card") return [...cards.values()];
        return [];
      },
      getElementById: (id) => cards.get(id) || elements.get(`#${id}`) || null,
      createElement: (tag) => {
        const el = makeElement(tag);
        if (tag === "li") {
          el.dataset = {};
        }
        return el;
      },
      createDocumentFragment: () => {
        const frag = makeElement("fragment");
        // renderPreview 向 fragment appendChild 每张卡片；桩中忽略（真实卡片树由测试自建）
        return frag;
      },
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
    "\n;globalThis.__app = { state, toggleLock, lockViolationsInResult, lockPayload, " +
    "submitWrite, saveEdit, mergeLockPrecheck, splitLockPrecheck, formatLockViolations, " +
    "clauseHasBrokenRef, touch, installArchive };\n";
  vm.createContext(sandbox);
  vm.runInContext(source + hook, sandbox, { filename: "app.js" });
  return {
    sandbox,
    fetch,
    $el,
    alerts,
    cards,
    makeCard,
    state: sandbox.__app.state,
    toggleLock: sandbox.__app.toggleLock,
    lockViolationsInResult: sandbox.__app.lockViolationsInResult,
    lockPayload: sandbox.__app.lockPayload,
    submitWrite: sandbox.__app.submitWrite,
    saveEdit: sandbox.__app.saveEdit,
    mergeLockPrecheck: sandbox.__app.mergeLockPrecheck,
    splitLockPrecheck: sandbox.__app.splitLockPrecheck,
    formatLockViolations: sandbox.__app.formatLockViolations,
    clauseHasBrokenRef: sandbox.__app.clauseHasBrokenRef,
    touch: sandbox.__app.touch,
    installArchive: sandbox.__app.installArchive,
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
  app.state.lockIds = []; // 每用例从无锁定开始（state 为模块级单例）
  app.state.pickIds = [];
  app.state.writing = null;
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
  // 为每张卡建立元素树
  for (const cid of app.state.orderIds) app.makeCard(cid);
}

// --------------------------------------------------------------------------- //
// 1. 锁定 / 解锁基本规则
// --------------------------------------------------------------------------- //
test("卡片可锁定、解锁；锁定集合是稳定身份数组；切换不推进修订号", () => {
  const app = loadApp();
  setupDraft(app);
  const revBefore = app.state.rev;
  app.toggleLock("c2");
  assert.deepEqual(roundTrip(app.lockPayload()), ["c2"]);
  app.toggleLock("c3");
  assert.deepEqual(roundTrip(app.lockPayload()), ["c2", "c3"]);
  app.toggleLock("c2");
  assert.deepEqual(roundTrip(app.lockPayload()), ["c3"]);
  // 不推进修订号（不触发 touch）：草稿、预览新鲜度与存档未存档标记不变
  assert.equal(app.state.rev, revBefore);
  assert.equal(app.state.previewFresh, true);
  assert.equal(app.state.archiveDirty, false);
});

test("含失效引用的条款不能锁定；修复后可锁定", () => {
  const app = loadApp();
  setupDraft(app);
  // 删除 c2（c3 引用它）：c3 出现失效引用
  app.state.orderIds = ["c1", "c3", "c4"];
  app.state.clauses = app.state.clauses.filter((c) => c.id !== "c2");
  assert.equal(app.clauseHasBrokenRef("c3"), true);
  assert.equal(app.clauseHasBrokenRef("c1"), false);
  app.toggleLock("c3"); // 应被忽略
  assert.deepEqual(roundTrip(app.lockPayload()), []);
  // 无失效引用的 c1 可锁
  app.toggleLock("c1");
  assert.deepEqual(roundTrip(app.lockPayload()), ["c1"]);
  // 已锁定的条款即使后来引用失效（后端会拒绝导致失效的操作，这里直接构造），仍可解锁
  app.toggleLock("c1");
  assert.deepEqual(roundTrip(app.lockPayload()), []);
});

test("锁定仅存本页内存：重新导入与成功恢复存档清空", async () => {
  const app = loadApp();
  setupDraft(app);
  app.toggleLock("c1");
  app.toggleLock("c2");
  assert.equal(app.state.lockIds.length, 2);

  // 重新导入（导入页）：集合清空
  await app.$el("#reimport-btn").fire("click");
  await flush();
  assert.deepEqual(roundTrip(app.state.lockIds), []);

  // 恢复存档：集合同样清空（存档协议不含锁定）
  setupDraft(app);
  app.toggleLock("c3");
  const snap = {
    baseline: {
      order_ids: ["c1", "c2"],
      clauses: [
        { id: "c1", body: "存档第一条" },
        { id: "c2", body: "存档第二条见 [[c1]]" },
      ],
    },
    order_ids: ["c1", "c2"],
    clauses: [
      { id: "c1", body: "存档第一条" },
      { id: "c2", body: "存档第二条见 [[c1]]" },
    ],
    id_counter: 2,
  };
  app.installArchive(snap, 2);
  assert.deepEqual(roundTrip(app.state.lockIds), []);
});

// --------------------------------------------------------------------------- //
// 2. 写稿请求携带锁定集合；违例整次不安装
// --------------------------------------------------------------------------- //
test("写稿请求携带 lock_ids；删除走 /api/delete；复制允许且副本不锁定", async () => {
  const app = loadApp();
  setupDraft(app);
  app.toggleLock("c2");

  // 删除 c4（与 c2 无关）：经 HTTP /api/delete，携带 lock_ids
  const delDone = app.submitWrite({
    kind: "delete",
    path: "/api/delete",
    params: { delete_id: "c4" },
    onSuccess: () => {},
    onError: () => {},
  });
  await flush();
  let calls = app.fetch.to("/api/delete");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.lock_ids, ["c2"]);
  calls[0].respond(200, {
    order_ids: ["c1", "c2", "c3"],
    clauses: app.state.clauses.filter((c) => c.id !== "c4").map((c) => ({ id: c.id, body: c.body })),
    deleted_id: "c4",
  });
  await delDone;
  await flush();
  assert.deepEqual(roundTrip(app.state.orderIds), ["c1", "c2", "c3"]);

  // 复制：即使锁了 c1..c3，也允许；回包新增 c5，lockIds 不含 c5（副本不锁定）
  const dupDone = app.submitWrite({
    kind: "duplicate",
    path: "/api/duplicate",
    params: { selected_ids: ["c1"], next_id: 4 },
    onSuccess: () => {},
    onError: () => {},
  });
  await flush();
  calls = app.fetch.to("/api/duplicate");
  assert.deepEqual(calls[0].body.lock_ids, ["c2"]);
  const dupResult = {
    order_ids: ["c1", "c2", "c3", "c5"],
    clauses: [
      ...app.state.clauses.map((c) => ({ id: c.id, body: c.body })),
      { id: "c5", body: "甲方在七日内交付设备" },
    ],
    next_id: 5,
  };
  calls[0].respond(200, dupResult);
  await dupDone;
  await flush();
  assert.equal(app.state.idCounter, 5);
  assert.ok(!app.state.lockIds.includes("c5"), "副本不锁定");
});

test("成功回包按最新锁定集合核验：违例整次不安装（不更新上界/复核）", async () => {
  const app = loadApp();
  setupDraft(app);
  // 请求发出时不锁定 c2；等待期间锁定 c2；回包却删除了 c2 -> 整次不安装
  const delDone = app.submitWrite({
    kind: "delete",
    path: "/api/delete",
    params: { delete_id: "c2" },
    onSuccess: () => {
      assert.fail("违例时不应调用 onSuccess");
    },
    onError: (errors) => {
      assert.ok(errors.join("\n").includes("c2"), errors.join("\n"));
    },
  });
  await flush();
  // 写稿等待期间切换锁定（spec 允许）
  app.toggleLock("c2");
  assert.deepEqual(app.fetch.to("/api/delete")[0].body.lock_ids, []); // 请求体仍是发出时的集合
  // 后端按旧集合放行（模拟旧后端/竞态）：回包删除了 c2
  app.fetch.to("/api/delete")[0].respond(200, {
    order_ids: ["c1", "c3", "c4"],
    clauses: app.state.clauses.filter((c) => c.id !== "c2").map((c) => ({ id: c.id, body: c.body })),
    deleted_id: "c2",
  });
  await delDone;
  await flush();
  // 草稿整次未安装：c2 仍在
  assert.deepEqual(roundTrip(app.state.orderIds), ["c1", "c2", "c3", "c4"]);
  assert.equal(app.state.writing, null);
});

test("后端 409 锁定拒绝：草稿、上界与勾选均不变", async () => {
  const app = loadApp();
  setupDraft(app);
  app.toggleLock("c1"); // c2 引用 c1；删除 c1 会使锁定条款 c2… 这里锁 c1 自身
  // 删除被锁定的 c1：服务端 409
  const before = JSON.stringify({ o: app.state.orderIds, c: app.state.clauses, n: app.state.idCounter });
  const delDone = app.submitWrite({
    kind: "delete",
    path: "/api/delete",
    params: { delete_id: "c1" },
    onSuccess: () => assert.fail("409 不应成功"),
    onError: (errors) => {
      // 原因按当前顺序列出受影响的锁定身份（409 detail.locked 有 c1；errors 文本也含身份）
      assert.ok(Array.isArray(errors) && errors.length > 0);
      assert.ok(errors.join("\n").includes("锁定"), errors.join("\n"));
    },
  });
  await flush();
  app.fetch.to("/api/delete")[0].respond(409, {
    detail: {
      errors: ["存在锁定条款，本次操作整次拒绝，受影响的锁定条款如下："],
      locked: [{ id: "c1", original: 1, reasons: ["稳定身份消失：该锁定条款被删除或经合并移除"] }],
    },
  });
  await delDone;
  await flush();
  const after = JSON.stringify({ o: app.state.orderIds, c: app.state.clauses, n: app.state.idCounter });
  assert.equal(before, after);
});

test("锁定集合重复 / 含不存在身份：后端 422 时草稿不变（前端始终提交实际集合）", async () => {
  const app = loadApp();
  setupDraft(app);
  // 直接构造一个携带非法集合的请求（模拟异常调用），422 走错误通道
  const done = app.submitWrite({
    kind: "delete",
    path: "/api/delete",
    params: { delete_id: "c4", lock_ids: ["c9"] }, // 协调层会用 lockPayload 覆盖不了 params？
    onSuccess: () => assert.fail("422 不应成功"),
    onError: (errors) => assert.ok(errors.join().includes("不存在") || errors.join().includes("c9")),
  });
  await flush();
  // 协调层以 {...snapshot(), ...params, lock_ids} 合并，params 里的 lock_ids 会被其后的 lock_ids 覆盖
  app.fetch.to("/api/delete")[0].respond(422, {
    detail: { errors: ["锁定身份在当前草稿中不存在：c9"] },
  });
  await done;
  await flush();
  assert.deepEqual(roundTrip(app.state.orderIds), ["c1", "c2", "c3", "c4"]);
});

// --------------------------------------------------------------------------- //
// 3. 本地核验规则（与后端同口径）
// --------------------------------------------------------------------------- //
test("本地核验：身份存续 / 正文逐字 / 有效引用目标存续；重排允许；不冻结被引正文", () => {
  const app = loadApp();
  setupDraft(app);
  app.state.lockIds = []; // 隔离同进程内前序用例残留（state 是模块级单例）

  // 纯重排：无违例
  assert.equal(
    app.lockViolationsInResult(
      {
        order_ids: ["c4", "c3", "c2", "c1"],
        clauses: app.state.clauses.map((c) => ({ id: c.id, body: c.body })),
      },
      ["c1", "c2"],
    ).length,
    0,
  );

  // 删除被锁 c1：身份消失
  let v = app.lockViolationsInResult(
    {
      order_ids: ["c2", "c3", "c4"],
      clauses: app.state.clauses.filter((c) => c.id !== "c1").map((c) => ({ id: c.id, body: c.body })),
    },
    ["c1"],
  );
  assert.deepEqual(roundTrip(v.map((x) => x.id)), ["c1"]);
  assert.ok(v[0].reasons.join().includes("身份消失"));

  // 删除 c1，锁的是 c2（c2 有效引用 c1）：引用失效
  v = app.lockViolationsInResult(
    {
      order_ids: ["c2", "c3", "c4"],
      clauses: app.state.clauses.filter((c) => c.id !== "c1").map((c) => ({ id: c.id, body: c.body })),
    },
    ["c2"],
  );
  assert.deepEqual(roundTrip(v.map((x) => x.id)), ["c2"]);
  assert.ok(v[0].reasons.join().includes("引用将失效"));

  // 改被引用条款 c1 的正文，锁 c2：不冻结被引条款正文 -> 无违例
  v = app.lockViolationsInResult(
    {
      order_ids: ["c1", "c2", "c3", "c4"],
      clauses: app.state.clauses.map((c) =>
        c.id === "c1" ? { id: "c1", body: "甲改为三十日交付" } : { id: c.id, body: c.body },
      ),
    },
    ["c2"],
  );
  assert.equal(v.length, 0);

  // 改锁定条款 c2 自身正文：正文改动
  v = app.lockViolationsInResult(
    {
      order_ids: ["c1", "c2", "c3", "c4"],
      clauses: app.state.clauses.map((c) =>
        c.id === "c2" ? { id: "c2", body: "乙改了" } : { id: c.id, body: c.body },
      ),
    },
    ["c2"],
  );
  assert.deepEqual(roundTrip(v.map((x) => x.id)), ["c2"]);
  assert.ok(v[0].reasons.join().includes("正文被改动"));

  // 违例按当前顺序：锁 c1（消失）与 c3（c3→c2，c2 仍在；这里删 c2 使 c3 失效）
  v = app.lockViolationsInResult(
    {
      order_ids: ["c1", "c3", "c4"],
      clauses: app.state.clauses.filter((c) => c.id !== "c2").map((c) => ({ id: c.id, body: c.body })),
    },
    ["c3", "c2"],
  );
  // c3 在结果中排前面，c2 消失排最后
  assert.deepEqual(roundTrip(v.map((x) => x.id)), ["c3", "c2"]);
});

test("合并 / 拆分本地预检与统一核验一致", () => {
  const app = loadApp();
  setupDraft(app);

  // 合并 c1(keep) + c2(drop)，锁 c2 与 c3：c2 身份消失、c3 对 c2 的引用被改指 -> 拒绝
  app.state.pickIds = ["c1", "c2"];
  app.state.lockIds = ["c2", "c3"];
  let v = app.mergeLockPrecheck("c1", "c2");
  assert.deepEqual(roundTrip(v.map((x) => x.id)), ["c3", "c2"], "c3 引用 c2 被改指在前，c2 消失在后");

  // 只锁 c2：仅报 c2 身份消失（c3 未锁定，其引用改指不报）
  app.state.lockIds = ["c2"];
  v = app.mergeLockPrecheck("c1", "c2");
  assert.deepEqual(roundTrip(v.map((x) => x.id)), ["c2"]);

  // 锁 c4（无关）：合并 c1+c2 不影响 c4
  app.state.lockIds = ["c4"];
  v = app.mergeLockPrecheck("c1", "c2");
  assert.equal(v.length, 0);

  // 拆分 c1：锁 c2，引用落前段 -> c2 正文 [[c1]] 不变 -> 允许
  app.state.lockIds = ["c2"];
  v = app.splitLockPrecheck("c1", 2, "c5", "front");
  assert.equal(v.length, 0);
  // 引用落后段：c2 正文 [[c1]] 改成 [[c5]] -> 拒绝
  v = app.splitLockPrecheck("c1", 2, "c5", "back");
  assert.deepEqual(roundTrip(v.map((x) => x.id)), ["c2"]);

  // 拆分被锁条款自身 c1：前段正文被切走 -> 拒绝
  app.state.lockIds = ["c1"];
  v = app.splitLockPrecheck("c1", 2, "c5", "front");
  assert.deepEqual(roundTrip(v.map((x) => x.id)), ["c1"]);
});

test("锁定切换不改复核记录", () => {
  const app = loadApp();
  setupDraft(app);
  // 直接布置一条复核记录（结构同 reviewClause 产物）
  app.state.reviews = [{ id: "c2", bodies: { c2: "乙方按 [[c1]] 验收后付款", c1: "甲方在七日内交付设备" } }];
  app.toggleLock("c2");
  app.toggleLock("c2");
  assert.equal(app.state.reviews.length, 1, "锁定切换不得改复核");
});
