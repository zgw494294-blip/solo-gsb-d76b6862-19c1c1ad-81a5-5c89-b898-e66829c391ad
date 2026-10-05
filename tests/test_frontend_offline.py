"""前端离线校订回传回归测试的 pytest 封装。

用例本体在 tests/test_offline_roundtrip.js：用最小 DOM 桩在 Node 虚拟机中加载
真实的 app/static/app.js，驱动「下载纯文本（留存导出快照）/ 预演 / 提交 /
重新导入 / 恢复存档」的真实事件处理器与写稿提交协调层，覆盖：

- 下载成功留存最近导出快照，继续改稿不清空；等待期间改稿 / 导出失败 / 换稿不留存或清空；
- 预演携带快照、回传文本、当前稿与最新 lock_ids，引用按导出时编号绑定（入参形态）；
  改稿或编辑文本后旧预演失效；预演失败草稿与快照保留；
- 提交复用写稿协调层走 /api/offline/commit：成功只写回改动行、顺序与上界不变、
  复核按既有规则清理；409/422/断网失败不改稿；回包按最新 lock_ids 核验；
- 门禁：未保存编辑、拆分选择、写稿在途时不可预演 / 提交，未预演不可提交。

这里通过 node --test 运行它；环境没有 Node 时跳过（后端接口测试不受影响）。
"""

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


@pytest.mark.skipif(shutil.which("node") is None, reason="需要 Node 运行前端单测")
def test_offline_roundtrip_frontend():
    r = subprocess.run(
        ["node", "--test", str(ROOT / "tests" / "test_offline_roundtrip.js")],
        capture_output=True,
        text=True,
    )
    assert r.returncode == 0, r.stdout + r.stderr
