"""前端「误合并撤销」回归测试的 pytest 封装。

用例本体在 tests/test_merge_undo_ownership.js：用最小 DOM 桩在 Node 虚拟机中加载
真实的 app/static/app.js，驱动合并记录捕获与 /api/merge/undo 撤销的真实内部函数，
覆盖：
- 每次成功合并留存撤销记录（两条原文与所有改写引用来源的前后内部正文）；
  记录仅存本页内存（重新导入 / 恢复存档清空）；撤销成功后记录不可再用（移除），
  409 冲突 / 422 / 断网失败保留记录；
- 撤销经写稿提交协调层：互斥、携带最新 lock_ids、成功回包按最新集合核验、
  正文与顺序一起写回且身份上界不回退、复核按既有规则清理（已清除记录不恢复）；
- 未保存编辑、拆分选择、写稿在途或预览未同步时不可撤销。
这里通过 node --test 运行它；环境没有 Node 时跳过（后端接口测试不受影响）。
"""

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


@pytest.mark.skipif(shutil.which("node") is None, reason="需要 Node 运行前端单测")
def test_merge_undo_ownership_frontend():
    r = subprocess.run(
        ["node", "--test", str(ROOT / "tests" / "test_merge_undo_ownership.js")],
        capture_output=True,
        text=True,
    )
    assert r.returncode == 0, r.stdout + r.stderr
