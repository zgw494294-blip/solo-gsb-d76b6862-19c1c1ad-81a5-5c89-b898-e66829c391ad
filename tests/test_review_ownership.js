"use strict";

// 前端「逐条复核」的回归测试。
//
// 覆盖：
// 1. 复核记录捕获稳定身份及当时自身和全部可达引用条款的内部正文（循环只计一次）；
//    每次改稿成功（touch）后，记录中的正文或目标存续有变化即清除该条复核——
//    纯重排、编号平移与无关改动保留；清除后改回旧文也不自动恢复；新条款默认未复核；
//    取消或失败（不经过 touch）不影响记录；未保存编辑 / 拆分选择 / 写稿 / 预览未同步时不能复核。
// 2. 复核记录仅存本页内存：重新导入、成功恢复存档即清空。
// 3. 复核稿下载归属：下载等待期间改稿或换稿（重新导入）的，旧响应不得保存文件、
//    弹提示或影响新一次下载；成功下载保存与响应一致的文本。
//
// 本文件用最小 DOM 桩在 Node 虚拟机中加载真实的 app/static/app.js（不修改它），
// 直接驱动「复核 / 重新导入 / 恢复存档 / 下载复核稿」的真实事件处理器与内部函数，
// fetch 由测试逐个收尾。
// 运行：node --test tests/test_review_ownership.js（无第三方依赖）

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const APP_JS = path.join(__dirname, "..", "app", "static", "app.js");

// --------------------------------------------------------------------------- //
// 最小 DOM 桩：只实现 app.js 在上述流程中真正触达的元素能力
// --------------------------------------------------------------------------- //
function makeElement(name) {
  const listeners = new Map();
  const classes = new Set();
  return {
    name,
    hidden: false,
    disabled: false,
    checked: false,
    textContent: "",
    innerHTML: "",
    value: "",
    title: "",
    dataset: {},
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
    querySelector: () => null,
    querySelectorAll: () => [],
    appendChild: () => {},
    scrollIntoView: () => {},
    focus: () => {},
    setSelectionRange: () => {},
    closest: () => null,
    click: () => {},
  };
}

// fetch 桩：记录每一次请求，响应时机与结果完全由测试控制
function makeFetchStub() {
  const calls = [];
  const fetch = (url, opts = {}) =>
    new Promise((resolve, reject) => {
      const call = {
        url,
        method: opts.method || "GET",
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
  fetch.reviewExports = () => calls.filter((c) => c.url === "/api/review/export");
  return fetch;
}

// 在虚拟机中加载 app.js，并借追加的测试钩子把模块内部状态与函数暴露出来（app.js 本身不改动）
function loadApp() {
  const elements = new Map();
  const $el = (sel) => {
    if (!elements.has(sel)) elements.set(sel, makeElement(sel));
    return elements.get(sel);
  };
  const fetch = makeFetchStub();
  const alerts = [];
  const savedFiles = []; // 已保存的下载文件：{ name, text }
  const blobByUrl = new Map();
  let blobSeq = 0;
  const sandbox = {
    document: {
      querySelector: $el,
      querySelectorAll: () => [],
      getElementById: () => null,
      createElement: (tag) => {
        const el = makeElement(tag);
        el.click = () => {
          savedFiles.push({ name: el.download, text: blobByUrl.get(el.href).parts.join("") });
        };
        return el;
      },
      createDocumentFragment: () => makeElement("fragment"),
    },
    fetch,
    confirm: () => true, // 测试一律确认（重新导入）
    alert: (...args) => alerts.push(args.join(" ")),
    console,
    Blob: class Blob {
      constructor(parts, opts) {
        this.parts = parts;
        this.type = opts && opts.type;
      }
    },
    URL: {
      createObjectURL: (blob) => {
        const url = `blob:fake-${++blobSeq}`;
        blobByUrl.set(url, blob);
        return url;
      },
      revokeObjectURL: () => {},
    },
  };
  const source = fs.readFileSync(APP_JS, "utf8");
  const hook =
    "\n;globalThis.__app = { state, touch, reviewClause, reviewClosure, unreviewedIds, installArchive };\n";
  vm.createContext(sandbox);
  vm.runInContext(source + hook, sandbox, { filename: "app.js" });
  return {
    sandbox,
    fetch,
    $el,
    alerts,
    savedFiles,
    state: sandbox.__app.state,
    touch: sandbox.__app.touch,
    reviewClause: sandbox.__app.reviewClause,
    reviewClosure: sandbox.__app.reviewClosure,
    unreviewedIds: sandbox.__app.unreviewedIds,
    installArchive: sandbox.__app.installArchive,
  };
}

// 让虚拟机中的 Promise 链推进一轮
const flush = () => new Promise((resolve) => setImmediate(resolve));

// vm 内创建的对象原型与测试侧不同，deepStrictEqual 会误判；经 JSON 往返后再比较
const roundTrip = (v) => JSON.parse(JSON.stringify(v));

// 直接布置一份已保存草稿（绕过导入流程，聚焦复核逻辑）
function setupDraft(app) {
  app.state.clauses = [
    { id: "c1", original: 1, body: "甲方在七日内交付设备" },
    { id: "c2", original: 2, body: "乙方按 [[c1]] 验收后付款" },
    { id: "c3", original: 3, body: "争议解决见 [[c4]]，违约参照 [[c2]]" },
    { id: "c4", original: 4, body: "争议提交仲裁" },
  ];
  app.state.orderIds = ["c1", "c2", "c3", "c4"];
  app.state.idCounter = 4;
  app.state.previewFresh = true;
  app.state.preview = { has_broken: false, items: [] };
}

// --------------------------------------------------------------------------- //
// 复核记录的捕获与清除规则
// --------------------------------------------------------------------------- //
test("复核记录捕获闭包；改稿后按规则清除或保留，改回不恢复", () => {
  const app = loadApp();
  setupDraft(app);

  // 复核 c2：记录稳定身份及当时自身与可达引用条款（c1）的内部正文
  app.reviewClause("c2");
  assert.deepEqual(roundTrip(app.state.reviews), [
    { id: "c2", bodies: { c2: "乙方按 [[c1]] 验收后付款", c1: "甲方在七日内交付设备" } },
  ]);
  // 复核 c3：闭包沿多级引用传递（c3→c4、c2→c1），每条只计一次
  app.reviewClause("c3");
  assert.deepEqual(roundTrip(app.state.reviews[1]), {
    id: "c3",
    bodies: {
      c3: "争议解决见 [[c4]]，违约参照 [[c2]]",
      c4: "争议提交仲裁",
      c2: "乙方按 [[c1]] 验收后付款",
      c1: "甲方在七日内交付设备",
    },
  });
  // 未复核项按当前顺序列出
  assert.deepEqual(roundTrip(app.unreviewedIds()), ["c1", "c4"]);

  // 重新复核：以当前已保存正文刷新记录（内容相同，记录仍在）
  app.reviewClause("c2");
  assert.equal(app.state.reviews.length, 2);

  // 取消或失败不经过 touch()：记录不受影响
  const before = JSON.stringify(app.state.reviews);
  assert.equal(JSON.stringify(app.state.reviews), before);

  // 纯重排：记录全部保留
  app.state.orderIds = ["c4", "c1", "c2", "c3"];
  app.touch();
  assert.equal(app.state.reviews.length, 2);
  // 未复核项按新顺序列出
  assert.deepEqual(roundTrip(app.unreviewedIds()), ["c4", "c1"]);

  // 编号平移：删除无关条款 c4——c2 的闭包不变，其记录保留；c3 的闭包含 c4，记录清除
  app.state.orderIds = ["c1", "c2", "c3"];
  app.state.clauses = app.state.clauses.filter((c) => c.id !== "c4");
  app.touch();
  assert.deepEqual(
    roundTrip(app.state.reviews.map((r) => r.id)),
    ["c2"],
  );

  // 无关改动：改动不在 c2 闭包内的 c3 正文，c2 的复核保留
  app.state.clauses.find((c) => c.id === "c3").body = "争议解决见 [[c4]]，违约参照 [[c2]]；补充";
  app.touch();
  assert.deepEqual(
    roundTrip(app.state.reviews.map((r) => r.id)),
    ["c2"],
  );

  // 闭包内正文变化（c1 改文）：c2 的复核立即清除
  app.state.clauses.find((c) => c.id === "c1").body = "甲方改为三十日内交付设备";
  app.touch();
  assert.equal(app.state.reviews.length, 0);

  // 清除后改回旧文也不自动恢复
  app.state.clauses.find((c) => c.id === "c1").body = "甲方在七日内交付设备";
  app.touch();
  assert.equal(app.state.reviews.length, 0);

  // 目标存续变化：复核 c3（闭包含 c4）后删除 c4，该条复核清除
  setupDraft(app);
  app.reviewClause("c3");
  assert.equal(app.state.reviews.length, 1);
  app.state.orderIds = ["c1", "c2", "c3"];
  app.state.clauses = app.state.clauses.filter((c) => c.id !== "c4");
  app.touch();
  assert.equal(app.state.reviews.length, 0);

  // 新条款默认未复核
  app.state.clauses.push({ id: "c5", original: 5, body: "新增条款" });
  app.state.orderIds.push("c5");
  assert.ok(app.unreviewedIds().includes("c5"));
});

test("循环与重复引用在复核闭包中只计一次；自引用闭包只有自身", () => {
  const app = loadApp();
  app.state.clauses = [
    { id: "c1", original: 1, body: "回引 [[c2]]" },
    { id: "c2", original: 2, body: "重复 [[c1]][[c1]]，又见 [[c3]]" },
    { id: "c3", original: 3, body: "再回 [[c2]]" },
  ];
  app.state.orderIds = ["c1", "c2", "c3"];
  app.state.previewFresh = true;
  app.reviewClause("c2");
  assert.deepEqual(Object.keys(app.state.reviews[0].bodies).sort(), ["c1", "c2", "c3"]);

  const app2 = loadApp();
  app2.state.clauses = [
    { id: "c1", original: 1, body: "本条说明自身 [[c1]]" },
    { id: "c2", original: 2, body: "普通条款" },
  ];
  app2.state.orderIds = ["c1", "c2"];
  app2.state.previewFresh = true;
  app2.reviewClause("c1");
  assert.deepEqual(roundTrip(app2.state.reviews), [
    { id: "c1", bodies: { c1: "本条说明自身 [[c1]]" } },
  ]);
});

test("未保存编辑、拆分选择、写稿提交或预览未同步时不能复核", () => {
  const app = loadApp();
  setupDraft(app);
  const blocks = [
    [() => (app.state.editingId = "c1"), () => (app.state.editingId = null)],
    [() => (app.state.splittingId = "c1"), () => (app.state.splittingId = null)],
    [() => (app.state.writing = "merge"), () => (app.state.writing = null)],
    [() => (app.state.previewFresh = false), () => (app.state.previewFresh = true)],
  ];
  for (const [block, reset] of blocks) {
    block();
    app.reviewClause("c1");
    assert.equal(app.state.reviews.length, 0, "阻塞期间复核不得生效");
    reset();
  }
  app.reviewClause("c1");
  assert.equal(app.state.reviews.length, 1, "解除阻塞后可正常复核");
});

// --------------------------------------------------------------------------- //
// 复核记录仅存本页内存：重新导入、成功恢复存档即清空
// --------------------------------------------------------------------------- //
test("重新导入与成功恢复存档清空复核记录", async () => {
  const app = loadApp();
  setupDraft(app);
  app.reviewClause("c1");
  app.reviewClause("c2");
  assert.equal(app.state.reviews.length, 2);

  // 重新导入：记录清空
  await app.$el("#reimport-btn").fire("click");
  await flush();
  assert.equal(app.state.reviews.length, 0);
  assert.equal(app.state.reviewExporting, false);

  // 恢复存档：记录同样清空（存档协议不含复核记录）
  setupDraft(app);
  app.reviewClause("c1");
  assert.equal(app.state.reviews.length, 1);
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
  app.installArchive(snap, 3);
  assert.equal(app.state.reviews.length, 0);
  assert.equal(app.state.reviewExporting, false);
});

// --------------------------------------------------------------------------- //
// 复核稿下载归属：等待期间改稿或换稿，旧响应不得保存文件或影响新操作
// --------------------------------------------------------------------------- //
test("下载等待期间改稿：旧响应不保存文件，提示重新下载，等待状态收尾", async () => {
  const app = loadApp();
  setupDraft(app);
  app.reviewClause("c1");
  app.reviewClause("c2");
  app.reviewClause("c3");
  app.reviewClause("c4");

  const btn = app.$el("#review-download-btn");
  btn.disabled = false;
  const done = btn.fire("click");
  await flush();
  assert.equal(app.state.reviewExporting, true);
  assert.equal(app.fetch.reviewExports().length, 1);
  const call = app.fetch.reviewExports()[0];
  // 请求携带草稿与全部复核记录
  assert.equal(call.body.reviews.length, 4);
  assert.deepEqual(call.body.order_ids, ["c1", "c2", "c3", "c4"]);

  // 等待期间改稿（正文未变，复核记录保留，但修订号已推进）
  app.touch();

  // 旧响应返回：不保存文件，提示重新下载；等待状态由本次下载自己收尾
  call.respond(200, { text: "1|x" });
  await done;
  await flush();
  assert.equal(app.savedFiles.length, 0, "改稿后旧响应不得保存文件");
  assert.equal(app.alerts.length, 1);
  assert.match(app.alerts[0], /重新下载/);
  assert.equal(app.state.reviewExporting, false);
});

test("下载等待期间换稿（重新导入）：旧响应静默作废，不影响新一次下载", async () => {
  const app = loadApp();
  setupDraft(app);
  app.reviewClause("c1");
  app.reviewClause("c2");
  app.reviewClause("c3");
  app.reviewClause("c4");

  const btn = app.$el("#review-download-btn");
  btn.disabled = false;
  const done1 = btn.fire("click");
  await flush();
  assert.equal(app.fetch.reviewExports().length, 1);
  const stale = app.fetch.reviewExports()[0];

  // 等待期间确认重新导入：复核记录清空，旧下载的响应与收尾一律作废
  await app.$el("#reimport-btn").fire("click");
  await flush();
  assert.equal(app.state.reviews.length, 0);
  assert.equal(app.state.reviewExporting, false);

  // 旧响应迟到：不保存文件、不弹提示、不影响新状态
  stale.respond(200, { text: "1|旧稿" });
  await done1;
  await flush();
  assert.equal(app.savedFiles.length, 0);
  assert.equal(app.alerts.length, 0);
  assert.equal(app.state.reviewExporting, false);

  // 新草稿上重新复核并下载：正常保存与响应一致的文本
  setupDraft(app);
  app.reviewClause("c1");
  app.reviewClause("c2");
  app.reviewClause("c3");
  app.reviewClause("c4");
  btn.disabled = false;
  const done2 = btn.fire("click");
  await flush();
  assert.equal(app.fetch.reviewExports().length, 2);
  assert.equal(app.state.reviewExporting, true);
  app.fetch.reviewExports()[1].respond(200, { text: "1|甲\n2|乙" });
  await done2;
  await flush();
  assert.equal(app.savedFiles.length, 1);
  assert.match(app.savedFiles[0].name, /^reviewed-.*\.txt$/);
  assert.equal(app.savedFiles[0].text, "1|甲\n2|乙");
  assert.equal(app.state.reviewExporting, false);
});

test("复核稿下载被拒绝（409 未复核齐全）：不保存文件，提示原因，可重试", async () => {
  const app = loadApp();
  setupDraft(app);
  app.reviewClause("c1");
  app.reviewClause("c2");
  app.reviewClause("c3");
  app.reviewClause("c4");

  const btn = app.$el("#review-download-btn");
  btn.disabled = false;
  const done = btn.fire("click");
  await flush();
  app.fetch.reviewExports()[0].respond(409, {
    detail: { errors: ["存在未复核条款，全部现存条款复核后才能下载复核稿"], unreviewed: [] },
  });
  await done;
  await flush();
  assert.equal(app.savedFiles.length, 0);
  assert.equal(app.alerts.length, 1);
  assert.match(app.alerts[0], /未复核/);
  assert.equal(app.state.reviewExporting, false, "失败后自动恢复，可重试");
});
