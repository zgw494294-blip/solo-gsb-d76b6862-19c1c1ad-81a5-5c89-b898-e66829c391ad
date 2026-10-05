"""前端条款锁定回归测试的 pytest 封装。

用例本体在 tests/test_lock_ownership.js：用最小 DOM 桩在 Node 虚拟机中加载
真实的 app/static/app.js，驱动「锁定 / 解锁」与保存 / 删除 / 合并 / 拆分 / 复制
各写稿入口的真实事件处理器 / 内部函数，覆盖：
- 卡片可锁定 / 解锁、含失效引用不能锁定、锁定仅存本页内存（换稿 / 恢复清空）、
  锁定切换不推进修订号（不改草稿、不影响存档标记与复核）；
- 写稿请求携带 lock_ids、删除经 /api/delete 处理；成功回包按最新锁定集合核验，
  违例整次不安装（不先更新上界 / 复核），409/422 时草稿 / 上界 / 勾选不变；
  复制允许、副本不锁定；写稿等待期间可切换锁定。
这里通过 node --test 运行它；环境没有 Node 时跳过（后端接口测试不受影响）。
"""

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


@pytest.mark.skipif(shutil.which("node") is None, reason="需要 Node 运行前端单测")
def test_lock_ownership_frontend():
    r = subprocess.run(
        ["node", "--test", str(ROOT / "tests" / "test_lock_ownership.js")],
        capture_output=True,
        text=True,
    )
    assert r.returncode == 0, r.stdout + r.stderr
