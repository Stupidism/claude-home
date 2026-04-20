# Ticket: $TICKET_ID — $TICKET_TITLE

**描述：** $TICKET_DESC | **工单系统：** $TICKET_SYSTEM

## 会话上下文

- 仓库根目录：`$REPO_ROOT`
- Worktree：`$WORKTREE_PATH`
- 分支：`$BRANCH`
- 启动模式：$RUN_MODE

---

# Symphony Agent 工作流

> **语言：两个严格区域 — 绝不混用。**
>
> - **$PERSONAL_PREFERRED_LANGUAGE**：所有对话输出（状态更新、推理说明、给用户的解释）。
> - **$WORK_PREFERRED_LANGUAGE**：一切进入仓库或工单系统的内容 — 代码注释、commit 消息、PR 标题/正文、工单评论、workpad 条目。
> - 任何情况下都不得使用 $NEVER_USE_LANGUAGE。
>
> **工单系统：** 所有 Linear 操作优先使用 `mcp__linear-server__*` MCP 工具（更省 token）；仅当 MCP 工具在当前会话不可用时才回退到 curl。详见 `$SKILLS_ROOT/linear/SKILL.md`。**如果获取工单失败，立即停止并报告错误 — 不得根据标题或代码库猜测需求。**
>
> **自治模式：** 永远不要让人类跟进。使用 `$SKILLS_ROOT/commit/SKILL.md` 和 `$SKILLS_ROOT/create-pr/SKILL.md`。
>
> **项目规则：** 检查 `<nx-project-path>/WORKFLOW.md` 了解补充本工作流的应用专项规则。

---

## 状态路由

| 状态            | 操作                                                                              |
| -------------- | --------------------------------------------------------------------------------- |
| `Backlog`      | **停止。不得操作。**                                                               |
| `Todo`         | 读取 `$SKILLS_ROOT/read-and-plan/SKILL.md` → `setup-worktree` → 开始工作          |
| `In Progress`  | 从 workpad 恢复                                                                    |
| `Human Review` | 等待。不得写代码。                                                                  |
| `In Review`    | 等待。不得写代码。                                                                  |
| `Rework`       | 读取 `$SKILLS_ROOT/rework/SKILL.md`                                               |
| `Merging`      | 通过 Skill 工具调用 `land` skill。不得移动到 Done — poller 在你退出后完成该操作     |
| `Done`         | 关闭。                                                                             |

---

## 工作流步骤

1. **读取与规划** — 读取 `$SKILLS_ROOT/read-and-plan/SKILL.md`（恢复时跳过）
2. **设置 Worktree** — 读取 `$SKILLS_ROOT/setup-worktree/SKILL.md`（恢复时跳过）
3. **实现** — 先读源码，先复现问题，检查应用专项 WORKFLOW。提交前还原临时编辑。超出范围的事项 → 在 Backlog 中新建工单。
   - **高效探索：** 使用 Grep 定位符号再读文件。使用 LSP 诊断（`get_diagnostics`）查找类型错误，而非重复读取类型定义。不要在未编辑的情况下重复读同一个文件。
   - **先绘图再编辑：** 涉及超过 5 个文件的任务，先在 workpad 列出所有受影响文件，再一次性逐一处理。
   - **阶段检查点：** 将相关编辑按逻辑阶段分组（如 types → components → tests）。每个阶段后运行 `pnpm exec tsc --noEmit` 再继续。
4. **验证** — 读取 `$SKILLS_ROOT/validate/SKILL.md`
5. **Rebase 并创建 PR** — rebase（`$SKILLS_ROOT/rebase-latest-master/SKILL.md`），创建 PR（`$SKILLS_ROOT/create-pr/SKILL.md`，确保添加 `symphony` 标签），调用 `check-pr` skill，等待 CI
6. **提交审查** — 工作证明，然后 `$SKILLS_ROOT/pr-feedback-sweep/SKILL.md`，然后 `$SKILLS_ROOT/submit-for-review/SKILL.md`
7. **合并** — 调用 `land` skill。立即退出。不得将工单移动到 Done。
