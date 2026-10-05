"use strict";

// --------------------------------------------------------------------------- //
// 状态
// --------------------------------------------------------------------------- //
const state = {
  clauses: [], // { id, original, body(内部形态 [[c3]]) }
  orderIds: [],
  editingId: null,
  pickIds: [], // 勾选的条款 id：恰好两条时可合并，一条或多条时可复制
  splittingId: null, // 打开拆分选择器的条款 id（打开期间阻止其他改稿操作）
  splitOffset: null, // 拆分分界：内部正文中的字符位置（按 Unicode 码位计，与后端一致）
  splitRefsTo: "front", // 原指向被拆条款的引用落到 front（前段）还是 back（后段）
  idCounter: 0, // 本草稿已用过的最大身份号：拆分新段与复制副本从 idCounter+1 起取，删除/合并移除的身份不复用
  preview: null, // 服务端 /api/preview 返回；仅当 previewFresh 为真时与当前草稿对应
  previewError: null, // 最近一次预览失败的错误信息（数组）；成功一次或重新导入后清空
  renderedRev: null, // 页面当前 DOM 所呈现草稿的修订号；预览失败时据此判断列表是否停留在旧编号
  renderedSplittingId: null, // 当前 DOM 渲染时正在打开拆分选择器的条款（null 表示没有）
  renderedEditingId: null, // 当前 DOM 渲染时正在编辑的条款（null 表示没有）
  dragId: null,
  epoch: 0, // 草稿世代：导入成功 / 重新导入时 +1；上一草稿的迟到响应一律丢弃
  rev: 0, // 草稿修订号：任何本地改动 +1；响应发出后草稿又有改动的，响应不再适用
  previewFresh: false, // 页面预览是否已追上最新草稿；未追上时禁止下载与合并
  importing: false, // /api/import 在途（期间忽略重复提交）
  saving: false, // /api/save 在途
  writing: null, // 在途写稿提交（null | "merge" | "split" | "duplicate" | "delete"）：合并 / 拆分 / 复制 / 删除共用的
  // 提交协调层状态；提交期间阻止其他改稿与重复提交，但允许重新导入与切换条款锁定
  exporting: false, // /api/export 在途
  baseline: null, // 成功导入后不可变的原稿基线（{ order_ids, clauses }，深拷贝）；重新导入清空
  diffOpen: false, // 原稿对照面板是否展开
  diffData: null, // 最近一次与当前草稿一致的 /api/diff 响应；改稿后立即置空（旧对照失效）
  diffError: null, // 最近一次对照刷新失败的错误信息（数组）；成功一次后清空
  diffFresh: false, // 面板内容是否已追上当前草稿；改稿立即为 false
  refsId: null, // 「谁引用本条」当前展开的目标条款 id；同一时刻只展开一张卡片
  refsData: null, // 最近一次与当前草稿一致的 /api/referrers 响应；改稿 / 换目标 / 重新导入立即置空
  refsError: null, // 最近一次引用查询失败的错误信息（数组）；成功一次或收起后清空
  refsFresh: false, // 引用结果是否已追上当前草稿；改稿立即为 false
  excerptData: null, // 最近一次与当前草稿+勾选一致的 /api/excerpt 响应；改稿 / 切换勾选 / 重新导入立即置空
  excerptError: null, // 最近一次摘录导出失败的错误信息（数组）；成功一次或清空后复位
  excerpting: false, // /api/excerpt 在途（期间忽略重复提交）
  reviews: [], // 逐条复核记录：[{ id, bodies: { 条款id: 内部正文 } }]——每条记录含被复核条款的
  // 稳定身份，以及复核当刻它自身和全部可达引用条款（循环只计一次）的内部正文；
  // 仅存本页内存：重新导入、成功恢复存档或刷新后清空，不进入存档快照
  mergeRecords: [], // 每次成功合并的撤销记录：[{ keep_id, drop_id, keep_body, drop_body,
  //   sources: [{ id, body, after_body }] }]——两条原文及所有改写引用来源的前后内部正文；
  //   仅存本页内存：重新导入、成功恢复存档或刷新后清空，不进入存档快照；
  //   撤销成功后该条记录不可再用（随即移除），撤销失败保留记录
  reviewExporting: false, // /api/review/export 在途（期间忽略重复下载）
  archiveVersion: null, // 最近读取或保存成功得到的服务端存档版本；null 表示尚未读取 / 保存过
  archiveDirty: false, // 草稿是否有未存档改动：任何改稿置真，保存成功（期间未再改）或恢复后复位
  archiving: false, // PUT /api/archive 在途（期间忽略重复保存；不阻塞改稿）
  restoring: false, // 恢复用的 GET /api/archive 在途
  archiveError: null, // 最近一次存档操作失败的错误信息（数组）
  archiveConflict: null, // 最近一次 409 冲突时服务端的当前版本（数字）；读取最新版本或保存 / 恢复成功后清空
  archiveNotice: null, // 存档提示（如"已读取最新版本 v3"、"服务端暂无存档"）
  lockIds: [], // 条款锁定集合（稳定身份）：仅存本页内存，随写稿请求提交、由后端按实际结果核验；
  // 换稿（重新导入 / 恢复存档）或刷新清空，不进存档快照；锁定切换不改草稿、不推进修订号、不改复核
};

const MAX_CLAUSES = 40; // 与后端 MAX_LINES 一致：拆分后总数不能超过它

let previewSeq = 0; // 预览请求序号：只采用最后一次发出的预览响应
let exportSeq = 0; // 下载请求序号：只有仍持有它的下载能收尾按钮；重新导入 / 新下载会作废旧下载的收尾权
let writeSeq = 0; // 写稿提交序号（合并 / 拆分 / 复制共用）：重新导入会推进它，旧写稿请求的成功、
// 错误与收尾一律落空——不得改动新稿，也不得解除新请求的等待状态
let previewInFlight = false; // 是否已有 /api/preview 在途：防止重试预览重复提交
let diffSeq = 0; // 对照请求序号：只采用最后一次发出的对照响应，迟到响应不得覆盖新结果
let diffInFlight = false; // 是否已有 /api/diff 在途：防止重复提交
let refsSeq = 0; // 「谁引用本条」请求序号：只采用最后一次发出的响应，迟到响应不得恢复旧结果
let refsInFlight = false; // 是否已有 /api/referrers 在途：防止重复提交
let excerptSeq = 0; // 摘录请求序号：改稿 / 切换勾选 / 重新导入 / 新请求都会推进，迟到响应一律丢弃
let reviewExportSeq = 0; // 复核稿下载序号：重新导入 / 恢复存档 / 新下载都会推进，
// 旧下载的响应与收尾一律失效——不得保存旧文件、弹提示或影响新下载

const MARKER = /\[\[(?:原(\d+)\?|(\d+))\]\]/g; // 预览文本中的引用形态

const $ = (sel) => document.querySelector(sel);

const importPanel = $("#import-panel");
const desk = $("#desk");
const importText = $("#import-text");
const importErrors = $("#import-errors");
const importBtn = $("#import-btn");
const clauseList = $("#clause-list");
const previewText = $("#preview-text");
const brokenBanner = $("#broken-banner");
const previewErrorBanner = $("#preview-error-banner");
const downloadBtn = $("#download-btn");
const mergeBtn = $("#merge-btn");
const duplicateBtn = $("#duplicate-btn");
const diffBtn = $("#diff-btn");
const diffPanel = $("#diff-panel");
const diffStatus = $("#diff-status");
const diffBanner = $("#diff-banner");
const diffBody = $("#diff-body");
const excerptBtn = $("#excerpt-btn");
const excerptPanel = $("#excerpt-panel");
const excerptStatus = $("#excerpt-status");
const excerptBanner = $("#excerpt-banner");
const excerptBody = $("#excerpt-body");
const reviewPanel = $("#review-panel");
const reviewStatus = $("#review-status");
const reviewBody = $("#review-body");
const reviewDownloadBtn = $("#review-download-btn");
const mergePanel = $("#merge-panel");
const mergeStatus = $("#merge-status");
const mergeBody = $("#merge-body");
const statCount = $("#stat-count");
const statBroken = $("#stat-broken");
const archiveStatus = $("#archive-status");
const archiveSaveBtn = $("#archive-save-btn");
const archiveRestoreBtn = $("#archive-restore-btn");
const archiveRestoreImportBtn = $("#archive-restore-import-btn");
const archiveBanner = $("#archive-banner");

// --------------------------------------------------------------------------- //
// 工具
// --------------------------------------------------------------------------- //
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function api(path, body, method) {
  const opts = { method: method || "POST" };
  if (body !== undefined && body !== null) {
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  // 正文可能在读取/解析时中断（已收到 2xx 响应头但正文被截断）：
  // 这种响应不能当作成功采用，统一归为可重试的请求失败，由各调用方按失败收尾。
  let data;
  try {
    data = await res.json();
  } catch (_) {
    data = null;
  }
  if (!res.ok) {
    const err = new Error("api error");
    err.status = res.status;
    err.detail = data && data.detail; // 如 409 冲突时附带的当前版本
    err.errors = (data && data.detail && data.detail.errors) || ["请求失败"];
    throw err;
  }
  if (data === null || typeof data !== "object") {
    const err = new Error("response interrupted");
    err.errors = ["响应正文在读取完成前中断，请重试。"];
    throw err;
  }
  return data;
}

// 把任何失败（服务端 4xx/5xx、JSON 解析失败、断网等 TypeError）归一成可展示的字符串数组。
// 网络异常时 e.errors 可能不存在，直接 .join() 会再抛异常导致失败信息显示不出来。
function errorList(e) {
  const raw = e && e.errors;
  if (Array.isArray(raw) && raw.length) return raw.map((m) => String(m));
  if (typeof raw === "string" && raw) return [raw];
  const message = e && typeof e.message === "string" && e.message ? e.message : "";
  return [message ? `请求失败（${message}），请检查网络后重试。` : "请求失败，请检查网络后重试。"];
}

function snapshot() {
  return {
    order_ids: state.orderIds,
    clauses: state.clauses.map((c) => ({ id: c.id, body: c.body })),
  };
}

// --------------------------------------------------------------------------- //
// 条款锁定（集合仅存本页内存；随写稿请求提交，由后端按实际结果核验）
// --------------------------------------------------------------------------- //
// 当前锁定集合的快照：随每个写稿请求提交。空数组是显式的空集合（与旧调用不传不同，
// 但前端始终传），后端据此核验。
function lockPayload() {
  return state.lockIds.slice();
}

// 切换某条条款的锁定 / 解锁。纯本页内存操作：
// - 不改正文、顺序与身份上界，不推进修订号，不触发预览 / 对照 / 引用重查；
// - 不改复核状态（锁定切换不改复核），也不影响存档的未存档标记；
// - 含失效引用的条款不能锁定（按钮已禁用，这里再兜底）；解锁始终允许；
// - 写稿提交等待期间也可切换（spec 明确允许），下一个写稿请求携带最新集合。
function toggleLock(id) {
  const idx = state.lockIds.indexOf(id);
  if (idx >= 0) {
    state.lockIds.splice(idx, 1);
  } else {
    if (clauseHasBrokenRef(id)) return; // 含失效引用的条款不能锁定
    state.lockIds.push(id);
  }
  syncLockTags();
}

// 按当前已保存草稿判断某条款正文是否含失效引用（内部形态 [[cX]] 中目标已不在草稿）
function clauseHasBrokenRef(id) {
  const clause = state.clauses.find((c) => c.id === id);
  if (!clause) return false;
  const alive = new Set(state.orderIds);
  return Array.from(clause.body.matchAll(/\[\[(c\d+)\]\]/g)).some((m) => !alive.has(m[1]));
}

// 卡片重建后锁定标记与按钮由模板渲染；这里处理点击「锁定 / 解锁」后不重建卡片的即时更新
function syncLockTags() {
  const locked = new Set(state.lockIds);
  document.querySelectorAll(".card").forEach((card) => {
    const isLocked = locked.has(card.dataset.id);
    card.classList.toggle("locked", isLocked);
    const tag = card.querySelector('[data-role="lock-tag"]');
    if (tag) tag.hidden = !isLocked;
    // 不重建整张卡片，仅同步改稿入口的禁用态（锁定不影响重排按钮与勾选）；
    // 任一卡片处于编辑 / 拆分选择中时，其他卡的改稿入口仍按既有规则全部禁用
    const otherBusy = state.editingId !== null || state.splittingId !== null;
    const editBtn = card.querySelector('[data-action="edit"]');
    const delBtn = card.querySelector('[data-action="delete"]');
    const splitBtn = card.querySelector('[data-action="split"]');
    if (editBtn) editBtn.disabled = isLocked || otherBusy;
    if (delBtn) delBtn.disabled = isLocked || otherBusy;
    if (splitBtn) splitBtn.disabled = isLocked || otherBusy || state.orderIds.length >= MAX_CLAUSES;
    const lockBtn = card.querySelector('[data-action="lock"]');
    if (lockBtn) {
      lockBtn.textContent = isLocked ? "解锁" : "锁定";
      lockBtn.classList.toggle("is-locked", isLocked);
      // 解锁后若条款含失效引用，重新锁定仍应被阻止；解锁态按钮始终可用
      lockBtn.disabled = !isLocked && clauseHasBrokenRef(card.dataset.id);
    }
  });
}

// 内部正文中的引用标记（含失效引用），返回 [[cX]] 中目标身份的去重列表
function refTargets(body) {
  const out = [];
  const seen = new Set();
  for (const m of body.matchAll(/\[\[(c\d+)\]\]/g)) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      out.push(m[1]);
    }
  }
  return out;
}

// 在一份写稿结果（接口回包形态：{ order_ids, clauses }）上按给定锁定集合核验。
// 与后端 _lock_violations 同规则：保护稳定身份存续、内部正文逐字不变、操作前有效引用
// （目标仍在草稿内）的引用关系——结果中标记仍须指向同一目标；重排与编号变化不报；
// 被引用条款正文变化不报。repointed 为统一改指映射（合并 drop→keep、拆分落后段
// split→new），用于把"改指"与"目标删除导致失效"区分开。
// 返回 [{ id, reasons }]，顺序与结果 order_ids 一致，消失身份排最后。
function lockViolationsInResult(result, lockIds, repointed) {
  if (!lockIds || !lockIds.length) return [];
  repointed = repointed || {};
  const oldById = new Map(state.clauses.map((c) => [c.id, c.body]));
  const newById = new Map(result.clauses.map((c) => [c.id, c.body]));
  const reasons = new Map();
  const add = (id, reason) => {
    const list = reasons.get(id) || [];
    if (!list.includes(reason)) list.push(reason);
    reasons.set(id, list);
  };
  for (const lockId of lockIds) {
    const oldBody = oldById.get(lockId);
    if (oldBody === undefined) continue;
    const newBody = newById.get(lockId);
    if (newBody === undefined) {
      add(lockId, "稳定身份消失：该锁定条款被删除或经合并移除");
      continue;
    }
    if (newBody !== oldBody) {
      add(lockId, "内部正文被改动（锁定条款的正文须逐字保持）");
    }
    const oldTargets = refTargets(oldBody)
      .filter((r) => oldById.has(r))
      .sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10));
    for (const refId of oldTargets) {
      // 目标仍存续且标记仍指向它：正常（删除会在正文留下失效标记 [[cX]]，
      // 必须先确认目标仍在——标记残留而目标消失正是"引用将失效"）
      if (newById.has(refId) && newBody.includes(`[[${refId}]]`)) continue;
      const newTarget = repointed[refId];
      if (newTarget !== undefined && newBody.includes(`[[${newTarget}]]`)) {
        add(lockId, `有效引用 [[${refId}]] 被统一改指 [[${newTarget}]]，引用关系发生变化`);
      } else if (!newById.has(refId)) {
        add(lockId, `有效引用 [[${refId}]] 的目标条款被删除或经合并移除，该引用将失效`);
      } else {
        add(lockId, `有效引用 [[${refId}]] 被改动，引用关系发生变化`);
      }
    }
  }
  const ordered = [];
  const emitted = new Set();
  for (const cid of result.order_ids) {
    if (reasons.has(cid)) {
      ordered.push({ id: cid, reasons: reasons.get(cid) });
      emitted.add(cid);
    }
  }
  for (const lockId of lockIds) {
    if (reasons.has(lockId) && !emitted.has(lockId)) {
      ordered.push({ id: lockId, reasons: reasons.get(lockId) });
    }
  }
  return ordered;
}

// 保存（/api/save）的回包只有 { id, body }：构造结果草稿后复用统一核验
function lockViolationsAfterSave(editId, body, lockIds) {
  return lockViolationsInResult(
    {
      order_ids: state.orderIds,
      clauses: state.clauses.map((c) =>
        c.id === editId ? { id: c.id, body } : { id: c.id, body: c.body },
      ),
    },
    lockIds,
  );
}

// 把本地核验出的违例归一成与后端 409 同形态的可展示错误
function formatLockViolations(violations) {
  return [
    "存在锁定条款，本次操作整次拒绝，受影响的锁定条款如下：",
    ...violations.map(
      (v) => `锁定身份 ${v.id}（原第 ${v.id.slice(1)} 条）：${v.reasons.join("；")}`,
    ),
  ];
}

// 合并的本地预检：在构造合并结果上复用统一核验（权威核验仍由服务端按实际结果执行）
function mergeLockPrecheck(keepId, dropId) {
  if (!state.lockIds.length) return [];
  const clauses = [];
  for (const c of state.clauses) {
    if (c.id === dropId) continue;
    let body = c.body;
    if (c.id === keepId) {
      const drop = state.clauses.find((x) => x.id === dropId);
      body = `${body}；${drop.body}`;
    }
    body = body.replaceAll(`[[${dropId}]]`, `[[${keepId}]]`);
    clauses.push({ id: c.id, body });
  }
  const orderIds = state.orderIds.filter((x) => x !== dropId);
  return lockViolationsInResult(
    { order_ids: orderIds, clauses },
    state.lockIds,
    { [dropId]: keepId },
  );
}

// 拆分的本地预检：镜像后端 /api/split 的结果构造后复用统一核验
function splitLockPrecheck(splitId, offset, newId, refsTo) {
  if (!state.lockIds.length) return [];
  const repoint = (body) =>
    refsTo === "back" ? body.replaceAll(`[[${splitId}]]`, `[[${newId}]]`) : body;
  const src = state.clauses.find((c) => c.id === splitId);
  const clauses = [];
  for (const c of state.clauses) {
    if (c.id === splitId) {
      clauses.push({ id: c.id, body: repoint(src.body.slice(0, offset)) });
      clauses.push({ id: newId, body: repoint(src.body.slice(offset)) });
    } else {
      clauses.push({ id: c.id, body: repoint(c.body) });
    }
  }
  const orderIds = [];
  for (const cid of state.orderIds) {
    orderIds.push(cid);
    if (cid === splitId) orderIds.push(newId);
  }
  const repointed = refsTo === "back" ? { [splitId]: newId } : {};
  return lockViolationsInResult({ order_ids: orderIds, clauses }, state.lockIds, repointed);
}

// 原稿基线：成功导入那一刻的草稿快照。基线一经建立不再随改稿变动，
// 因此这里返回深拷贝，避免后续编辑、合并、拆分误写基线。
function snapshotBaseline() {
  return {
    order_ids: state.baseline.order_ids.slice(),
    clauses: state.baseline.clauses.map((c) => ({ id: c.id, body: c.body })),
  };
}

// --------------------------------------------------------------------------- //
// 草稿改动与工具栏状态
// --------------------------------------------------------------------------- //
// 任何本地草稿改动都要经过 touch()：修订号 +1（使在途响应失效）、
// 标记预览未追上最新草稿（期间禁止下载 / 合并），直到下一次预览响应被采用。
function touch() {
  state.rev += 1;
  state.previewFresh = false;
  // 任何改稿都使服务端存档落后于草稿：提示有未存档的修改，直到保存成功或恢复；
  // 旧的存档提示（如"已读取最新版本"）同时过时，一并清掉（错误与冲突保留）
  state.archiveDirty = true;
  state.archiveNotice = null;
  // 改稿后旧对照立即失效：已展示的对照内容立即标记过期，等待新草稿的对照响应；
  // 取消编辑 / 保存失败不经过 touch()，因此不会让对照失效。
  state.diffFresh = false;
  state.diffData = null;
  // 「谁引用本条」同理：改稿立即清空旧结果（旧内容不置灰保留，直接清空），
  // 面板仍展开时按最新已保存草稿重新查询；迟到响应不能恢复旧结果。
  state.refsFresh = false;
  state.refsData = null;
  state.refsError = null;
  // 勾选条款摘录同理：改稿立即清空旧结果与提示，在途请求的迟到响应一律丢弃
  clearExcerpt();
  // 每次改稿成功后核对复核记录：记录中的正文或目标存续有变化的，该条复核立即清除；
  // 纯重排、编号平移与无关改动保留复核；清除后改回旧文也不自动恢复
  pruneReviews();
  syncToolbar();
  syncDiffPanel();
  syncReferrers();
  if (state.diffOpen) refreshDiff();
  if (state.refsId) refreshReferrers(); // 面板展开时按最新已保存草稿重新查询
}

function syncToolbar() {
  updateMergeBtn();
  updateDuplicateBtn();
  updateExcerptBtn();
  updateDownloadBtn();
  syncArchiveUi();
  syncReviewPanel();
  syncMergePanel();
  syncBusy();
}

// 列表是否应整体暂停操作（置灰、拦截事件，结束后自动恢复）：
// - 写稿提交（合并 / 拆分 / 复制）在途；
// - 预览失败且页面停留在旧编号（renderedRev 与当前草稿不一致）；
// - 预览失败且刚打开的拆分选择器 / 编辑器尚未渲染出来（DOM 里没有对应入口）。
// 已成功渲染的拆分选择器在预览失败时仍可继续操作（选分界、确认、取消），
// 其重试入口在失败横幅上。
function listLocked() {
  if (state.writing) return true;
  if (state.previewError === null) return false;
  if (state.renderedRev !== state.rev) return true;
  if (state.splittingId !== null && state.renderedSplittingId !== state.splittingId) return true;
  if (state.editingId !== null && state.renderedEditingId !== state.editingId) return true;
  return false;
}

function syncBusy() {
  clauseList.classList.toggle("busy", listLocked());
}

// 预览失败横幅：始终可重试预览；拆分选择器或编辑器尚未渲染出来时还提供对应
// 的取消入口（成功取消后恢复原草稿卡片操作）。拆分选择器已渲染时，其卡片内
// 的「取消 / 确认拆分」与分界选择照常可用。
function syncPreviewErrorBanner() {
  const errors = state.previewError;
  if (errors === null) {
    previewErrorBanner.hidden = true;
    previewErrorBanner.textContent = "";
    return;
  }
  const stale =
    state.renderedRev !== state.rev ||
    (state.splittingId !== null && state.renderedSplittingId !== state.splittingId) ||
    (state.editingId !== null && state.renderedEditingId !== state.editingId);
  const cancel = state.splittingId
    ? '<button type="button" data-action="preview-cancel-split">取消拆分</button>'
    : state.editingId
      ? '<button type="button" data-action="preview-cancel-edit">取消编辑</button>'
      : "";
  const scope = stale
    ? "草稿改动（可能含刚完成的拆分、合并或保存）已保留，但页面仍停留在旧内容：列表操作、引用跳转与下载已暂停。"
    : "原草稿未改动，可继续当前拆分选择，或取消后恢复卡片操作。";
  previewErrorBanner.innerHTML =
    `<strong>预览刷新失败。</strong>${scope}` +
    `<ul>${errors.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>` +
    `<div class="preview-error-actions">` +
    `<button type="button" class="primary" data-action="preview-retry"${
      previewInFlight ? " disabled" : ""
    }>${previewInFlight ? "重试中…" : "重试预览"}</button>${cancel}</div>`;
  previewErrorBanner.hidden = false;
}

function updateMergeBtn() {
  if (state.writing === "merge") {
    mergeBtn.disabled = true;
    mergeBtn.textContent = "合并中…";
    return;
  }
  // 合并仍只允许两条：勾选恰好两条且未在编辑 / 拆分选择 / 写稿提交在途时可用
  mergeBtn.disabled =
    state.editingId !== null ||
    state.splittingId !== null ||
    state.writing !== null ||
    !state.previewFresh ||
    state.pickIds.length !== 2;
  mergeBtn.textContent =
    state.pickIds.length === 2 ? "合并所选（2 条）" : "合并所选";
  mergeBtn.title =
    state.pickIds.length === 2 ? "" : "勾选恰好两条条款后可合并";
}

function updateDuplicateBtn() {
  if (state.writing === "duplicate") {
    duplicateBtn.disabled = true;
    duplicateBtn.textContent = "复制中…";
    return;
  }
  const picks = state.pickIds.length;
  const total = state.orderIds.length + picks;
  const overLimit = picks > 0 && total > MAX_CLAUSES;
  // 未保存编辑或拆分选择未结束时不能复制；复制后超过上限同样不可用
  duplicateBtn.disabled =
    state.editingId !== null ||
    state.splittingId !== null ||
    state.writing !== null ||
    !state.previewFresh ||
    picks < 1 ||
    overLimit;
  duplicateBtn.textContent = picks > 0 ? `复制所选（${picks} 条）` : "复制所选";
  duplicateBtn.title = overLimit
    ? `复制后共 ${total} 条，超过上限 ${MAX_CLAUSES} 条，不能复制`
    : picks < 1
      ? "勾选一条或多条条款后可复制"
      : "按当前显示顺序复制所选整组，副本插在所选最后一条之后";
}

function updateDownloadBtn() {
  downloadBtn.disabled =
    state.exporting ||
    state.writing !== null ||
    !state.previewFresh ||
    !state.preview ||
    state.preview.has_broken;
  downloadBtn.textContent = state.exporting ? "下载中…" : "下载纯文本";
}

// 导出摘录按钮：未保存编辑或拆分选择未结束时不可用；与合并/复制同样要求预览已追上
// 当前草稿。摘录只针对收录范围内的失效引用整份拒绝，范围外的失效引用不阻止摘录，
// 因此不像「下载纯文本」那样因 has_broken 禁用。
function updateExcerptBtn() {
  if (state.excerpting) {
    excerptBtn.disabled = true;
    excerptBtn.textContent = "导出中…";
    return;
  }
  excerptBtn.disabled =
    state.editingId !== null ||
    state.splittingId !== null ||
    state.writing !== null ||
    !state.previewFresh ||
    state.pickIds.length < 1;
  excerptBtn.textContent = "导出摘录";
  excerptBtn.title =
    state.pickIds.length < 1
      ? "勾选一条或多条条款后可导出摘录"
      : "把勾选条款及其直接、间接引用的全部现存条款导出为独立编号的摘录";
}

// --------------------------------------------------------------------------- //
// 校稿存档（共享槽完整快照：基线 + 当前顺序 + 内部正文 + 已用身份上界）
// --------------------------------------------------------------------------- //
// 存档快照只含可持久化的草稿内容，不含勾选、编辑中正文或拆分选择等临时状态。
function archiveSnapshot() {
  return {
    baseline: snapshotBaseline(),
    order_ids: state.orderIds.slice(),
    clauses: state.clauses.map((c) => ({ id: c.id, body: c.body })),
    id_counter: state.idCounter,
  };
}

// 存档状态文本、两个入口按钮与横幅的统一同步（经 syncToolbar 随草稿状态刷新）
function syncArchiveUi() {
  if (state.archiveDirty) {
    archiveStatus.textContent =
      state.archiveVersion === null ? "尚未保存存档" : "有未存档的修改";
  } else if (state.archiveVersion !== null) {
    archiveStatus.textContent = `已存档（版本 ${state.archiveVersion}）`;
  } else {
    archiveStatus.textContent = "";
  }

  archiveSaveBtn.disabled = state.archiving || state.restoring;
  archiveSaveBtn.textContent = state.archiving ? "存档中…" : "保存存档";
  // 恢复会整份替换草稿：未保存编辑、拆分选择或写稿未结束时不可恢复
  const restoreBlocked =
    state.editingId !== null || state.splittingId !== null || state.writing !== null;
  archiveRestoreBtn.disabled = state.archiving || state.restoring || restoreBlocked;
  archiveRestoreBtn.textContent = state.restoring ? "恢复中…" : "恢复存档";
  archiveRestoreBtn.title = restoreBlocked
    ? "未保存编辑、拆分选择或写稿未结束时不可恢复"
    : "读取服务端存档，确认后整份替换当前草稿";
  archiveRestoreImportBtn.disabled = state.restoring;
  archiveRestoreImportBtn.textContent = state.restoring ? "恢复中…" : "恢复存档";
  syncArchiveBanner();
}

function syncArchiveBanner() {
  if (state.archiveConflict !== null) {
    // 冲突：本地稿保留，不自动覆盖；提供「读取最新版本」入口
    archiveBanner.innerHTML =
      `<strong>存档冲突。</strong>服务端存档已更新到版本 ${state.archiveConflict}，本次保存未写入；` +
      `本地草稿已保留，不会自动覆盖服务端存档。` +
      `<div class="preview-error-actions">` +
      `<button type="button" class="primary" data-action="archive-read-latest">读取最新版本</button>` +
      `<span class="muted">读取后可再次保存（将覆盖服务端该版本存档），或点「恢复存档」用服务端存档替换本地稿。</span>` +
      `</div>`;
    archiveBanner.hidden = false;
    return;
  }
  if (state.archiveError) {
    archiveBanner.innerHTML =
      `<strong>存档操作失败。</strong>草稿未受影响：` +
      `<ul>${state.archiveError.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>`;
    archiveBanner.hidden = false;
    return;
  }
  if (state.archiveNotice) {
    archiveBanner.textContent = state.archiveNotice;
    archiveBanner.hidden = false;
    return;
  }
  archiveBanner.hidden = true;
  archiveBanner.textContent = "";
}

// 保存存档：携带最近读取或保存成功得到的版本整份写入；保存期间可继续改稿，
// 回执只确认提交时的快照——期间又有修改的，仍提示未存档。
archiveSaveBtn.addEventListener("click", async () => {
  if (state.archiving || state.restoring) return; // 忽略等待期间的重复提交
  // 整个保存动作（含首次保存前的预读取）归属发起时的草稿世代：等待期间重新导入或
  // 恢复存档会推进世代，旧动作随即失效——其预读取的成功、失败与收尾一律落空，
  // 不得触发后续写入，也不得改动新稿的版本、未存档标记、提示或新保存的等待状态
  const epoch = state.epoch;
  // 首次保存前尚未读取过版本：先读取拿到槽内当前版本（空槽为 0），再据此保存
  if (state.archiveVersion === null) {
    state.archiving = true;
    syncArchiveUi();
    try {
      const data = await api("/api/archive", null, "GET");
      if (typeof data.version !== "number") throw new Error("bad archive read");
      if (epoch !== state.epoch) return; // 已换稿：旧读取结果不得触发写入或改新稿版本
      state.archiveVersion = data.version;
    } catch (e) {
      if (epoch !== state.epoch) return; // 已换稿：旧读取的失败不提示，也不动新保存的等待状态
      state.archiving = false;
      state.archiveError = errorList(e);
      syncArchiveUi();
      return;
    }
    state.archiving = false;
  }
  const rev = state.rev;
  const version = state.archiveVersion;
  const snapshot = archiveSnapshot(); // 提交当刻的快照；之后的修改不影响已发出的请求
  state.archiving = true;
  state.archiveError = null;
  syncArchiveUi();
  try {
    const data = await api("/api/archive", { version, snapshot }, "PUT");
    if (epoch !== state.epoch) return; // 已重新导入 / 已恢复：旧回执不作用于新稿
    if (typeof data.version !== "number") {
      state.archiveError = ["存档响应正文不完整，请重试。"];
      return;
    }
    // 服务端版本确已推进：无论草稿是否又改，都更新版本知识
    state.archiveVersion = data.version;
    state.archiveConflict = null;
    state.archiveError = null;
    if (rev === state.rev) {
      state.archiveDirty = false;
      state.archiveNotice = null;
    } else {
      // 回执只确认提交时的快照；保存期间的后续修改仍属未存档
      state.archiveNotice = `已保存提交时的快照（版本 ${data.version}）；此后草稿又有修改，仍需再次保存。`;
    }
  } catch (e) {
    if (epoch !== state.epoch) return; // 旧请求的失败不在新稿上提示
    if (e.status === 409) {
      // 冲突：保留本地稿，提示读取最新版本，不自动覆盖
      const current = e.detail && typeof e.detail.version === "number" ? e.detail.version : null;
      if (current === null) state.archiveError = errorList(e);
      else state.archiveConflict = current;
    } else {
      state.archiveError = errorList(e);
    }
  } finally {
    if (epoch === state.epoch) {
      state.archiving = false;
      syncArchiveUi();
    }
  }
});

// 冲突横幅上的「读取最新版本」：只读取版本与提示，不覆盖本地稿、不自动恢复。
// 整个读取动作归属发起时的草稿世代：等待期间重新导入或恢复存档会推进世代，
// 旧读取随即失效——其成功、失败与收尾一律落空，不得改动新稿的正文、版本、
// 未存档标记、冲突、提示、错误或按钮状态（否则旧成功会回退新稿已取得的版本，
// 使再次保存遭遇不必要的 409；旧失败会在新稿上误显示错误）
archiveBanner.addEventListener("click", async (ev) => {
  const btn = ev.target.closest('[data-action="archive-read-latest"]');
  if (!btn) return;
  const epoch = state.epoch;
  btn.disabled = true;
  try {
    const data = await api("/api/archive", null, "GET");
    if (epoch !== state.epoch) return; // 已换稿：旧读取结果不得作用于新稿
    if (typeof data.version !== "number") throw new Error("bad archive read");
    state.archiveVersion = data.version;
    state.archiveConflict = null;
    state.archiveError = null;
    state.archiveNotice = data.snapshot
      ? `已读取最新版本（版本 ${data.version}）。再次点「保存存档」将覆盖服务端该版本存档；` +
        `或点「恢复存档」用服务端存档替换本地稿。`
      : "服务端存档当前为空，可直接保存当前草稿。";
  } catch (e) {
    if (epoch !== state.epoch) return; // 已换稿：旧读取的失败不在新稿上提示
    state.archiveError = errorList(e);
  }
  syncArchiveUi();
});

// 恢复存档：先读取最新版本，确认后整份安装。两个入口（工具栏 / 导入面板）共用。
async function restoreArchive() {
  if (state.archiving || state.restoring) return;
  // 未保存编辑、拆分选择或写稿未结束时不可恢复（按钮已禁用，这里兜底）
  if (state.editingId !== null || state.splittingId !== null || state.writing !== null) return;
  const epoch = state.epoch;
  state.restoring = true;
  state.archiveError = null;
  syncArchiveUi();
  let data;
  try {
    data = await api("/api/archive", null, "GET");
  } catch (e) {
    if (epoch !== state.epoch) return; // 已重新导入 / 已恢复：旧读取的失败不在新稿上提示
    state.restoring = false;
    state.archiveError = errorList(e);
    syncArchiveUi();
    return;
  }
  if (epoch !== state.epoch) return; // 等待期间已重新导入 / 已恢复：旧读取结果不再作用
  state.restoring = false;
  if (typeof data.version !== "number") {
    state.archiveError = ["存档响应正文不完整，请重试。"];
    syncArchiveUi();
    return;
  }
  state.archiveVersion = data.version; // 版本知识无论是否恢复都更新
  if (state.archiveConflict !== null) {
    // 此前的冲突随本次读取解除：再保存将覆盖服务端该版本存档
    state.archiveConflict = null;
    state.archiveNotice = `已读取最新版本（版本 ${data.version}）。`;
  }
  if (!data.snapshot) {
    state.archiveNotice = "服务端暂无存档可恢复。";
    syncArchiveUi();
    return;
  }
  if (!validArchiveSnapshot(data.snapshot)) {
    state.archiveError = ["存档内容损坏，无法恢复。"];
    syncArchiveUi();
    return;
  }
  // 恢复须确认：整份替换当前草稿，未保存的修改将丢失
  const ok = confirm(
    `将用服务端存档（版本 ${data.version}）替换当前草稿：\n` +
      `原稿基线、当前顺序、正文与身份上界全部恢复为存档内容，未存档的修改将丢失。\n确定恢复？`,
  );
  if (!ok) {
    syncArchiveUi();
    return;
  }
  installArchive(data.snapshot, data.version);
}

// 存档快照的基本结构检查（写入前服务端已校验，这里仅防御损坏数据）
function validArchiveSnapshot(snap) {
  return (
    snap &&
    typeof snap === "object" &&
    Array.isArray(snap.order_ids) &&
    Array.isArray(snap.clauses) &&
    snap.baseline &&
    Array.isArray(snap.baseline.order_ids) &&
    Array.isArray(snap.baseline.clauses) &&
    Number.isInteger(snap.id_counter)
  );
}

// 整份安装存档：基线、当前顺序、内部正文与已用身份上界一起替换（含失效引用，
// 上界保证继续拆分 / 复制不复用旧身份）；世代推进隔离旧请求，随后重算预览与对照。
function installArchive(snap, version) {
  // 世代 +1 并推进各请求序号：恢复前的一切在途请求（预览 / 保存 / 写稿 / 下载 /
  // 对照 / 引用 / 摘录）的迟到响应一律作废，不作用于恢复后的草稿
  state.epoch += 1;
  writeSeq += 1;
  exportSeq += 1;
  diffSeq += 1;
  refsSeq += 1;
  previewInFlight = false;
  diffInFlight = false;
  refsInFlight = false;
  state.baseline = {
    order_ids: snap.baseline.order_ids.slice(),
    clauses: snap.baseline.clauses.map((c) => ({ id: c.id, body: c.body })),
  };
  state.orderIds = snap.order_ids.slice();
  state.clauses = snap.clauses.map((c) => ({
    id: c.id,
    original: parseInt(c.id.slice(1), 10),
    body: c.body,
  }));
  state.idCounter = snap.id_counter;
  // 临时选择一律不恢复：编辑 / 拆分选择 / 勾选 / 写稿与下载状态清空
  state.editingId = null;
  state.splittingId = null;
  state.splitOffset = null;
  state.splitRefsTo = "front";
  state.pickIds = [];
  state.writing = null;
  state.saving = false;
  state.exporting = false;
  // 锁定仅存本页内存：恢复存档即清空（存档快照不含锁定集合，存档协议不变）
  state.lockIds = [];
  // 复核记录仅存本页内存：成功恢复存档即清空（存档快照本就不含复核记录）；
  // 在途复核稿下载的响应与收尾一律作废
  state.reviews = [];
  state.reviewExporting = false;
  reviewExportSeq += 1;
  // 合并撤销记录仅存本页内存：成功恢复存档即清空（已清除记录不恢复）
  state.mergeRecords = [];
  state.preview = null;
  state.previewError = null;
  state.renderedRev = null;
  state.renderedSplittingId = null;
  state.renderedEditingId = null;
  state.refsId = null;
  state.refsData = null;
  state.refsError = null;
  state.refsFresh = false;
  clearExcerpt();
  state.diffData = null;
  state.diffError = null;
  state.diffFresh = false;
  // 存档状态：恢复稿与服务端存档一致
  state.archiveVersion = version;
  state.archiveConflict = null;
  state.archiveError = null;
  state.archiveNotice = null;
  // 进入校稿台并重算预览与对照；预览失败保留恢复稿、可重试，
  // 预览恢复前禁止旧编号跳转与下载（既有失败横幅机制）
  importPanel.hidden = true;
  desk.hidden = false;
  touch(); // rev+1、预览与对照标记过期并自动重算
  state.archiveDirty = false; // touch 会标未存档；恢复稿与存档一致，复位
  render();
}

archiveRestoreBtn.addEventListener("click", restoreArchive);
archiveRestoreImportBtn.addEventListener("click", restoreArchive);

// --------------------------------------------------------------------------- //
// 导入
// --------------------------------------------------------------------------- //
const SAMPLE = [
  "1|甲方应在合同签订后七日内交付设备。",
  "2|乙方按第 [[1]] 条验收合格后三十日内付款。",
  "3|设备规格与数量见附件，不符合的按 [[1]] 退换。",
  "4|因本合同产生的争议，按 [[5]] 处理。",
  "5|争议提交甲方所在地仲裁委员会仲裁。",
].join("\n");

$("#sample-btn").addEventListener("click", () => {
  importText.value = SAMPLE;
  importErrors.hidden = true;
});

importBtn.addEventListener("click", async () => {
  if (state.importing) return; // 忽略等待期间的重复提交
  state.importing = true;
  importBtn.disabled = true;
  importBtn.textContent = "导入中…";
  try {
    const data = await api("/api/import", { text: importText.value });
    state.clauses = data.clauses.map((c) => ({
      id: c.id,
      original: c.original,
      body: c.body,
    }));
    state.orderIds = state.clauses.map((c) => c.id);
    state.editingId = null;
    state.pickIds = [];
    state.splittingId = null;
    state.splitOffset = null;
    state.splitRefsTo = "front";
    state.writing = null; // 新草稿无写稿在途；上一草稿的在途写稿因世代不符，其响应与收尾一律落空
    state.idCounter = data.clauses.length; // 导入身份为 c1..cN，拆分/复制新身份从 N+1 起
    // 锁定仅存本页内存：换稿即清空（不进存档快照，存档协议不变）
    state.lockIds = [];
    // 成功导入建立不可变原稿基线（深拷贝），同时收起并清空旧对照
    state.baseline = {
      order_ids: state.orderIds.slice(),
      clauses: state.clauses.map((c) => ({ id: c.id, body: c.body })),
    };
    state.diffOpen = false;
    state.diffData = null;
    state.diffError = null;
    state.diffFresh = false;
    diffSeq += 1;
    diffInFlight = false;
    // 新草稿：清空旧的「谁引用本条」目标与结果，迟到响应不再采用
    state.refsId = null;
    state.refsData = null;
    state.refsError = null;
    state.refsFresh = false;
    refsSeq += 1;
    refsInFlight = false;
    state.preview = null;
    state.previewError = null;
    state.renderedRev = null;
    state.renderedSplittingId = null;
    state.renderedEditingId = null;
    // 复核记录仅存本页内存：新草稿的复核重新开始（记录不进存档快照）
    state.reviews = [];
    state.reviewExporting = false;
    // 合并撤销记录仅存本页内存：换稿即清空（不进存档快照）
    state.mergeRecords = [];
    // 新草稿的存档交互重新开始：保留服务端版本知识（仍有效），清掉旧提示；
    // touch() 会把新稿标记为未存档
    state.archiveError = null;
    state.archiveConflict = null;
    state.archiveNotice = null;
    state.epoch += 1; // 新草稿世代：上一草稿的在途请求全部作废
    previewInFlight = false;
    touch();
    importErrors.hidden = true;
    importPanel.hidden = true;
    desk.hidden = false;
    diffPanel.hidden = true;
    diffBtn.textContent = "对照原稿";
    render();
  } catch (e) {
    importErrors.innerHTML = errorList(e).map((m) => `<li>${esc(m)}</li>`).join("");
    importErrors.hidden = false;
  } finally {
    state.importing = false;
    importBtn.disabled = false;
    importBtn.textContent = "导入";
  }
});

$("#reimport-btn").addEventListener("click", () => {
  if (!confirm("重新导入将丢弃当前草稿，确定继续？")) return;
  // 世代 +1：所有在途请求（预览 / 保存 / 合并 / 下载）的迟到响应都会被丢弃，
  // 其成功或失败不再影响新草稿及提示、按钮状态
  state.epoch += 1;
  state.clauses = [];
  state.orderIds = [];
  state.editingId = null;
  state.pickIds = [];
  state.splittingId = null;
  state.splitOffset = null;
  state.splitRefsTo = "front";
  state.idCounter = 0;
  state.lockIds = []; // 锁定仅存本页内存：重新导入即清空
  state.baseline = null; // 重新导入清空原稿基线，成功导入后再建立
  state.diffOpen = false;
  state.diffData = null;
  state.diffError = null;
  state.diffFresh = false;
  diffSeq += 1; // 上一草稿的迟到对照响应一律丢弃
  diffInFlight = false;
  // 重新导入立即清空旧引用查询：目标、结果与在途请求全部作废
  state.refsId = null;
  state.refsData = null;
  state.refsError = null;
  state.refsFresh = false;
  refsSeq += 1;
  refsInFlight = false;
  // 重新导入立即清空旧摘录结果：在途请求的迟到响应不得恢复结果、提示或触发下载
  clearExcerpt();
  state.preview = null;
  state.previewError = null;
  state.renderedRev = null;
  state.renderedSplittingId = null;
  state.renderedEditingId = null;
  state.previewFresh = false;
  state.rev += 1;
  state.saving = false;
  state.writing = null;
  // 存档状态：新草稿未存档；在途存档请求的响应因世代不符被丢弃，这里复位在途态
  state.archiveDirty = true;
  state.archiveError = null;
  state.archiveConflict = null;
  state.archiveNotice = null;
  state.archiving = false;
  state.restoring = false;
  writeSeq += 1; // 作废旧写稿请求：其成功 / 失败 / 收尾不得改新稿或解除新请求的等待状态
  state.exporting = false;
  exportSeq += 1; // 作废旧下载对等待状态的收尾权：其成功或失败都不得解锁新草稿的下载按钮
  // 复核记录仅存本页内存：重新导入即清空；在途复核稿下载的响应与收尾一律作废
  state.reviews = [];
  state.reviewExporting = false;
  reviewExportSeq += 1;
  // 合并撤销记录仅存本页内存：重新导入即清空
  state.mergeRecords = [];
  previewInFlight = false; // 上一草稿在途预览的收尾将因世代不符而直接返回，这里复位在途态
  desk.hidden = true;
  importPanel.hidden = false;
  diffPanel.hidden = true;
  diffBtn.textContent = "对照原稿";
  syncPreviewErrorBanner();
  syncToolbar();
});

// --------------------------------------------------------------------------- //
// 渲染（数据全部以服务端 /api/preview 为准）
// --------------------------------------------------------------------------- //
async function render() {
  const epoch = state.epoch;
  const rev = state.rev;
  const seq = ++previewSeq;
  // 在途标记仅由“当前世代、最后一次”的 render 收尾，迟到响应（已重新导入或
  // 被更新的预览取代）不得清掉新请求的在途状态，也不得改动新稿提示与按钮。
  previewInFlight = true;
  syncPreviewErrorBanner();
  syncBusy();
  try {
    await renderPreview(epoch, rev, seq);
  } catch (e) {
    // 兜底：预览渲染过程中的任何意外都按“预览失败”收尾（而不是把假成功状态留在
    // 页面上导致重试入口消失）。迟到响应（已重新导入 / 被新预览取代）一律丢弃。
    if (seq === previewSeq && epoch === state.epoch && rev === state.rev) {
      failPreview(errorList(e));
    }
  } finally {
    // 已重新导入：旧请求（拆分/合并后的预览等）的响应与收尾一律不得改动
    // 新稿的列表、提示或按钮；在途标记由重新导入处理直接复位
    if (epoch !== state.epoch) return;
    if (seq === previewSeq) previewInFlight = false; // 被更新预览取代时，由最新者收尾
    syncPreviewErrorBanner();
    syncBusy();
  }
}

// 预览失败统一收尾：草稿与既有 DOM 原样保留（不回滚已完成的拆分 / 合并 / 保存、
// 不清空旧列表），标记未追上并显示失败信息与重试入口；列表、引用跳转与下载
// 在预览恢复前保持锁定。调用前须已确认响应仍适用于当前草稿（seq/epoch/rev）。
function failPreview(errors) {
  state.previewFresh = false;
  state.previewError = errors;
  syncToolbar();
  syncPreviewErrorBanner();
  syncBusy();
}

async function renderPreview(epoch, rev, seq) {
  let data;
  try {
    data = await api("/api/preview", snapshot());
  } catch (e) {
    if (seq !== previewSeq || epoch !== state.epoch || rev !== state.rev) return; // 迟到响应：丢弃
    // 预览失败（服务端错误、断网，或已收到响应头但正文读取中断）：
    // 保留当前草稿与既有 DOM，不回滚任何已完成的改动、不清空列表；
    // 显示失败信息与重试入口，列表、引用跳转与下载在预览恢复前保持锁定。
    failPreview(errorList(e));
    return;
  }
  // 只采用仍适用于当前草稿的响应：之后已发出更新的预览、或草稿已变化 / 已重新导入，则丢弃
  if (seq !== previewSeq || epoch !== state.epoch || rev !== state.rev) return;
  // 响应头正常但正文可能被截断成残缺 JSON：只有结构完整、与当前草稿对应的
  // 预览才算有效，否则按失败处理并保留旧列表与重试入口，绝不据其提交状态。
  if (
    !data ||
    !Array.isArray(data.items) ||
    data.items.length !== state.orderIds.length
  ) {
    failPreview(["预览响应正文不完整，请重试。"]);
    return;
  }

  // 先在离屏容器中构建全部新内容；构建期间不触碰页面 DOM、也不提交任何状态。
  // 这样即使构建意外抛错，旧列表仍在、失败/重试入口仍可出现，不会留下“已清空
  // 列表且重试入口消失”的假成功状态。
  const frag = document.createDocumentFragment();
  let brokenTotal = 0;
  const brokenLines = [];

  for (const item of data.items) {
    brokenTotal += item.broken.length;
    if (item.broken.length) {
      const marks = item.broken.map((b) => `[[原${b.original}?]]`).join("、");
      brokenLines.push(
        `<li>第 ${item.display} 条（导入时原第 ${item.original} 条）中的 ${esc(marks)} 已失去目标（原条款已删除）</li>`,
      );
    }

    const li = document.createElement("li");
    li.className =
      "card" +
      (item.broken.length ? " source-broken" : "") +
      (state.pickIds.includes(item.id) ? " selected" : "") +
      (state.lockIds.includes(item.id) ? " locked" : "") +
      (state.refsId === item.id ? " refs-open" : "");
    li.id = `card-${item.id}`;
    li.dataset.id = item.id;

    const isEditing = state.editingId === item.id;
    const isSplitting = state.splittingId === item.id;
    const locked = state.editingId || state.splittingId; // 编辑或拆分选择进行中：锁定其他操作
    const isClLocked = state.lockIds.includes(item.id); // 该条款已定稿锁定
    // 含失效引用的条款不能锁定（后端同样拒绝）；锁定后卡片自身的改稿入口禁用，
    // 但重排（↑↓/拖拽）、勾选仍可用——锁定保护身份、内部正文与有效引用目标，不冻结编号
    const lockable = item.broken.length === 0;
    const atMax = state.orderIds.length >= MAX_CLAUSES;
    li.innerHTML = `
      <div class="card-head">
        <input type="checkbox" class="pick" title="勾选后可合并（恰好两条）或复制（一条或多条）"
          ${state.pickIds.includes(item.id) ? "checked" : ""}
          ${locked ? "disabled" : ""} />
        <span class="grip" title="拖拽调整顺序">⠿</span>
        <span class="num">${item.display}</span>
        <span class="orig">（原第 ${item.original} 条）</span>
        ${item.broken.length ? '<span class="warn-tag">含失效引用</span>' : ""}
        <span class="lock-tag" data-role="lock-tag" title="已定稿：身份、内部正文与有效引用目标受保护，重排与编号变化允许"${
          isClLocked ? "" : " hidden"
        }>🔒 已锁定</span>
        <span class="review-tag" data-role="review-tag" title="本条及其全部可达引用条款的当前正文已复核"${
          state.reviews.some((r) => r.id === item.id) ? "" : " hidden"
        }>已复核</span>
        <span class="card-actions">
          ${
            isEditing || isSplitting
              ? ""
              : `<button data-action="up" ${
                  item.display === 1 || locked ? "disabled" : ""
                }>↑</button>
                 <button data-action="down" ${
                   item.display === data.items.length || locked ? "disabled" : ""
                 }>↓</button>
                 <button data-action="edit" ${
                   locked || isClLocked ? "disabled" : ""
                 }${
                   isClLocked ? ' title="已定稿锁定：解锁后才能编辑"' : ""
                 }>编辑正文</button>
                 <button data-action="refs" ${
                   locked ? "disabled" : ""
                 } title="列出直接引用本条与仅经多级引用可达本条的条款">${
                   state.refsId === item.id ? "收起引用" : "谁引用"
                 }</button>
                 <button data-action="split" ${
                   locked || isClLocked || atMax ? "disabled" : ""
                 }
                   title="${
                     isClLocked
                       ? "已定稿锁定：解锁后才能拆分"
                       : atMax
                         ? `条款总数已达 ${MAX_CLAUSES} 条上限，不能再拆分`
                         : "在选定分界处把本条已保存正文拆成前后两条"
                   }">拆分</button>
                 <button data-action="review" ${locked ? "disabled" : ""}
                   title="记录本条已保存正文及其全部可达引用条款的当前正文；此后相关正文或目标存续变化会清除该复核">复核</button>
                 <button data-action="lock" class="${
                   isClLocked ? "is-locked" : ""
                 }" ${
                   // 写稿等待时仍可切换锁定（纯本页内存操作）；编辑 / 拆分选择中卡片不渲染此按钮；
                   // 含失效引用的条款不能锁定，解锁始终允许（如修复期间想解除）
                   !isClLocked && !lockable ? "disabled" : ""
                 } title="${
                   isClLocked
                     ? "解除定稿锁定"
                     : lockable
                       ? "定稿锁定：保存、删除、合并、拆分不得改变本条身份、内部正文或使其有效引用失效；重排不受限"
                       : "该条款含失效引用，修复后才能锁定"
                 }">${isClLocked ? "解锁" : "锁定"}</button>
                 <button data-action="delete" class="danger" ${
                   locked || isClLocked ? "disabled" : ""
                 }${
                   isClLocked ? ' title="已定稿锁定：解锁后才能删除"' : ""
                 }>删除</button>`
          }
        </span>
      </div>
      ${isEditing ? editorHtml(item) : isSplitting ? splitHtml(item) : `<div class="card-body">${bodyHtml(item)}</div>`}
      ${!isEditing && !isSplitting ? `<div class="referrers" data-role="referrers" hidden></div>` : ""}
    `;
    frag.appendChild(li);
  }

  // 纯文本预览：直接用服务端解析出的 text 拼装，与 /api/export 完全同一逻辑
  const plain = data.items.map((it) => `${it.display}|${it.text}`).join("\n");

  // 失效引用横幅内容
  const brokenHtml = brokenLines.length
    ? `<strong>存在失效引用，修复前禁止下载。</strong>请编辑下列条款，把失效标记改为有效的 [[当前编号]]，或删除该标记：<ul>${brokenLines.join(
        "",
      )}</ul>`
    : "";

  // 新内容已就绪：先替换页面 DOM（不会再抛错），随后一次性提交状态。
  // 只有读到与当前草稿一致的有效预览后，列表 / 引用跳转 / 下载状态才更新；
  // 此前的任何中断都不会清空旧列表或解禁下载与同步工具栏。
  clauseList.textContent = "";
  clauseList.appendChild(frag);
  statCount.textContent = `共 ${data.items.length} 条`;
  statBroken.hidden = brokenTotal === 0;
  statBroken.textContent = `${brokenTotal} 处失效引用`;
  if (brokenLines.length) {
    brokenBanner.hidden = false;
    brokenBanner.innerHTML = brokenHtml;
  } else {
    brokenBanner.hidden = true;
    brokenBanner.textContent = "";
  }
  previewText.textContent = plain;
  previewText.classList.toggle("blocked", data.has_broken);

  state.preview = data;
  state.previewFresh = true;
  state.previewError = null;
  state.renderedRev = rev;
  state.renderedSplittingId = state.splittingId;
  state.renderedEditingId = state.editingId;
  clauseList.classList.toggle("busy", state.writing !== null);
  syncToolbar();

  // 拆分选择器打开时，按当前状态恢复其分界选中态与按钮可用态
  if (state.splittingId) {
    const card = document.getElementById(`card-${state.splittingId}`);
    if (card) refreshSplitUi(card);
  }

  // 「谁引用本条」面板独立于预览：卡片重建后把仍有效的查询结果挂回目标卡；
  // 若目标已随本次草稿消失（删除 / 合并），同步时静默收起；
  // 此前查询停在失败态时，随预览恢复自动重试一次
  if (state.refsId) {
    if (state.refsError && !refsInFlight) refreshReferrers();
    else syncReferrers();
  }

  attachDnd();
}

// 预览正文：把 [[n]] 渲染为可点击引用、[[原X?]] 渲染为失效标记
// 仅在预览响应与当前草稿一致时才会执行（render 已校验），
// 因此这里用 state.orderIds 解释 [[n]] 不会拿新顺序去套旧编号
function bodyHtml(item) {
  let html = "";
  let last = 0;
  for (const m of item.text.matchAll(MARKER)) {
    html += esc(item.text.slice(last, m.index));
    if (m[1] !== undefined) {
      html += `<span class="ref dead" title="失效引用：原第 ${m[1]} 条已删除，请编辑本条修复">[[原${m[1]}?]]</span>`;
    } else {
      const target = state.orderIds[parseInt(m[2], 10) - 1];
      html += `<button type="button" class="ref" data-goto="${esc(target)}">[[${m[2]}]]</button>`;
    }
    last = m.index + m[0].length;
  }
  html += esc(item.text.slice(last));
  return html;
}

function editorHtml(item) {
  return `
    <div class="editor">
      <textarea data-role="edit-text">${esc(item.text)}</textarea>
      <div class="editor-actions">
        <button data-action="save" class="primary">保存</button>
        <button data-action="cancel">取消</button>
        <span class="edit-hint">
          单行条款（回车不换行）；[[数字]] 按保存当刻的显示编号绑定；${
            item.broken.length ? "<b>请先修复 [[原X?]] 标记</b>，否则无法保存；" : ""
          }Ctrl+Enter 快速保存
        </span>
      </div>
      <ul class="edit-errors" data-role="edit-errors" hidden></ul>
    </div>`;
}

// --------------------------------------------------------------------------- //
// 写稿提交协调层（合并 / 拆分 / 复制共用）
// --------------------------------------------------------------------------- //
// 三个写稿入口共用同一条提交管线，请求归属、草稿安装与收尾只在这里实现一次：
// - 请求归属：世代（epoch）+ 提交序号（writeSeq）双重归属。重新导入后旧请求的
//   成功、错误与收尾一律落空——不得改动新稿，也不得解除新请求的等待状态。
// - 互斥：提交期间（state.writing 非空）阻止其他改稿与重复提交，但允许重新导入。
// - 成功写回：正文、顺序与身份上界一起更新（合并不推进上界、拆分推进 1、复制采用
//   接口返回的上界），随后 touch() 使对照 / 引用追踪 / 摘录按原规则失效并刷新预览；
//   此后若预览失败，提交结果与上界保留、仅重试预览（见 render / failPreview），
//   预览恢复前禁止旧编号跳转与下载。
// - 失败：不改正文、顺序、身份上界与勾选（拆分的分界与引用落点随入口状态保留），
//   错误归一化后交回入口按各自方式展示。
// 入口只负责本地预检、参数准备、确认与各自的错误展示；取消不经过这里（不发写稿请求）。
// spec = {
//   kind,              // "merge" | "split" | "duplicate" | "delete"
//   path,              // 接口路径（POST JSON，HTTP 方法 / 字段 / 状态码保持既有约定）
//   params,            // 入口备好的接口参数（草稿快照与 lock_ids 由协调层统一附上）
//   repointed?,        // 成功回包按最新锁定集合核验时的统一改指映射（合并 / 拆分落后段）
//   onSuccess(data)?,  // 入口附加的成功处理（如收起被并条款的引用面板、退出拆分选择器）
//   onError(errors)?,  // 入口各自的错误展示（errors 已归一化为字符串数组）
//   onBusy(busy)?,     // 入口自己的忙碌态展示（如拆分选择器按钮；成功不写回时不再复位）
// }
async function submitWrite(spec) {
  if (state.writing) return; // 已有写稿提交在途：阻止重复提交与其他写稿
  const epoch = state.epoch;
  const token = ++writeSeq;
  state.writing = spec.kind;
  if (spec.onBusy) spec.onBusy(true);
  syncBusy();
  syncToolbar();
  try {
    const data = await api(spec.path, { ...snapshot(), ...spec.params, lock_ids: lockPayload() });
    if (token !== writeSeq || epoch !== state.epoch) return; // 已重新导入：旧结果不得写回新稿
    // 成功回包须按**最新锁定集合**检查（等待期间可能已切换锁定）：违例整次不安装，
    // 不能先更新上界或复核——先在离屏结果上核验，通过后才一次性写回草稿。
    const violations = spec.checkLocks
      ? spec.checkLocks(data, state.lockIds)
      : lockViolationsInResult(data, state.lockIds, spec.repointed || {});
    if (violations.length) {
      state.writing = null;
      if (spec.onBusy) spec.onBusy(false);
      spec.onError(formatLockViolations(violations));
      syncBusy();
      syncToolbar();
      return;
    }
    // 仅在服务端成功且本地锁定核验通过后才改动草稿：正文、顺序与身份上界一起写回，
    // 保证列表 / 预览 / 对照 / 引用追踪 / 摘录 / 下载立即对应同一份草稿
    state.orderIds = data.order_ids;
    state.clauses = data.clauses.map((c) => ({
      id: c.id,
      original: parseInt(c.id.slice(1), 10),
      body: c.body,
    }));
    if (spec.kind === "split") state.idCounter += 1; // 拆分：新身份已投入使用，上界推进 1
    else if (spec.kind === "duplicate") state.idCounter = data.next_id; // 复制：采用接口返回的上界
    // 合并 / 删除：不推进身份上界
    state.writing = null;
    if (spec.onSuccess) spec.onSuccess(data);
    touch();
    render();
  } catch (e) {
    if (token !== writeSeq || epoch !== state.epoch) return; // 旧请求的失败不在新稿上提示
    state.writing = null;
    if (spec.onBusy) spec.onBusy(false);
    spec.onError(errorList(e));
  } finally {
    // 只有仍持有归属的提交才能收尾：重新导入后旧请求的收尾不得改动新稿的
    // 列表状态、提示或按钮，也不得解除新请求的等待状态
    if (token === writeSeq && epoch === state.epoch) {
      syncBusy();
      syncToolbar();
    }
  }
}

// --------------------------------------------------------------------------- //
// 拆分一条条款
// --------------------------------------------------------------------------- //
// 把内部正文解析为文本 / 引用标记 token 序列（内部形态已由服务端校验，标记一定完整）
function splitTokens(body) {
  const tokens = [];
  const re = /\[\[(c\d+)\]\]/g;
  let last = 0;
  for (const m of body.matchAll(re)) {
    if (m.index > last) tokens.push({ type: "text", text: body.slice(last, m.index) });
    tokens.push({ type: "mark", id: m[1] });
    last = m.index + m[0].length;
  }
  if (last < body.length) tokens.push({ type: "text", text: body.slice(last) });
  return tokens;
}

// 引用标记在页面上的显示形态：有效引用为当前显示编号，失效引用为 [[原X?]]
function markDisplay(id) {
  const pos = state.orderIds.indexOf(id);
  return pos >= 0 ? `[[${pos + 1}]]` : `[[原${id.slice(1)}?]]`;
}

function gapHtml(offset) {
  return `<button type="button" class="split-gap" data-gap="${offset}" title="在此处分拆"></button>`;
}

// 拆分选择器：在已保存正文的字符分界处放置拆分点。
// 分界位置按 Unicode 码位计（for...of 逐码位迭代），与服务端 Python 字符串下标一致；
// 引用标记整体作为一个原子，内部不提供分界，保证分界不会切开有效或失效引用标记。
function splitHtml(item) {
  const clause = state.clauses.find((c) => c.id === item.id);
  const tokens = splitTokens(clause.body);
  let offset = 0;
  let body = gapHtml(0);
  for (const tok of tokens) {
    if (tok.type === "text") {
      for (const ch of tok.text) {
        offset += 1;
        body += `<span class="split-ch">${esc(ch)}</span>${gapHtml(offset)}`;
      }
    } else {
      offset += tok.id.length + 4; // [[cX]] 全为 ASCII，两种计数下长度一致
      body += `<span class="ref split-mark">${esc(markDisplay(tok.id))}</span>${gapHtml(offset)}`;
    }
  }
  return `
    <div class="splitter">
      <div class="split-hint">点击字符之间的竖线放置拆分分界（引用标记不可切开，两段都不能只含空白，其余字符原样保留）：</div>
      <div class="split-body">${body}</div>
      <div class="split-opts">
        <span>原指向本条的引用（含本条正文中的自引用）统一改指：</span>
        <label><input type="radio" data-role="split-refs" name="split-refs" value="front"
          ${state.splitRefsTo === "front" ? "checked" : ""} /> 前段（沿用原身份）</label>
        <label><input type="radio" data-role="split-refs" name="split-refs" value="back"
          ${state.splitRefsTo === "back" ? "checked" : ""} /> 后段（获得新身份）</label>
      </div>
      <div class="editor-actions">
        <button data-action="split-confirm" class="primary" disabled>确认拆分</button>
        <button data-action="split-cancel">取消</button>
        <span class="edit-hint" data-role="split-hint"></span>
      </div>
      <ul class="edit-errors" data-role="split-errors" hidden></ul>
    </div>`;
}

// 按 state.splitOffset / splitRefsTo 刷新拆分选择器的选中态、提示与确认按钮可用态
function refreshSplitUi(card) {
  const id = card.dataset.id;
  const offset = state.splitOffset;
  card
    .querySelectorAll(".split-gap")
    .forEach((g) => g.classList.toggle("on", offset !== null && parseInt(g.dataset.gap, 10) === offset));
  const confirmBtn = card.querySelector('[data-action="split-confirm"]');
  const hint = card.querySelector('[data-role="split-hint"]');
  const errBox = card.querySelector('[data-role="split-errors"]');
  if (errBox) errBox.hidden = true;
  if (offset === null) {
    if (confirmBtn) confirmBtn.disabled = true;
    if (hint) hint.textContent = "尚未选择分界位置。";
    return;
  }
  const clause = state.clauses.find((c) => c.id === id);
  const chars = [...clause.body]; // 按码位切分，与服务端 offset 口径一致
  const ok =
    chars.slice(0, offset).join("").trim() !== "" &&
    chars.slice(offset).join("").trim() !== "";
  if (confirmBtn) confirmBtn.disabled = !ok;
  if (hint) {
    hint.textContent = ok
      ? `分界已选：前段 ${offset} 个字符、后段 ${chars.length - offset} 个字符。`
      : "该分界会让其中一段只含空白，请另选位置。";
  }
}

function setSplitBusy(id, busy) {
  const card = document.getElementById(`card-${id}`);
  if (!card) return;
  const confirmBtn = card.querySelector('[data-action="split-confirm"]');
  const cancelBtn = card.querySelector('[data-action="split-cancel"]');
  if (confirmBtn) {
    confirmBtn.disabled = busy;
    confirmBtn.textContent = busy ? "拆分中…" : "确认拆分";
  }
  if (cancelBtn) cancelBtn.disabled = busy;
}

function showSplitError(id, errors) {
  const errBox = document
    .getElementById(`card-${id}`)
    ?.querySelector('[data-role="split-errors"]');
  if (errBox) {
    errBox.innerHTML = errors.map((m) => `<li>${esc(m)}</li>`).join("");
    errBox.hidden = false;
  }
}

async function submitSplit(id) {
  if (state.writing || state.splittingId !== id) return; // 写稿在途或非当前选择器：阻止重复提交
  const clause = state.clauses.find((c) => c.id === id);
  const offset = state.splitOffset;
  if (!clause || offset === null) return;

  // 本地预检（服务端仍会复核；失败一律不改动草稿）
  const chars = [...clause.body];
  if (
    chars.slice(0, offset).join("").trim() === "" ||
    chars.slice(offset).join("").trim() === ""
  ) {
    showSplitError(id, ["拆分后的两段都不能只含空白字符"]);
    return;
  }
  if (state.orderIds.length + 1 > MAX_CLAUSES) {
    showSplitError(id, [`拆分后共 ${state.orderIds.length + 1} 条，超过上限 ${MAX_CLAUSES} 条，不能拆分`]);
    return;
  }

  // 参数准备：后段新身份为本草稿从未用过的 id（删除/合并移除的身份不复用，失效引用不会复活）；
  // 请求归属、草稿写回（含上界推进 1）与收尾由提交协调层统一处理
  const refsTo = state.splitRefsTo;
  const newId = `c${state.idCounter + 1}`;
  // 锁定预检（权威核验仍在服务端）：在拟拆分结果上复用统一核验
  const localSplitViolations = splitLockPrecheck(id, offset, newId, refsTo);
  if (localSplitViolations.length) {
    showSplitError(id, formatLockViolations(localSplitViolations));
    return;
  }
  await submitWrite({
    kind: "split",
    path: "/api/split",
    params: {
      split_id: id,
      offset,
      new_id: newId,
      refs_to: refsTo,
    },
    repointed: refsTo === "back" ? { [id]: newId } : {},
    onBusy: (busy) => setSplitBusy(id, busy),
    onSuccess: () => {
      // 拆分成功：退出选择器，分界与引用落点复位（草稿已由协调层写回）
      state.splittingId = null;
      state.splitOffset = null;
      state.splitRefsTo = "front";
    },
    onError: (errors) => {
      // 拆分请求失败（含断网等异常）：草稿未改动，分界与引用落点保留供重试或取消；
      // 错误信息已归一化，避免异常对象没有 errors 时提示处理再抛异常
      const card = document.getElementById(`card-${id}`);
      if (card) refreshSplitUi(card);
      showSplitError(id, errors);
    },
  });
}

// --------------------------------------------------------------------------- //
// 勾选（合并恰好两条；复制一条或多条）
// --------------------------------------------------------------------------- //
clauseList.addEventListener("change", (ev) => {
  const splitRefs = ev.target.closest('[data-role="split-refs"]');
  if (splitRefs) {
    state.splitRefsTo = splitRefs.value === "back" ? "back" : "front";
    return;
  }
  const pick = ev.target.closest(".pick");
  if (!pick) return;
  const id = pick.closest(".card").dataset.id;
  if (listLocked()) {
    pick.checked = state.pickIds.includes(id); // 合并/拆分/复制提交或预览锁定期间不允许改动选择
    return;
  }
  if (pick.checked) {
    state.pickIds.push(id);
  } else {
    state.pickIds = state.pickIds.filter((x) => x !== id);
  }
  document.getElementById(`card-${id}`).classList.toggle("selected", pick.checked);
  clearExcerpt(); // 切换勾选立即清空旧摘录结果，在途响应回来也不再采用
  updateMergeBtn();
  updateDuplicateBtn();
  updateExcerptBtn();
});

// --------------------------------------------------------------------------- //
// 合并两条条款
// --------------------------------------------------------------------------- //
mergeBtn.addEventListener("click", async () => {
  if (state.writing) return; // 写稿提交在途：阻止重复提交（按钮已禁用，这里兜底）
  if (state.editingId) {
    alert("请先保存或取消正在编辑的正文，再合并条款。");
    return;
  }
  if (state.pickIds.length !== 2 || !state.previewFresh || !state.preview) return;

  // 参数准备：按当前显示顺序确定较前 / 较后条款
  const [a, b] = state.pickIds;
  const keepId = state.orderIds.indexOf(a) < state.orderIds.indexOf(b) ? a : b;
  const dropId = keepId === a ? b : a;
  // 锁定预检（权威核验仍在服务端）：较后身份被锁、较前身份被锁、或任一锁定条款正文
  // 引用较后条款（合并会改指）时整次拒绝。这里仅拦明显情形，复杂交叠由服务端按结果判定。
  const localMergeViolations = mergeLockPrecheck(keepId, dropId);
  if (localMergeViolations.length) {
    alert(formatLockViolations(localMergeViolations).join("\n"));
    return;
  }
  const previewById = Object.fromEntries(state.preview.items.map((it) => [it.id, it]));
  const keep = previewById[keepId];
  const drop = previewById[dropId];
  const inbound = state.clauses.filter(
    (c) => c.body.includes(`[[${dropId}]]`),
  ).length;

  // 撤销记录在请求发出前从当前已保存草稿捕获：两条原文及所有改写引用来源
  // （除保留 / 移除外引用了较后 id 的条款）的合并前内部正文；合并后的正文从
  // 成功回包取得，只有成功安装的合并才会留下记录。
  const keepBefore = state.clauses.find((c) => c.id === keepId).body;
  const dropBefore = state.clauses.find((c) => c.id === dropId).body;
  const sourceBodiesBefore = new Map();
  for (const c of state.clauses) {
    if (c.id === keepId || c.id === dropId) continue;
    if (c.body.includes(`[[${dropId}]]`)) sourceBodiesBefore.set(c.id, c.body);
  }
  const mergeRecord = {
    keep_id: keepId,
    drop_id: dropId,
    keep_body: keepBefore,
    drop_body: dropBefore,
    sources: [],
  };

  const msg =
    `将把当前第 ${drop.display} 条并入第 ${keep.display} 条：\n\n` +
    `第 ${keep.display} 条：${keep.text}\n` +
    `第 ${drop.display} 条：${drop.text}\n\n` +
    `合并后正文（全角分号连接）：\n${keep.text}；${drop.text}\n\n` +
    `合并结果沿用第 ${keep.display} 条（原第 ${keep.original} 条）的位置与身份，` +
    `第 ${drop.display} 条移除，其余条款顺序不变。\n` +
    `共有 ${inbound} 处引用指向第 ${drop.display} 条，合并后全部改指合并结果；` +
    `其他引用不变，已失效引用仍保持失效。\n` +
    `合并成功后可在下方「合并记录」面板撤销（撤回到当前草稿；合并之后无关的校订保留），确定合并？`;
  if (!confirm(msg)) return;

  // 请求归属、草稿写回（合并不推进身份上界）与收尾由提交协调层统一处理
  await submitWrite({
    kind: "merge",
    path: "/api/merge",
    params: { keep_id: keepId, drop_id: dropId },
    repointed: { [dropId]: keepId }, // 回包核验时区分"改指"与"目标删除"
    onSuccess: (data) => {
      // 合并成功安装后留存撤销记录（仅存本页内存）：来源的合并后正文以回包为准，
      // 按结果当前顺序记录，撤销时由后端逐项核验
      const afterById = new Map(data.clauses.map((c) => [c.id, c.body]));
      mergeRecord.sources = [...sourceBodiesBefore.entries()].map(([sid, body]) => ({
        id: sid,
        body,
        after_body: afterById.get(sid),
      }));
      state.mergeRecords.push(mergeRecord);
      // 被并入的较后条款已移除：查询它的面板立即收起清空（查较前条款的保留并自动重查）
      if (state.refsId === dropId) closeReferrers();
      state.pickIds = [];
    },
    onError: (errors) => {
      // 合并失败：草稿未改动，勾选保持不变，可修正后重试
      alert("合并失败，草稿未改动：\n" + errors.join("\n"));
    },
  });
});

// --------------------------------------------------------------------------- //
// 复制所选一组条款
// --------------------------------------------------------------------------- //
duplicateBtn.addEventListener("click", async () => {
  if (state.writing) return; // 写稿提交在途：阻止重复提交（按钮已禁用，这里兜底）
  if (state.editingId || state.splittingId) return; // 未保存编辑 / 拆分选择未结束时不能复制（按钮已禁用，这里兜底）
  const picks = state.pickIds.slice();
  if (!picks.length || !state.previewFresh) return;

  // 本地预检（服务端仍会复核；失败一律不改动草稿）
  const total = state.orderIds.length + picks.length;
  if (total > MAX_CLAUSES) {
    alert(`复制后共 ${total} 条，超过上限 ${MAX_CLAUSES} 条，不能复制。`);
    return;
  }

  // 参数准备：已用身份上界一并提交，副本从 next_id+1 起取新身份；
  // 请求归属、草稿写回（采用接口返回的上界）与收尾由提交协调层统一处理
  await submitWrite({
    kind: "duplicate",
    path: "/api/duplicate",
    params: { selected_ids: picks, next_id: state.idCounter },
    onSuccess: () => {
      state.pickIds = [];
    },
    onError: (errors) => {
      // 复制失败：草稿未改动，勾选保持不变，可修正后重试
      alert("复制失败，草稿未改动：\n" + errors.join("\n"));
    },
  });
});

// --------------------------------------------------------------------------- //
// 列表交互（事件委托）
// --------------------------------------------------------------------------- //
clauseList.addEventListener("click", async (ev) => {
  const goto = ev.target.closest("[data-goto]");
  if (goto) {
    // 预览失败、页面停留在旧编号时禁止用旧编号跳转；合并/拆分提交中也不响应
    if (listLocked()) return;
    const card = document.getElementById(`card-${goto.dataset.goto}`);
    if (card) {
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      card.classList.remove("flash");
      void card.offsetWidth;
      card.classList.add("flash");
    }
    return;
  }

  const gap = ev.target.closest("[data-gap]");
  if (gap) {
    if (listLocked()) return; // 写稿提交 / 列表锁定期间列表已置灰，这里再兜底
    const card = gap.closest(".card");
    if (!card || card.dataset.id !== state.splittingId) return;
    state.splitOffset = parseInt(gap.dataset.gap, 10);
    refreshSplitUi(card);
    return;
  }

  const btn = ev.target.closest("[data-action]");
  if (!btn) return;
  const card = btn.closest(".card");
  const id = card.dataset.id;
  const action = btn.dataset.action;

  // 编辑中、拆分选择中、合并/拆分提交中或预览失败致列表锁定时：
  // 阻止 编辑 / 删除 / 重排 / 打开拆分 / 引用查询 / 复核（按钮已禁用，这里再兜底）。
  // 「锁定 / 解锁」不在此列：写稿等待时也允许切换（纯本页内存操作）；
  // 编辑 / 拆分选择进行中卡片不渲染锁定按钮，无需拦截。
  if (
    ["up", "down", "edit", "delete", "split", "refs", "review"].includes(action) &&
    (state.editingId || state.splittingId || listLocked())
  )
    return;

  if (action === "up" || action === "down") {
    const idx = state.orderIds.indexOf(id);
    const j = action === "up" ? idx - 1 : idx + 1;
    if (j < 0 || j >= state.orderIds.length) return;
    [state.orderIds[idx], state.orderIds[j]] = [state.orderIds[j], state.orderIds[idx]];
    touch();
    render();
  } else if (action === "edit") {
    if (state.lockIds.includes(id)) {
      alert("该条款已定稿锁定，请先解锁再编辑。");
      return;
    }
    closeReferrers(); // 未保存编辑须先结束；引用结果随目标面板收起而清空
    state.editingId = id;
    render().then(() => {
      const ta = clauseList.querySelector(`#card-${id} textarea`);
      if (ta) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
        ta.addEventListener("keydown", onEditorKey);
      }
    });
  } else if (action === "delete") {
    const inbound = state.clauses.filter(
      (c) => c.id !== id && c.body.includes(`[[${id}]]`),
    ).length;
    const lockedHere = state.lockIds.includes(id);
    const blockedRefs = state.clauses.filter(
      (c) => state.lockIds.includes(c.id) && c.body.includes(`[[${id}]]`),
    ).length;
    if (lockedHere || blockedRefs) {
      // 本地先给一道明确提示（服务端仍按实际结果 409 兜底）
      const parts = [];
      if (lockedHere) parts.push("该条款本身已锁定");
      if (blockedRefs) parts.push(`有 ${blockedRefs} 条锁定条款的有效引用指向它`);
      alert(`删除被锁定保护整次拒绝：${parts.join("；")}。请先解锁相关条款。`);
      return;
    }
    const msg =
      `确定删除该条款？\n` +
      (inbound ? `有 ${inbound} 条条款引用它，删除后这些引用将标为失效，修复前无法下载。\n` : "") +
      `（编号会自动重排，此操作在重新导入或刷新前不可撤销）`;
    if (!confirm(msg)) return;
    if (state.refsId === id) closeReferrers(); // 目标即被删条款：先收起并清空，不发注定失效的查询
    // 删除同样经 HTTP 处理并随请求携带锁定集合：即使删除对象未锁定，只要会改变任一
    // 锁定条款或使其引用失效，服务端就整次拒绝（409）；请求归属、草稿写回与收尾复用协调层
    await submitWrite({
      kind: "delete",
      path: "/api/delete",
      params: { delete_id: id },
      onSuccess: () => {
        state.pickIds = state.pickIds.filter((x) => x !== id);
      },
      onError: (errors) => {
        // 删除被拒绝（如锁定保护）：草稿未改动，给出原因
        alert("删除失败，草稿未改动：\n" + errors.join("\n"));
      },
    });
  } else if (action === "cancel") {
    state.editingId = null;
    render();
  } else if (action === "save") {
    await saveEdit(id);
  } else if (action === "split") {
    if (state.orderIds.length >= MAX_CLAUSES) {
      alert(`条款总数已达 ${MAX_CLAUSES} 条上限，不能再拆分。`);
      return;
    }
    closeReferrers(); // 进入拆分选择即收起引用面板、清空结果
    state.splittingId = id;
    state.splitOffset = null;
    state.splitRefsTo = "front";
    render();
  } else if (action === "split-cancel") {
    state.splittingId = null;
    state.splitOffset = null;
    state.splitRefsTo = "front";
    render();
  } else if (action === "split-confirm") {
    await submitSplit(id);
  } else if (action === "review") {
    // 复核只针对已保存正文；编辑 / 拆分选择 / 写稿提交 / 预览未同步时不能复核（函数内再兜底）
    reviewClause(id);
  } else if (action === "lock") {
    // 锁定 / 解锁：本页内存操作，写稿等待时也允许，不改草稿、预览与复核
    toggleLock(id);
  } else if (action === "refs") {
    if (state.refsId === id) {
      closeReferrers(); // 再点一次：收起并清空结果，在途响应回来也不再采用
      return;
    }
    // 切换目标：立即清空旧目标的结果（旧结果不作任何保留），再查新目标
    state.refsId = id;
    state.refsData = null;
    state.refsError = null;
    state.refsFresh = false;
    syncReferrers(); // 更新两张卡片的按钮 / 高亮态并挂载新目标容器
    refreshReferrers();
  }
});

// 预览失败横幅：重试预览；或在拆分/编辑器尚未渲染出来时取消并恢复原草稿卡片操作
previewErrorBanner.addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-action]");
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === "preview-retry") {
    if (previewInFlight) return;
    render();
  } else if (action === "preview-cancel-split") {
    // 原草稿保持不变（拆分尚未成功提交），放弃分界选择并恢复卡片操作
    state.splittingId = null;
    state.splitOffset = null;
    state.splitRefsTo = "front";
    render();
  } else if (action === "preview-cancel-edit") {
    state.editingId = null;
    render();
  }
});

function onEditorKey(ev) {
  if (ev.key === "Enter" && !ev.shiftKey) {
    // 只处理单行条款：Enter 不插入换行；Ctrl/⌘+Enter 保存
    ev.preventDefault();
    if (ev.ctrlKey || ev.metaKey) saveEdit(state.editingId);
  }
}

async function saveEdit(id) {
  if (state.saving) return; // 忽略等待期间的重复提交
  const card = document.getElementById(`card-${id}`);
  if (!card) return;
  const text = card.querySelector("textarea").value;
  const epoch = state.epoch;
  state.saving = true;
  setEditorBusy(id, true);
  try {
    const data = await api("/api/save", {
      ...snapshot(),
      edit_id: id,
      text,
      lock_ids: lockPayload(),
    });
    if (epoch !== state.epoch) return; // 已重新导入：旧保存结果不得作用于新草稿
    // 成功回包按**最新锁定集合**核验：等待期间可能已切换锁定；违例整次不安装，
    // 不先更新草稿、上界或复核，编辑器保留以便用户调整或取消
    const violations = lockViolationsAfterSave(id, data.body, state.lockIds);
    if (violations.length) {
      state.saving = false;
      setEditorBusy(id, false);
      const errBox = document
        .getElementById(`card-${id}`)
        ?.querySelector('[data-role="edit-errors"]');
      if (errBox) {
        errBox.innerHTML = formatLockViolations(violations)
          .map((m) => `<li>${esc(m)}</li>`)
          .join("");
        errBox.hidden = false;
      }
      return;
    }
    const clause = state.clauses.find((c) => c.id === id);
    if (clause) clause.body = data.body;
    state.editingId = null;
    state.saving = false;
    touch();
    render();
  } catch (e) {
    if (epoch !== state.epoch) return; // 旧草稿的失败不在新草稿上提示
    state.saving = false;
    setEditorBusy(id, false);
    // 重新查询当前 DOM：等待期间可能有预览响应重建过编辑器
    const errBox = document
      .getElementById(`card-${id}`)
      ?.querySelector('[data-role="edit-errors"]');
    if (errBox) {
      errBox.innerHTML = errorList(e).map((m) => `<li>${esc(m)}</li>`).join("");
      errBox.hidden = false;
    }
  }
}

// 保存等待期间禁用编辑器按钮，结束后恢复（DOM 可能已被重建，按当前节点操作）
function setEditorBusy(id, busy) {
  const card = document.getElementById(`card-${id}`);
  if (!card) return;
  const saveBtn = card.querySelector('[data-action="save"]');
  const cancelBtn = card.querySelector('[data-action="cancel"]');
  if (saveBtn) {
    saveBtn.disabled = busy;
    saveBtn.textContent = busy ? "保存中…" : "保存";
  }
  if (cancelBtn) cancelBtn.disabled = busy;
}

// --------------------------------------------------------------------------- //
// 拖拽重排
// --------------------------------------------------------------------------- //
function attachDnd() {
  for (const card of clauseList.querySelectorAll(".card")) {
    const grip = card.querySelector(".grip");
    grip.addEventListener("mousedown", () => {
      if (!state.editingId && !state.splittingId && !listLocked())
        card.draggable = true;
    });
    card.addEventListener("mouseup", () => (card.draggable = false));

    card.addEventListener("dragstart", (ev) => {
      if (state.editingId || state.splittingId || listLocked()) {
        ev.preventDefault();
        return;
      }
      state.dragId = card.dataset.id;
      card.classList.add("dragging");
      ev.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("dragend", () => {
      card.draggable = false;
      card.classList.remove("dragging");
      clauseList.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
      state.dragId = null;
    });
    card.addEventListener("dragover", (ev) => {
      if (!state.dragId || state.dragId === card.dataset.id) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "move";
      clauseList.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
      card.classList.add("drag-over");
    });
    card.addEventListener("drop", (ev) => {
      ev.preventDefault();
      const targetId = card.dataset.id;
      if (!state.dragId || state.dragId === targetId) return;
      const rect = card.getBoundingClientRect();
      const after = ev.clientY > rect.top + rect.height / 2;
      moveClause(state.dragId, targetId, after);
    });
  }
}

function moveClause(srcId, targetId, after) {
  const ids = state.orderIds.filter((x) => x !== srcId);
  let idx = ids.indexOf(targetId);
  if (after) idx += 1;
  ids.splice(idx, 0, srcId);
  state.orderIds = ids;
  touch();
  render();
}

// --------------------------------------------------------------------------- //
// 原稿对照（与预览相互独立：成功导入后保留不可变基线，对照当前已保存草稿）
// --------------------------------------------------------------------------- //
const DIFF_TAGS = {
  added: { label: "新增", cls: "tag-add" },
  deleted: { label: "删除", cls: "tag-del" },
  body_changed: { label: "正文改动", cls: "tag-body" },
  moved: { label: "移动", cls: "tag-move" },
};

// 把已解析正文（[[n]] 或 [[原X?]]）渲染为带标记样式的 HTML；引用在对照中不可点击
function diffTextHtml(text) {
  let html = "";
  let last = 0;
  for (const m of text.matchAll(MARKER)) {
    html += esc(text.slice(last, m.index));
    if (m[1] !== undefined) {
      html += `<span class="ref dead">[[原${m[1]}?]]</span>`;
    } else {
      html += `<span class="ref">[[${m[2]}]]</span>`;
    }
    last = m.index + m[0].length;
  }
  html += esc(text.slice(last));
  return html;
}

function tagHtml(tags) {
  return tags
    .map((t) => {
      const meta = DIFF_TAGS[t] || { label: t, cls: "" };
      return `<span class="diff-tag ${meta.cls}">${meta.label}</span>`;
    })
    .join("");
}

function numCell(no, text) {
  return no === null || no === undefined ? `<span class="diff-no none">${text}</span>` : `<span class="diff-no">${no}</span>`;
}

function diffItemHtml(item) {
  const isDelete = item.tags.includes("deleted");
  const isAdd = item.tags.includes("added");
  const baseBody =
    item.baseline_text === null || item.baseline_text === undefined
      ? `<div class="diff-text none">（原稿无此条款）</div>`
      : `<div class="diff-text">${diffTextHtml(item.baseline_text)}</div>`;
  const curBody =
    item.current_text === null || item.current_text === undefined
      ? `<div class="diff-text none">（现已删除）</div>`
      : `<div class="diff-text">${diffTextHtml(item.current_text)}</div>`;
  return `
    <li class="diff-row ${isDelete ? "is-deleted" : ""}">
      <div class="diff-row-head">
        ${tagHtml(item.tags)}
        <span class="diff-nums">
          原编号 ${numCell(item.baseline_no, "—")}
          → 现编号 ${numCell(item.current_no, "—")}
          <span class="diff-id">（稳定身份 ${esc(item.id)}）</span>
        </span>
      </div>
      ${isAdd || isDelete ? "" : `<div class="diff-bodies">`}
      ${
        isAdd
          ? `<div class="diff-col"><span class="diff-col-label">现稿正文</span>${curBody}</div>`
          : isDelete
            ? `<div class="diff-col"><span class="diff-col-label">原稿正文</span>${baseBody}</div>`
            : `<div class="diff-col"><span class="diff-col-label">原稿正文（原第 ${item.baseline_no} 条）</span>${baseBody}</div>
               <div class="diff-col"><span class="diff-col-label">现稿正文（现第 ${item.current_no} 条）</span>${curBody}</div>`
      }
      ${isAdd || isDelete ? "" : `</div>`}
    </li>`;
}

// 正文未变、但某条引用由基线有效变为现稿失效：另列来源及位置
function invalidRefHtml(rec) {
  return `
    <li class="invalid-row">
      <div class="diff-row-head">
        <span class="diff-tag tag-ref">引用失效</span>
        <span class="diff-nums">
          来源：原编号 ${numCell(rec.baseline_no)} → 现编号 ${numCell(rec.current_no)}
          <span class="diff-id">（稳定身份 ${esc(rec.source_id)}）</span>
          · 失效引用 <span class="ref dead">[[原${rec.ref_original}?]]</span>
          （原第 ${rec.ref_original} 条已删除；正文第 ${rec.position}～${rec.position_end} 个字符处）
        </span>
      </div>
      <div class="diff-bodies">
        <div class="diff-col"><span class="diff-col-label">原稿正文</span><div class="diff-text">${diffTextHtml(rec.baseline_text)}</div></div>
        <div class="diff-col"><span class="diff-col-label">现稿正文（正文未变，引用已失效）</span><div class="diff-text">${diffTextHtml(rec.current_text)}</div></div>
      </div>
    </li>`;
}

// 渲染对照面板。改稿后旧对照立即失效：在新草稿的对照响应到达前，
// 保留旧内容仅用于“已失效”提示（置灰），绝不用迟到响应覆盖新结果。
function renderDiff() {
  const stale = !state.diffFresh;
  diffPanel.classList.toggle("stale", stale);
  diffPanel.classList.toggle("busy", stale && diffInFlight);

  if (state.diffError) {
    diffStatus.textContent = "";
    diffBanner.hidden = false;
    diffBanner.innerHTML =
      `<strong>对照刷新失败。</strong>仍显示上次已提交草稿的对照结果（如有），草稿未改动。` +
      `<ul>${state.diffError.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>` +
      `<div class="preview-error-actions"><button type="button" class="primary" data-action="diff-retry"${
        diffInFlight ? " disabled" : ""
      }>${diffInFlight ? "重试中…" : "重试对照"}</button></div>`;
  } else {
    diffBanner.hidden = true;
    diffBanner.textContent = "";
  }

  const data = state.diffData;
  if (!data || !Array.isArray(data.items) || !Array.isArray(data.invalid_refs)) {
    diffStatus.textContent = diffInFlight ? "对照中…" : stale ? "旧对照已失效，正在按最新草稿重新对照…" : "";
    diffBody.textContent = "";
    return;
  }

  const parts = [];
  if (!data.items.length && !data.invalid_refs.length) {
    parts.push('<p class="diff-empty">无变更</p>');
  } else {
    if (data.items.length) {
      parts.push(
        `<ul class="diff-list">${data.items.map(diffItemHtml).join("")}</ul>`,
      );
    } else {
      parts.push('<p class="diff-empty">无变更</p>');
    }
    if (data.invalid_refs.length) {
      parts.push(
        `<h3 class="diff-subhead">正文未变但引用由有效变失效（${data.invalid_refs.length} 处）</h3>` +
          `<ul class="diff-list invalid-list">${data.invalid_refs.map(invalidRefHtml).join("")}</ul>`,
      );
    }
  }
  diffStatus.textContent = stale
    ? diffInFlight
      ? "旧对照已失效，正在重新对照…"
      : "旧对照已失效"
    : "已与当前草稿一致";
  diffStatus.classList.toggle("is-stale", stale);
  diffStatus.classList.toggle("is-fresh", !stale);
  diffBody.innerHTML = parts.join("");
}

function syncDiffPanel() {
  if (!state.diffOpen) return;
  diffPanel.hidden = false;
  diffBtn.textContent = "收起对照";
  renderDiff();
}

// 按当前已保存草稿向 /api/diff 请求对照；预览成功与否互不影响。
// 只有最后一次发出、且仍对应当前草稿的响应才会被采用。
async function refreshDiff() {
  if (!state.baseline) return;
  const seq = ++diffSeq;
  const rev = state.rev;
  diffInFlight = true;
  renderDiff();
  let data;
  try {
    data = await api("/api/diff", { baseline: snapshotBaseline(), current: snapshot() });
  } catch (e) {
    // 迟到响应（草稿已再改动 / 已重新导入 / 被更新请求取代）不得覆盖新结果，
    // 也不得清掉最新请求的在途标记；在途标记只由最新请求收尾
    if (seq !== diffSeq || rev !== state.rev) return;
    // 预览刷新失败仍按已提交草稿对照：对照失败时保留旧结果并给出重试入口，
    // 不锁定列表、不影响下载等既有操作
    diffInFlight = false;
    state.diffError = errorList(e);
    renderDiff();
    return;
  }
  // 改稿后旧对照立即失效：迟到响应不得覆盖新结果；在途标记同样只由最新者清
  if (seq !== diffSeq || rev !== state.rev) return;
  diffInFlight = false;
  if (
    !data ||
    !Array.isArray(data.items) ||
    !Array.isArray(data.invalid_refs)
  ) {
    state.diffError = ["对照响应正文不完整，请重试。"];
    renderDiff();
    return;
  }
  state.diffData = data;
  state.diffError = null;
  state.diffFresh = true;
  renderDiff();
}

diffBtn.addEventListener("click", () => {
  if (!state.baseline) return;
  state.diffOpen = !state.diffOpen;
  diffPanel.hidden = !state.diffOpen;
  diffBtn.textContent = state.diffOpen ? "收起对照" : "对照原稿";
  if (state.diffOpen) {
    // 打开时若尚未追上当前草稿（首次打开或改稿后），按已提交草稿发起对照；
    // 已有一致结果则直接展示，不重复请求
    if (!state.diffFresh) refreshDiff();
    else renderDiff();
  } else {
    diffSeq += 1; // 收起后在途响应回来也不再采用
  }
});

// 对照失败横幅上的重试入口
diffBanner.addEventListener("click", (ev) => {
  const btn = ev.target.closest('[data-action="diff-retry"]');
  if (!btn || diffInFlight) return;
  refreshDiff();
});

// --------------------------------------------------------------------------- //
// 谁引用本条（只读查询：不改正文、顺序、基线或引用绑定）
// --------------------------------------------------------------------------- //
// 收起引用面板并立即清空全部旧结果；在途请求的序号同时作废，迟到响应既不能恢复
// 旧结果也不会弹出提示。
function closeReferrers() {
  const prev = state.refsId;
  state.refsId = null;
  state.refsData = null;
  state.refsError = null;
  state.refsFresh = false;
  refsSeq += 1;
  refsInFlight = false;
  // 仅更新受影响卡片（目标卡与潜在高亮）；DOM 可能已因重渲染重建
  for (const id of [prev].filter(Boolean)) {
    const card = document.getElementById(`card-${id}`);
    if (card) card.classList.remove("refs-open");
  }
  syncReferrers();
}

// 同步当前展开卡片的结果容器（独立于 /api/preview 的渲染：面板不随预览重建）。
// 目标卡片若已不在 DOM（被删除 / 合并移除），静默收起并清空。
function syncReferrers() {
  const id = state.refsId;
  // 同步所有已渲染卡片：非目标卡取消高亮并隐藏其结果容器，目标卡展开挂载内容
  document.querySelectorAll(".card").forEach((card) => {
    const isTarget = card.dataset.id === id;
    card.classList.toggle("refs-open", isTarget);
    const box = card.querySelector('[data-role="referrers"]');
    if (box && !isTarget) {
      box.hidden = true;
      box.textContent = "";
    }
    const btn = card.querySelector('[data-action="refs"]');
    if (btn) btn.textContent = isTarget ? "收起引用" : "谁引用";
  });
  if (!id) return;
  const card = document.getElementById(`card-${id}`);
  if (!card) {
    // 目标条款已被删除或经合并移除：立即清空，不保留任何旧结果
    closeReferrers();
    return;
  }
  const box = card.querySelector('[data-role="referrers"]');
  if (box) {
    box.hidden = false;
    box.innerHTML = referrersHtml();
  }
}

function referrerChainHtml(entry) {
  // 链中每个条款都可点击定位：点击后高亮并滚动到对应卡片
  const chips = entry.chain
    .map(
      (no, i) =>
        `<button type="button" class="ref chain-ref" data-goto="${esc(entry.chain_ids[i])}">第 ${no} 条</button>` +
        (i < entry.chain.length - 1 ? '<span class="chain-arrow"> → </span>' : ""),
    )
    .join("");
  return `
    <li class="ref-row">
      <span class="ref-chain">${chips}</span>
      <span class="diff-id">（稳定身份 ${esc(entry.id)}，当前第 ${entry.current_no} 条）</span>
    </li>`;
}

function referrerGroupHtml(title, rows, emptyText) {
  if (!rows.length) return `<p class="refs-group-empty">${emptyText}</p>`;
  return (
    `<div class="refs-group-title">${title}（${rows.length}）</div>` +
    `<ul class="ref-list">${rows.map(referrerChainHtml).join("")}</ul>`
  );
}

function referrersHtml() {
  const target = state.refsId;
  if (!target) return "";
  // 目标当前编号以已保存草稿的顺序为准（与预览编号口径一致）
  const targetNo = state.orderIds.indexOf(target) + 1;
  const head =
    `<div class="refs-head"><strong>谁引用本条</strong>` +
    `<span class="refs-target">目标：当前第 ${targetNo} 条（稳定身份 ${esc(target)}）</span>` +
    `<button type="button" class="refs-close" data-action="refs-close">×</button></div>`;
  if (state.refsError) {
    return (
      head +
      `<div class="refs-error">` +
      `查询失败，草稿未改动：<ul>${state.refsError.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>` +
      `<button type="button" class="primary" data-action="refs-retry"${
        refsInFlight ? " disabled" : ""
      }>${refsInFlight ? "查询中…" : "重试"}</button></div>`
    );
  }
  const data = state.refsData;
  if (!data || !state.refsFresh) {
    return head + `<p class="refs-loading">${refsInFlight ? "查询中…" : "结果已失效，正在重新查询…"}</p>`;
  }
  // 查询结果以新草稿编号为准；预览尚未追上（如预览失败停留旧编号）时，
  // 不展示链，避免与卡片上的旧编号不一致；预览恢复后自动重新挂载
  if (!state.previewFresh) {
    return head + `<p class="refs-loading">预览恢复后展示与当前编号一致的引用链…</p>`;
  }
  const total = data.direct.length + data.indirect.length;
  if (!total) return head + `<p class="refs-empty">没有任何条款引用本条（直接 / 间接引用均为空）。</p>`;
  return (
    head +
    referrerGroupHtml("直接引用者", data.direct, "无直接引用者") +
    referrerGroupHtml("间接引用者（仅经多级引用可达）", data.indirect, "无间接引用者")
  );
}

// 按当前已保存草稿请求 /api/referrers；只采用最后一次发出、且仍对应当前草稿
// 与当前目标的响应。改稿 / 切换目标 / 重新导入后，迟到响应既不能恢复旧结果，
// 也不会在新状态上弹出提示。
async function refreshReferrers() {
  const id = state.refsId;
  if (!id) return;
  const seq = ++refsSeq;
  const rev = state.rev;
  refsInFlight = true;
  syncReferrers();
  let data;
  try {
    data = await api("/api/referrers", { ...snapshot(), target_id: id });
  } catch (e) {
    if (seq !== refsSeq || state.refsId !== id || rev !== state.rev) return;
    refsInFlight = false;
    state.refsError = errorList(e);
    syncReferrers();
    return;
  }
  if (seq !== refsSeq || state.refsId !== id || rev !== state.rev) return;
  refsInFlight = false;
  if (
    !data ||
    !Array.isArray(data.direct) ||
    !Array.isArray(data.indirect) ||
    data.target_id !== id
  ) {
    state.refsError = ["引用查询响应不完整，请重试。"];
    syncReferrers();
    return;
  }
  state.refsData = data;
  state.refsError = null;
  state.refsFresh = true;
  syncReferrers();
}

// 引用结果容器内：收起、重试；链中条款的点击定位由列表统一的 data-goto 处理
clauseList.addEventListener("click", (ev) => {
  const btn = ev.target.closest('[data-action="refs-close"], [data-action="refs-retry"]');
  if (!btn) return;
  if (btn.dataset.action === "refs-close") {
    closeReferrers();
  } else if (!refsInFlight) {
    // 重试前同样清空旧错误内容，避免旧提示残留
    state.refsError = null;
    refreshReferrers();
  }
});

// --------------------------------------------------------------------------- //
// 勾选条款摘录（只读：不改正文、顺序、基线、身份上界或引用绑定）
// --------------------------------------------------------------------------- //
// 摘录结果只对应“某一修订号 + 某一组勾选”：改稿、切换勾选或重新导入时立即清空
// （旧结果不置灰保留），并推进请求序号——在途请求的迟到响应既不能恢复结果与提示，
// 也不会触发下载。
function clearExcerpt() {
  state.excerptData = null;
  state.excerptError = null;
  state.excerpting = false;
  excerptSeq += 1;
  syncExcerptPanel();
}

// 编号映射表：摘录编号 ↔ 草稿编号（当前显示编号）↔ 稳定身份
function excerptMapHtml(items) {
  const rows = items
    .map(
      (it) =>
        `<tr><td class="excerpt-no">${it.excerpt_no}</td>` +
        `<td>第 ${it.draft_no} 条</td>` +
        `<td><span class="diff-id">${esc(it.id)}</span>（原第 ${it.original} 条）</td></tr>`,
    )
    .join("");
  return (
    `<table class="excerpt-map"><thead><tr>` +
    `<th>摘录编号</th><th>草稿编号</th><th>稳定身份</th>` +
    `</tr></thead><tbody>${rows}</tbody></table>`
  );
}

function syncExcerptPanel() {
  const active = state.excerpting || state.excerptError !== null || state.excerptData !== null;
  excerptPanel.hidden = !active;
  if (!active) {
    excerptBody.innerHTML = "";
    excerptBanner.hidden = true;
    excerptBanner.textContent = "";
    excerptStatus.textContent = "";
    return;
  }
  if (state.excerptError) {
    excerptStatus.textContent = "摘录导出被拒绝";
    excerptBanner.hidden = false;
    excerptBanner.innerHTML =
      `<strong>摘录导出失败，整份未生成。</strong>草稿、基线与引用绑定均未改动：` +
      `<ul>${state.excerptError.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>`;
  } else {
    excerptBanner.hidden = true;
    excerptBanner.textContent = "";
    excerptStatus.textContent = state.excerpting
      ? "摘录导出中…"
      : `共收录 ${state.excerptData.items.length} 条（含直接、间接引用的条款），摘录内编号从 1 连续排列`;
  }
  const data = state.excerptData;
  excerptBody.innerHTML = data
    ? excerptMapHtml(data.items) +
      `<pre class="preview excerpt-text">${esc(data.text)}</pre>` +
      `<div class="excerpt-actions">` +
      `<button type="button" class="primary" data-action="excerpt-download">下载摘录</button>` +
      `<button type="button" data-action="excerpt-close">收起</button>` +
      `</div>`
    : "";
}

// 按当前已保存草稿与当前勾选请求 /api/excerpt；只采用仍持有收尾权的响应——
// 改稿、切换勾选或重新导入都会推进序号，迟到响应不得恢复结果、提示或触发下载。
excerptBtn.addEventListener("click", async () => {
  if (state.excerpting) return; // 忽略等待期间的重复提交
  if (state.editingId || state.splittingId) return; // 未保存编辑 / 拆分选择须先结束（按钮已禁用，这里兜底）
  const picks = state.pickIds.slice();
  if (!picks.length || !state.previewFresh) return;
  const token = ++excerptSeq;
  const epoch = state.epoch;
  const rev = state.rev;
  state.excerpting = true;
  state.excerptData = null;
  state.excerptError = null;
  syncToolbar();
  syncExcerptPanel();
  try {
    const data = await api("/api/excerpt", { ...snapshot(), selected_ids: picks });
    if (token !== excerptSeq || epoch !== state.epoch || rev !== state.rev) return; // 迟到响应：丢弃
    state.excerpting = false;
    if (!data || typeof data.text !== "string" || !Array.isArray(data.items)) {
      state.excerptError = ["摘录响应正文不完整，请重试。"];
    } else {
      state.excerptData = data;
    }
    syncToolbar();
    syncExcerptPanel();
  } catch (e) {
    if (token !== excerptSeq || epoch !== state.epoch || rev !== state.rev) return; // 旧请求的失败不在新状态上提示
    state.excerpting = false;
    state.excerptError = errorList(e);
    syncToolbar();
    syncExcerptPanel();
  }
});

// 摘录面板内：下载本次结果的文本、收起面板
excerptPanel.addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-action]");
  if (!btn) return;
  if (btn.dataset.action === "excerpt-close") {
    clearExcerpt();
    updateExcerptBtn();
  } else if (btn.dataset.action === "excerpt-download") {
    // 下载的是页面上正展示的最近一次成功结果；改稿 / 切换勾选 / 重新导入已清空结果，
    // 迟到响应不会恢复旧结果，因此保存的文件一定与当前展示一致
    const data = state.excerptData;
    if (!data) return;
    const blob = new Blob([data.text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
    a.href = url;
    a.download = `excerpt-${stamp}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }
});

// --------------------------------------------------------------------------- //
// 逐条复核（记录仅存本页内存；下载时由服务端按同一规则核对）
// --------------------------------------------------------------------------- //
// 复核记录捕获：被复核条款的稳定身份，以及复核当刻它自身和全部可达引用条款
// （沿目标仍在草稿内的有效引用，自引用、循环与重复引用只计一次）的内部正文。
// 复核只针对已保存正文：编辑 / 拆分选择 / 写稿提交未结束或预览未同步时不能复核。
function reviewClosure(startId) {
  const byId = new Map(state.clauses.map((c) => [c.id, c.body]));
  const seen = {};
  const queue = [startId];
  while (queue.length) {
    const cid = queue.shift();
    if (seen[cid] !== undefined || !byId.has(cid)) continue;
    seen[cid] = byId.get(cid);
    for (const m of byId.get(cid).matchAll(/\[\[(c\d+)\]\]/g)) {
      if (seen[m[1]] === undefined) queue.push(m[1]);
    }
  }
  return seen;
}

// 每次改稿成功后（touch）清除失效复核：记录中的正文或目标存续有变化即清除；
// 纯重排、编号平移与无关改动保留复核；清除后改回旧文也不自动恢复。
// 取消编辑 / 拆分与保存、写稿失败不经过 touch()，因此不影响记录。
function pruneReviews() {
  if (!state.reviews.length) return;
  const byId = new Map(state.clauses.map((c) => [c.id, c.body]));
  state.reviews = state.reviews.filter((rec) =>
    Object.entries(rec.bodies).every(([cid, body]) => byId.get(cid) === body),
  );
}

// 未复核项：现存条款中没有有效复核记录的，按当前顺序排列
function unreviewedIds() {
  const reviewed = new Set(state.reviews.map((r) => r.id));
  return state.orderIds.filter((id) => !reviewed.has(id));
}

// 点卡片上的「复核」：以当前已保存正文建立 / 刷新该条的复核记录（新条款默认未复核）
function reviewClause(id) {
  if (state.editingId || state.splittingId || state.writing || !state.previewFresh) return;
  if (!state.orderIds.includes(id)) return;
  const bodies = reviewClosure(id);
  const rec = state.reviews.find((r) => r.id === id);
  if (rec) rec.bodies = bodies; // 重新复核：以当前已保存正文刷新记录
  else state.reviews.push({ id, bodies });
  syncReviewPanel();
}

function syncReviewPanel() {
  const total = state.orderIds.length;
  const pending = unreviewedIds();
  reviewStatus.textContent = total ? `已复核 ${total - pending.length} / ${total} 条` : "";
  if (!total) {
    reviewBody.innerHTML = "";
  } else if (!pending.length) {
    const broken = state.preview && state.preview.has_broken;
    reviewBody.innerHTML =
      `<p class="review-done">全部现存条款已复核。` +
      (broken
        ? `仍存在失效引用，修复后才能下载复核稿。`
        : `可下载复核稿（格式与整稿导出一致）。`) +
      `</p>`;
  } else {
    const byId = new Map(state.clauses.map((c) => [c.id, c]));
    const rows = pending
      .map((id) => {
        const no = state.orderIds.indexOf(id) + 1;
        const clause = byId.get(id);
        const original = clause ? clause.original : id.slice(1);
        return (
          `<li class="review-row">` +
          `<button type="button" class="ref chain-ref" data-goto="${esc(id)}">第 ${no} 条</button>` +
          `<span class="diff-id">（原第 ${original} 条，稳定身份 ${esc(id)}）</span>` +
          `</li>`
        );
      })
      .join("");
    reviewBody.innerHTML =
      `<p class="review-pending-head">未复核 ${pending.length} 条（按当前顺序，点击定位）：</p>` +
      `<ul class="review-list">${rows}</ul>`;
  }
  updateReviewDownloadBtn();
  syncReviewTags();
}

// 复核稿下载：全部现存条款已复核且无失效引用，且未保存编辑 / 拆分选择 / 写稿提交
// 未结束、预览已同步时才可用
function updateReviewDownloadBtn() {
  const pending = unreviewedIds();
  const busyEditing =
    state.editingId !== null || state.splittingId !== null || state.writing !== null;
  reviewDownloadBtn.disabled =
    state.reviewExporting ||
    busyEditing ||
    !state.previewFresh ||
    !state.preview ||
    state.preview.has_broken ||
    pending.length > 0;
  reviewDownloadBtn.textContent = state.reviewExporting ? "下载中…" : "下载复核稿";
  reviewDownloadBtn.title = state.reviewExporting
    ? ""
    : busyEditing
      ? "未保存编辑、拆分选择或写稿提交未结束时不能下载复核稿"
      : !state.previewFresh
        ? "预览未同步到最新草稿时不能下载复核稿"
        : state.preview && state.preview.has_broken
          ? "存在失效引用，修复后才能下载复核稿"
          : pending.length
            ? "全部现存条款复核后才能下载复核稿"
            : "全部现存条款已复核且无失效引用，可下载复核稿";
}

// 卡片上的「已复核」标记随记录同步（预览重建卡片时按 state.reviews 渲染，这里处理
// 复核点击后不重建卡片的即时更新）
function syncReviewTags() {
  const reviewed = new Set(state.reviews.map((r) => r.id));
  document.querySelectorAll(".card").forEach((card) => {
    const tag = card.querySelector('[data-role="review-tag"]');
    if (tag) tag.hidden = !reviewed.has(card.dataset.id);
  });
}

// 复核面板内：点击未复核项定位到对应卡片（预览失败停留旧编号时禁止跳转）
reviewPanel.addEventListener("click", (ev) => {
  const goto = ev.target.closest("[data-goto]");
  if (!goto) return;
  if (listLocked()) return;
  const card = document.getElementById(`card-${goto.dataset.goto}`);
  if (card) {
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.classList.remove("flash");
    void card.offsetWidth;
    card.classList.add("flash");
  }
});

// 下载复核稿：服务端按同一规则核对草稿与复核记录，全部现存条款已复核且无失效引用
// 才返回文本（格式与整稿导出一致）。与「下载纯文本」同一归属规则：等待期间改稿或
// 换稿（重新导入 / 恢复存档）的，旧响应不得保存文件、弹提示或影响新一次下载。
reviewDownloadBtn.addEventListener("click", async () => {
  if (reviewDownloadBtn.disabled) return; // 未全部复核 / 有失效引用 / 编辑拆分写稿未结束 / 预览未同步 / 在途
  const token = ++reviewExportSeq;
  state.reviewExporting = true;
  syncReviewPanel();
  const epoch = state.epoch;
  const rev = state.rev;
  const reviews = state.reviews.map((r) => ({ id: r.id, bodies: { ...r.bodies } }));
  try {
    const data = await api("/api/review/export", { ...snapshot(), reviews });
    if (token !== reviewExportSeq) return; // 已重新导入 / 恢复存档 / 被新下载取代：旧响应静默丢弃
    if (epoch !== state.epoch) return; // 旧草稿的响应：静默丢弃
    if (rev !== state.rev) {
      // 等待期间草稿又有改动：下载内容已与页面不一致，取消本次下载
      alert("草稿在下载期间又有改动，本次下载已取消，请重新下载。");
      return;
    }
    if (!data || typeof data.text !== "string") {
      alert("复核稿响应正文不完整，请重试。");
      return;
    }
    const blob = new Blob([data.text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
    a.href = url;
    a.download = `reviewed-${stamp}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    if (token !== reviewExportSeq || epoch !== state.epoch || rev !== state.rev) return; // 已不属于当前下载：不提示
    alert(errorList(e).join("\n"));
  } finally {
    // 只有仍持有收尾权的下载才能清掉等待状态：旧下载提前返回时不得影响新下载
    if (token === reviewExportSeq) {
      state.reviewExporting = false;
      syncReviewPanel();
    }
  }
});

// --------------------------------------------------------------------------- //
// 合并记录与误合并撤销（记录仅存本页内存；撤销经 /api/merge/undo）
// --------------------------------------------------------------------------- //
// 把内部形态正文（[[cX]]）解析成便于人读的当前形态：现存身份显示为 [[当前编号]]，
// 已不存在的身份显示为 [[原N?]]（与预览、对照口径一致）。
function internalToDisplay(body) {
  return body.replace(/\[\[(c\d+)\]\]/g, (m, cid) => {
    const pos = state.orderIds.indexOf(cid);
    return pos >= 0 ? `[[${pos + 1}]]` : `[[原${cid.slice(1)}?]]`;
  });
}

// 单条合并记录的渲染：列出保留 / 移除身份、两条原文、各改写来源的前后正文，
// 以及「撤销」入口（未保存编辑、拆分选择、写稿在途或预览未同步时禁用）。
function mergeRecordHtml(rec, index) {
  const keepNo = state.orderIds.indexOf(rec.keep_id) + 1;
  const keepCurrent = keepNo > 0 ? `当前第 ${keepNo} 条` : "保留身份已不在草稿";
  const busy =
    state.editingId !== null ||
    state.splittingId !== null ||
    state.writing !== null ||
    !state.previewFresh;
  const undoDisabled = busy ? " disabled" : "";
  const title = busy
    ? "未保存编辑、拆分选择、写稿未结束或预览未同步时不可撤销"
    : "把该次合并撤回到当前草稿：恢复两条原文与各改写来源，其他正文与相对顺序不变";
  const undoLabel = state.writing === "merge-undo" ? "撤销中…" : "撤销该合并";
  const sources = rec.sources.length
    ? `<div class="merge-sources">改写引用来源（${rec.sources.length}）：` +
      `<ul class="merge-source-list">${rec.sources
        .map(
          (s) =>
            `<li><span class="diff-id">${esc(s.id)}</span>：` +
            `<span class="merge-body-before">${esc(internalToDisplay(s.body))}</span>` +
            ` → 合并后 <span class="merge-body-after">${esc(internalToDisplay(s.after_body))}</span></li>`,
        )
        .join("")}</ul></div>`
    : `<div class="merge-sources muted">无其他改写引用来源。</div>`;
  return `
    <li class="merge-row" data-merge-index="${index}">
      <div class="merge-row-head">
        <span class="diff-tag tag-add">保留 ${esc(rec.keep_id)}（${esc(keepCurrent)}）</span>
        <span class="diff-tag tag-del">移除 ${esc(rec.drop_id)}（撤销时插在保留条款之后）</span>
        <button type="button" class="primary" data-action="merge-undo" data-merge-index="${index}"${undoDisabled} title="${title}">${undoLabel}</button>
      </div>
      <div class="merge-origins">
        <div class="diff-col"><span class="diff-col-label">保留条款原文（${esc(rec.keep_id)}）</span>
          <div class="diff-text">${esc(internalToDisplay(rec.keep_body))}</div></div>
        <div class="diff-col"><span class="diff-col-label">被移除条款原文（${esc(rec.drop_id)}）</span>
          <div class="diff-text">${esc(internalToDisplay(rec.drop_body))}</div></div>
      </div>
      ${sources}
    </li>`;
}

// 同步合并记录面板：记录按成功合并先后排列，每条只能撤销一次（成功即移除）。
function syncMergePanel() {
  const records = state.mergeRecords;
  mergeStatus.textContent = records.length
    ? `${records.length} 次成功合并可撤销（仅存本页；换稿或恢复存档清空）`
    : "";
  if (!records.length) {
    mergeBody.innerHTML =
      '<p class="merge-empty">尚无成功合并记录。每次成功合并会在此留下一条可撤销记录（仅存本页，重新导入、恢复存档或刷新后清空）。</p>';
    return;
  }
  mergeBody.innerHTML = `<ul class="merge-list">${records
    .map((rec, i) => mergeRecordHtml(rec, i))
    .join("")}</ul>`;
}

// 撤销一次误合并：经写稿提交协调层走 /api/merge/undo（互斥、携带最新 lock_ids、
// 成功回包按最新锁定集合核验、旧响应隔离与其他写稿完全一致）。
// 成功后：记录立即移除（不可再用），草稿、顺序与身份上界中的正文 / 顺序一起写回，
// 身份上界不回退，复核按 touch() 的既有规则清理（已清除记录不恢复），随后刷新预览；
// 预览失败保留撤销稿、仅重试预览。失败（含 409 冲突、422、断网）保留记录与草稿。
async function submitMergeUndo(record) {
  if (state.writing) return;
  if (state.editingId !== null || state.splittingId !== null || !state.previewFresh) return;
  const ok = confirm(
    `将撤销 ${record.keep_id} 与 ${record.drop_id} 的合并：\n` +
      `恢复两条原文，${record.drop_id} 插在 ${record.keep_id} 之后，` +
      `各改写引用来源恢复合并前正文；其他正文与相对顺序不变，原稿基线不变、身份上界不回退。\n` +
      `合并之后与该次无关的校订保留；若当前正文已偏离合并后状态，整次撤销会被拒绝。\n确定撤销？`,
  );
  if (!ok) return;
  const recordPayload = {
    keep_id: record.keep_id,
    drop_id: record.drop_id,
    keep_body: record.keep_body,
    drop_body: record.drop_body,
    sources: record.sources.map((s) => ({ id: s.id, body: s.body, after_body: s.after_body })),
  };
  await submitWrite({
    kind: "merge-undo",
    path: "/api/merge/undo",
    params: { record: recordPayload },
    // 撤销中锁定核验的改指方向与合并相反：keep→drop（合并后形如 [[keep]]、
    // 撤销恢复为 [[drop]] 的引用按“改指”报告）
    repointed: { [record.keep_id]: record.drop_id },
    onSuccess: () => {
      // 成功后记录不可再用：按对象身份移除该条（其余记录保留；失败则记录保留）
      const idx = state.mergeRecords.indexOf(record);
      if (idx >= 0) state.mergeRecords.splice(idx, 1);
      // 被移除身份重新出现：若正展开查询它的面板，按新草稿自动重查（touch 已触发）
      state.pickIds = state.pickIds.filter((x) => state.orderIds.includes(x));
    },
    onError: (errors) => {
      // 撤销被拒绝（记录已不适用 / 锁定保护 / 超过上限 / 断网）：草稿与记录均保留
      alert("撤销失败，草稿与合并记录均保留：\n" + errors.join("\n"));
    },
  });
}

mergeBody.addEventListener("click", async (ev) => {
  const btn = ev.target.closest('[data-action="merge-undo"]');
  if (!btn) return;
  const index = parseInt(btn.dataset.mergeIndex, 10);
  const record = state.mergeRecords[index];
  if (!record) return;
  await submitMergeUndo(record);
});

// --------------------------------------------------------------------------- //
// 下载（以服务端 /api/export 为准，保证与预览一致）
// --------------------------------------------------------------------------- //
downloadBtn.addEventListener("click", async () => {
  if (downloadBtn.disabled) return; // 预览未追上 / 有失效引用 / 在途时不允许下载
  // 取得本次下载对等待状态的唯一收尾权：等待期间重新导入或又发起一次下载时，
  // 序号会推进，旧下载的响应与收尾一律失效，不能保存旧文件、弹提示或解锁新下载
  const token = ++exportSeq;
  state.exporting = true;
  syncToolbar();
  const epoch = state.epoch;
  const rev = state.rev;
  try {
    const data = await api("/api/export", snapshot());
    if (token !== exportSeq) return; // 已重新导入 / 被新下载取代：旧响应静默丢弃
    if (epoch !== state.epoch) return; // 旧草稿的响应：静默丢弃
    if (rev !== state.rev) {
      // 等待期间草稿又有改动：下载内容已与页面不一致，取消本次下载
      alert("草稿在下载期间又有改动，本次下载已取消，请重新下载。");
      return;
    }
    const blob = new Blob([data.text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
    a.href = url;
    a.download = `clauses-${stamp}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    if (token !== exportSeq || epoch !== state.epoch || rev !== state.rev) return; // 已不属于当前下载：不提示
    alert(errorList(e).join("\n"));
  } finally {
    // 只有仍持有收尾权的下载才能清掉等待状态：旧下载提前返回时不得解锁新下载
    if (token === exportSeq) {
      state.exporting = false;
      syncToolbar(); // 按当前草稿与预览状态恢复（可重试 / 可再次下载）
    }
  }
});
