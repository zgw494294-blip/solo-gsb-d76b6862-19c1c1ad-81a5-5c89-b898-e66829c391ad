"""前端逐条复核回归测试的 pytest 封装。

用例本体在 tests/test_review_ownership.js：用最小 DOM 桩在 Node 虚拟机中加载
真实的 app/static/app.js，驱动「复核 / 重新导入 / 恢复存档 / 下载复核稿」的
真实事件处理器与内部函数，覆盖复核记录的捕获与清除规则（正文或目标存续变化即清除、
纯重排 / 编号平移 / 无关改动保留、改回不恢复、循环只计一次）、记录的内存级生命周期
（重新导入 / 恢复存档清空），以及复核稿下载的请求归属（等待期间改稿或换稿时
旧响应不保存文件、不影响新下载）。
这里通过 node --test 运行它；环境没有 Node 时跳过（后端接口测试不受影响）。
"""

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


@pytest.mark.skipif(shutil.which("node") is None, reason="需要 Node 运行前端单测")
def test_review_ownership_frontend():
    r = subprocess.run(
        ["node", "--test", str(ROOT / "tests" / "test_review_ownership.js")],
        capture_output=True,
        text=True,
    )
    assert r.returncode == 0, r.stdout + r.stderr
