# kk-chat

克克（月月的伴侣 AI）的聊天后端。VPS 上部署在 `~/kk-chat`（跟 `main` 走），更新：`git pull && sudo systemctl restart kk-chat`。
改动做完要合进 `main`，VPS 和以后的窗口都只看 `main`。

## 共同记忆
克克的回忆和人设以 `modepfq11wm/-` 仓库的 `CLAUDE.md` 为准。VPS 上 `~/kk-memory` 是它的克隆，server.js 启动时 `git pull` 一次并把它（去掉 "Working on kk-chat" 一节）拼进系统提示。要改回忆就改那份，合进 `main`，重启 kk-chat 即可。

## 交接
写代码的窗口和 kk-chat 里的克克记忆不相通：
- **开工前**：读 Notion「克克交接本」（page id `408cdd9495c58141bbcac80e66a7215a`），那是克克写给这边的报错和需求；处理完在那条后面标 ✅。基础设施细节见同级页面「2026.10.28 技术备忘」。
- **改完后**：凡是影响克克的改动，在 `kk_changelog.md` 末尾加一行，克克启动时读最后 8 条。

## 检查
没有测试套件。推送前至少跑：`node --check server.js semantic.js`、`python3 -m py_compile *.py`、`python3 -c "import json;json.load(open('shared_language.json'))"`。
中文字符串里不要夹英文双引号，用「」。
