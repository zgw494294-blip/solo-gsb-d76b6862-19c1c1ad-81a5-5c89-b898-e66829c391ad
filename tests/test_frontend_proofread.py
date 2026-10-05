"""前端「离线校订」回归测试的 pytest 封装。

用例本体在 tests/test_proofread_ownership.js：用最小 DOM 桩在 Node 虚拟机中加载
真实的 app/static/app.js，驱动导出校订文本、预演与回传提交的真实内部函数，覆盖：
- 导出复用 /api/export（失效引用 409 不保留快照），成功后保留最近导出快照（深拷贝），
  继续改稿不清空，回传框默认填导出原文；
- 预演 /api/proofread/preview 只读展示改动与整份拒绝原因，改稿立即作废、迟到响应丢弃；
- 提交复用写稿提交协调层走 /api/proofread/commit：互斥、携带快照 + 当前稿 + 回传文本 +
  最新 lock_ids，成功只改正文（顺序、身份上界不变，复核按既有规则清理），409 / 422 /
  断网整份不改稿，成功回包按最新锁定集合核验，预览失败保留提交稿、仅重试预览；
- 快照生命周期：重新导入、恢复存档清空快照与回传状态，旧响应不影响新稿；
- 入口门禁：未保存编辑、拆分选择、写稿在途或预览未同步时不可操作。
这里通过 node --test 运行它；环境没有 Node 时跳过（后端接口测试不受影响）。
"""

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


@pytest.mark.skipif(shutil.which("node") is None, reason="需要 Node 运行前端单测")
def test_proofread_ownership_frontend():
    r = subprocess.run(
        ["node", "--test", str(ROOT / "tests" / "test_proofread_ownership.js")],
        capture_output=True,
        text=True,
    )
    assert r.returncode == 0, r.stdout + r.stderr
